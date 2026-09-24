import { BrowserSocket } from '@effect/platform-browser';
import { Duration, Effect, Layer, Schedule, Stream } from 'effect';
import { Atom, AtomRegistry, AtomRpc } from 'effect/unstable/reactivity';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';

import { type Command, type Side, SidediffRpcs, type Snapshot, type View } from '../src/protocol';

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

const currentVersion = () => {
  const snapshot = registry.get(snapshotAtom);
  return snapshot._tag === 'Success' ? (snapshot.value?.version ?? '') : '';
};

export const readFile = (side: 'old' | 'new', path: string): Promise<string> =>
  Effect.runPromise(AtomRegistry.getResult(registry, fileAtom(fileKey(currentVersion(), side, path))));

export const readFileSide = (path: string, side: Side): Promise<string | null> =>
  readFile(side === 'deletions' ? 'old' : 'new', path).catch(() => null);

export const interimAtom = Atom.make('');

const reportViewAtom = SidediffClient.mutation('ReportView');
const utterAtom = SidediffClient.mutation('Utter');

export const reportView = (view: View) =>
  registry.set(reportViewAtom, { payload: { view } });

export const sendUtterance = (text: string, handled: boolean) =>
  text.trim().length === 0 ? undefined : registry.set(utterAtom, { payload: { text: text.trim(), handled } });
