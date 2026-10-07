import { pathToFileURL } from 'node:url';

import {
  Context,
  Deferred,
  Effect,
  Layer,
  LayerMap,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

export class LspFailed extends Schema.TaggedError<LspFailed>()('LspFailed', {
  server: Schema.String,
  method: Schema.String,
  reason: Schema.String,
}) {}

export const LaunchSpec = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  root: Schema.String,
  initializationOptions: Schema.optionalKey(Schema.Unknown),
  settings: Schema.optionalKey(Schema.Unknown),
});
export type LaunchSpec = typeof LaunchSpec.Type;

const Position = Schema.Struct({ line: Schema.Int, character: Schema.Int });

export const LspRange = Schema.Struct({ start: Position, end: Position });

export const LspDiagnostic = Schema.Struct({
  range: LspRange,
  severity: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  source: Schema.optionalKey(Schema.String),
  message: Schema.String,
});
export type LspDiagnostic = typeof LspDiagnostic.Type;

const Capabilities = Schema.Struct({
  hoverProvider: Schema.optionalKey(Schema.Unknown),
  definitionProvider: Schema.optionalKey(Schema.Unknown),
  referencesProvider: Schema.optionalKey(Schema.Unknown),
  diagnosticProvider: Schema.optionalKey(Schema.Unknown),
});
export type Capabilities = typeof Capabilities.Type;

const InitializeResult = Schema.Struct({ capabilities: Capabilities });

const Id = Schema.Union([Schema.Int, Schema.String]);

const IncomingRequest = Schema.Struct({ id: Id, method: Schema.String, params: Schema.optionalKey(Schema.Unknown) });

const IncomingResponse = Schema.Struct({
  id: Id,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});

const IncomingNotification = Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) });

const PublishDiagnostics = Schema.Struct({ uri: Schema.String, diagnostics: Schema.Array(LspDiagnostic) });

const PulledDiagnostics = Schema.Struct({ items: Schema.optionalKey(Schema.Array(LspDiagnostic)) });

const ConfigurationParams = Schema.Struct({
  items: Schema.Array(Schema.Struct({ section: Schema.optionalKey(Schema.String) })),
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const asRequest = Schema.decodeUnknownOption(IncomingRequest);
const asResponse = Schema.decodeUnknownOption(IncomingResponse);
const asNotification = Schema.decodeUnknownOption(IncomingNotification);
const asPublishDiagnostics = Schema.decodeUnknownOption(PublishDiagnostics);
const asConfiguration = Schema.decodeUnknownOption(ConfigurationParams);
const asPulledDiagnostics = Schema.decodeUnknownOption(PulledDiagnostics);

const HEADER_END = Buffer.from('\r\n\r\n');

const frames = (buffer: Buffer): readonly [Buffer, readonly string[]] => {
  const headerEnd = buffer.indexOf(HEADER_END);
  if (headerEnd === -1) return [buffer, []];

  const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
  const start = headerEnd + HEADER_END.length;
  if (Number.isNaN(length)) return frames(buffer.subarray(start));
  if (buffer.length < start + length) return [buffer, []];

  const [rest, more] = frames(buffer.subarray(start + length));

  return [rest, [buffer.subarray(start, start + length).toString('utf8'), ...more]];
};

const framed = (message: Readonly<Record<string, unknown>>) => {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
};

const REQUEST_TIMEOUT = '2 minutes';

const without = <K, V>(entries: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> =>
  new Map([...entries].filter(([candidate]) => candidate !== key));

const withEntry = <K, V>(entries: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map([...entries, [key, value]]);

const settingFor = (settings: unknown, section: string | undefined) => {
  if (section === undefined) return settings ?? null;
  if (!Predicate.isObject(settings)) return null;

  return settings[section] ?? settings;
};

export const fileUri = (file: string) => pathToFileURL(file).href;

type Document = { readonly version: number; readonly text: string };

export class LspServer extends Context.Service<
  LspServer,
  {
    readonly id: string;
    readonly capabilities: Capabilities;
    readonly request: (method: string, params: unknown) => Effect.Effect<unknown, LspFailed>;
    readonly sync: (file: string, languageId: string, text: string) => Effect.Effect<void>;
    readonly diagnostics: (file: string) => Stream.Stream<readonly LspDiagnostic[]>;
  }
>()('sidediff/LspServer') {
  static readonly layer = (spec: LaunchSpec) =>
    Layer.effect(
      LspServer,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scope = yield* Effect.scope;

        const outbox = yield* Queue.unbounded<string>();
        const pending = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<unknown, LspFailed>>>(new Map());
        const sequence = yield* Ref.make(0);
        const documents = yield* Ref.make<ReadonlyMap<string, Document>>(new Map());
        const published = yield* SubscriptionRef.make<ReadonlyMap<string, readonly LspDiagnostic[]>>(new Map());

        const failed = (method: string, reason: string) => new LspFailed({ server: spec.id, method, reason });

        const handle = yield* spawner
          .spawn(
            ChildProcess.make(spec.command, [...spec.args], {
              cwd: spec.root,
              stdin: { stream: Stream.fromQueue(outbox).pipe(Stream.encodeText) },
              stderr: 'ignore',
            }),
          )
          .pipe(Effect.mapError((error) => failed('spawn', error.message)));

        const send = (message: Readonly<Record<string, unknown>>) => Queue.offer(outbox, framed(message));

        const publish = (uri: string, diagnostics: readonly LspDiagnostic[]) =>
          SubscriptionRef.update(published, (all) => withEntry(all, uri, diagnostics));

        const answer = (request: typeof IncomingRequest.Type) => {
          if (request.method !== 'workspace/configuration') return send({ id: request.id, result: null });

          const items = Option.match(asConfiguration(request.params), { onNone: () => [], onSome: (params) => params.items });

          return send({ id: request.id, result: items.map((item) => settingFor(spec.settings, item.section)) });
        };

        const settle = Effect.fnUntraced(function* (response: typeof IncomingResponse.Type) {
          const key = String(response.id);
          const waiting = yield* Ref.modify(pending, (all) => [all.get(key), without(all, key)]);
          if (waiting === undefined) return;

          yield* response.error === undefined
            ? Deferred.succeed(waiting, response.result ?? null)
            : Deferred.fail(waiting, failed('response', response.error.message));
        });

        const notified = (notification: typeof IncomingNotification.Type) => {
          if (notification.method !== 'textDocument/publishDiagnostics') return Effect.void;

          return Option.match(asPublishDiagnostics(notification.params), {
            onNone: () => Effect.void,
            onSome: (params) => publish(params.uri, params.diagnostics),
          });
        };

        const dispatch = (message: unknown) =>
          Option.match(asRequest(message), {
            onSome: answer,
            onNone: () =>
              Option.match(asResponse(message), {
                onSome: settle,
                onNone: () => Option.match(asNotification(message), { onSome: notified, onNone: () => Effect.void }),
              }),
          });

        const abandonAll = Effect.flatMap(Ref.getAndSet(pending, new Map()), (all) =>
          Effect.forEach([...all.values()], (waiting) => Deferred.fail(waiting, failed('exit', 'language server exited')), {
            discard: true,
          }),
        );

        yield* handle.stdout.pipe(
          Stream.mapAccum(
            (): Buffer => Buffer.alloc(0),
            (buffer, chunk: Uint8Array) => frames(Buffer.concat([buffer, chunk])),
          ),
          Stream.runForEach((body) => Option.match(decodeJson(body), { onNone: () => Effect.void, onSome: dispatch })),
          Effect.ignore,
          Effect.ensuring(abandonAll),
          Effect.forkScoped,
        );

        const request = Effect.fn('LspServer.request')(function* (method: string, params: unknown) {
          const id = yield* Ref.updateAndGet(sequence, (current) => current + 1);
          const reply = yield* Deferred.make<unknown, LspFailed>();

          yield* Ref.update(pending, (all) => withEntry(all, String(id), reply));
          yield* send({ id, method, params });

          return yield* Deferred.await(reply).pipe(
            Effect.timeoutOrElse({
              duration: REQUEST_TIMEOUT,
              orElse: () => Effect.fail(failed(method, 'no answer in time')),
            }),
            Effect.ensuring(Ref.update(pending, (all) => without(all, String(id)))),
          );
        });

        const notify = (method: string, params: unknown) => send({ method, params });

        const rootUri = fileUri(spec.root);
        const initialized = yield* request('initialize', {
          processId: process.pid,
          clientInfo: { name: 'sidediff' },
          rootUri,
          rootPath: spec.root,
          workspaceFolders: [{ uri: rootUri, name: spec.root }],
          initializationOptions: spec.initializationOptions ?? null,
          capabilities: {
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: true },
              references: {},
              publishDiagnostics: { relatedInformation: false },
              diagnostic: { dynamicRegistration: false },
            },
          },
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(InitializeResult)),
          Effect.mapError((error) => failed('initialize', error.message)),
        );

        yield* notify('initialized', {});
        yield* notify('workspace/didChangeConfiguration', { settings: spec.settings ?? null });

        const pull = (uri: string) =>
          request('textDocument/diagnostic', { textDocument: { uri } }).pipe(
            Effect.map(asPulledDiagnostics),
            Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (report) => publish(uri, report.items ?? []) })),
            Effect.catch((error) => Effect.logDebug('[lsp] pull diagnostics failed', error)),
          );

        const sync = Effect.fn('LspServer.sync')(function* (file: string, languageId: string, text: string) {
          const uri = fileUri(file);
          const current = (yield* Ref.get(documents)).get(uri);
          if (current?.text === text) return;

          const version = (current?.version ?? 0) + 1;
          yield* Ref.update(documents, (all) => withEntry(all, uri, { version, text }));

          yield* current === undefined
            ? notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
            : notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });

          if (initialized.capabilities.diagnosticProvider !== undefined) yield* Effect.forkIn(pull(uri), scope);
        });

        const diagnostics = (file: string) => {
          const uri = fileUri(file);

          return Stream.concat(Stream.fromEffect(SubscriptionRef.get(published)), SubscriptionRef.changes(published)).pipe(
            Stream.map((all) => all.get(uri)),
            Stream.filter((found) => found !== undefined),
            Stream.changes,
          );
        };

        return LspServer.of({ id: spec.id, capabilities: initialized.capabilities, request, sync, diagnostics });
      }),
    );
}

const decodeSpec = Schema.decodeUnknownSync(Schema.fromJsonString(LaunchSpec));

export class LspServers extends LayerMap.Service<LspServers>()('sidediff/LspServers', {
  lookup: (key: string) => LspServer.layer(decodeSpec(key)),
  idleTimeToLive: '15 minutes',
}) {}

export const specKey = (spec: LaunchSpec) => JSON.stringify(Schema.encodeSync(LaunchSpec)(spec));
