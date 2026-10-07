import { BrowserSocket } from '@effect/platform-browser';
import { Duration, Effect, Layer, Predicate, Schedule, Stream } from 'effect';
import { Atom, AtomRegistry, AtomRpc, type AsyncResult } from 'effect/reactivity';
import { RpcClient, RpcSerialization } from 'effect/rpc';

import {
  type CodeLocation,
  type CodePosition,
  type Command,
  type HoverInfo,
  type Side,
  SidediffRpcs,
  type Snapshot,
  type View,
} from '../src/protocol';

const socketUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/rpc`;

export const registry = AtomRegistry.make();

export const connectedAtom = Atom.make(false).pipe(Atom.keepAlive);

const ConnectionStatus = Layer.succeed(RpcClient.ConnectionHooks, {
  onConnect: Effect.sync(() => registry.set(connectedAtom, true)),
  onDisconnect: Effect.sync(() => registry.set(connectedAtom, false)),
});

export class SidediffClient extends AtomRpc.Service<SidediffClient>()('SidediffClient', {
  group: SidediffRpcs,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide([BrowserSocket.layerWebSocket(socketUrl), RpcSerialization.layerNdjson, ConnectionStatus]),
  ),
}) {}

type Live<A> = { readonly kind: 'value'; readonly value: A } | { readonly kind: 'lost' };

const resilient = <A, E>(open: Stream.Stream<A, E, SidediffClient>) =>
  open.pipe(
    Stream.map((value): Live<A> => ({ kind: 'value', value })),
    Stream.catchCause(() => Stream.succeed<Live<A>>({ kind: 'lost' })),
    Stream.repeat(Schedule.spaced(Duration.seconds(1))),
  );

export const snapshotAtom = SidediffClient.runtime
  .atom(
    resilient(Stream.unwrap(SidediffClient.use((client) => Effect.succeed(client('Snapshots', undefined))))).pipe(
      Stream.scan(
        (): Snapshot | null => null,
        (latest, event) => (event.kind === 'value' ? event.value : latest),
      ),
    ),
  )
  .pipe(Atom.keepAlive);

export interface Delivered {
  readonly command: Command;
  readonly sequence: number;
}

export const commandAtom = SidediffClient.runtime.atom(
  resilient(Stream.unwrap(SidediffClient.use((client) => Effect.succeed(client('Commands', undefined))))).pipe(
    Stream.filter((event) => event.kind === 'value'),
    Stream.map((event) => event.value),
    Stream.zipWithIndex,
    Stream.map(([command, sequence]): Delivered => ({ command, sequence })),
  ),
);

const fileKey = (version: string, side: 'old' | 'new', path: string) => JSON.stringify([version, side, path]);

const fileAtom = Atom.family((key: string) => {
  const [, side, path] = JSON.parse(key) as [string, 'old' | 'new', string];

  return SidediffClient.runtime
    .atom(SidediffClient.use((client) => client('File', { side, path })))
    .pipe(Atom.setIdleTTL(Duration.minutes(10)));
});

const currentDiffVersion = () => {
  const snapshot = registry.get(snapshotAtom);
  return snapshot._tag === 'Success' ? (snapshot.value?.diffVersion ?? '') : '';
};

const isMissingFile = (error: unknown) => Predicate.isTagged(error, 'FileMissing');

export const readFile = (side: 'old' | 'new', path: string): Promise<string> => {
  const atom = fileAtom(fileKey(currentDiffVersion(), side, path));

  return Effect.runPromise(
    AtomRegistry.getResult(registry, atom).pipe(
      Effect.tapError(() => Effect.sync(() => registry.refresh(atom))),
      Effect.retry({
        schedule: Schedule.exponential(Duration.millis(250)),
        times: 6,
        while: (error) => !isMissingFile(error),
      }),
    ),
  );
};

const positionOf = (key: string): CodePosition => {
  const [, path, line, offset] = JSON.parse(key) as [string, string, number, number];
  return { path, line, offset };
};

const positionKey = (at: CodePosition) => JSON.stringify([currentDiffVersion(), at.path, at.line, at.offset]);

const LANGUAGE_TTL = Duration.minutes(2);

const hoverAtom = Atom.family((key: string) =>
  SidediffClient.runtime
    .atom(SidediffClient.use((client) => client('Hover', positionOf(key))))
    .pipe(Atom.setIdleTTL(LANGUAGE_TTL)),
);

const definitionAtom = Atom.family((key: string) =>
  SidediffClient.runtime
    .atom(SidediffClient.use((client) => client('Definition', positionOf(key))))
    .pipe(Atom.setIdleTTL(LANGUAGE_TTL)),
);

const referencesAtom = Atom.family((key: string) =>
  SidediffClient.runtime
    .atom(SidediffClient.use((client) => client('References', positionOf(key))))
    .pipe(Atom.setIdleTTL(LANGUAGE_TTL)),
);

const sourceAtom = Atom.family((key: string) => {
  const [, path] = JSON.parse(key) as [string, string];

  return SidediffClient.runtime
    .atom(SidediffClient.use((client) => client('Source', { path })))
    .pipe(Atom.setIdleTTL(Duration.minutes(10)));
});

const ask = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Effect.runPromise(AtomRegistry.getResult(registry, atom));

export const hoverAt = (at: CodePosition): Promise<HoverInfo | null> => ask(hoverAtom(positionKey(at)));

export const definitionAt = (at: CodePosition): Promise<readonly CodeLocation[]> =>
  ask(definitionAtom(positionKey(at)));

export const referencesAt = (at: CodePosition): Promise<readonly CodeLocation[]> =>
  ask(referencesAtom(positionKey(at)));

export const readSource = (path: string): Promise<string> =>
  ask(sourceAtom(JSON.stringify([currentDiffVersion(), path])));

export const isInDiff = (path: string) => {
  const snapshot = registry.get(snapshotAtom);
  if (snapshot._tag !== 'Success') return false;

  return snapshot.value?.patch.includes(`\n+++ b/${path}\n`) ?? false;
};

const sendAtom = Atom.keepAlive(SidediffClient.mutation('Send'));

export const showInDiff = (path: string, line: number) =>
  registry.set(sendAtom, { payload: { command: { type: 'show', file: path, start: line, side: 'additions' } } });

export const readFileSide = (path: string, side: Side): Promise<string | null> =>
  readFile(side === 'deletions' ? 'old' : 'new', path).catch(() => null);

export const interimAtom = Atom.make('');

const reportViewAtom = Atom.keepAlive(SidediffClient.mutation('ReportView'));
const utterAtom = Atom.keepAlive(SidediffClient.mutation('Utter'));
const startThreadAtom = Atom.keepAlive(SidediffClient.mutation('StartThread'));
const replyAtom = Atom.keepAlive(SidediffClient.mutation('Reply'));
const resolveAtom = Atom.keepAlive(SidediffClient.mutation('Resolve'));
const toCommentAtom = Atom.keepAlive(SidediffClient.mutation('ToComment'));

export const startThread = (input: { filePath: string; side: Side; line: number; body: string }) =>
  registry.set(startThreadAtom, { payload: input });

export const replyToThread = (noteId: string, body: string) => registry.set(replyAtom, { payload: { noteId, body } });

export const resolveThread = (noteId: string, resolved: boolean) =>
  registry.set(resolveAtom, { payload: { noteId, resolved } });

export const reportView = (view: View) =>
  registry.set(reportViewAtom, { payload: { view } });

export const sendUtterance = (text: string, handled: boolean) =>
  text.trim().length === 0 ? undefined : registry.set(utterAtom, { payload: { text: text.trim(), handled } });

export const toComment = (noteId: string) => registry.set(toCommentAtom, { payload: { noteId } });
