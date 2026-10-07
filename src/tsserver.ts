import { fileURLToPath } from 'node:url';

import { Context, Deferred, Effect, Layer, LayerMap, Option, Path, Queue, Ref, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

export class TsServerFailed extends Schema.TaggedError<TsServerFailed>()('TsServerFailed', {
  command: Schema.String,
  reason: Schema.String,
}) {}

const Response = Schema.Struct({
  type: Schema.Literal('response'),
  request_seq: Schema.Int,
  command: Schema.String,
  success: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.Unknown),
});
type Response = typeof Response.Type;

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(Response));

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const REQUEST_TIMEOUT = '2 minutes';

const UNTRUNCATED_HOVER_LENGTH = 1_000_000;

const without = <K, V>(entries: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> =>
  new Map([...entries].filter(([candidate]) => candidate !== key));

const failureOf = (response: Response) =>
  new TsServerFailed({ command: response.command, reason: response.message ?? 'request failed' });

export class TsServer extends Context.Service<
  TsServer,
  {
    readonly request: (command: string, args: unknown) => Effect.Effect<unknown, TsServerFailed>;
    readonly sync: (file: string, content: string, projectRoot: string) => Effect.Effect<void, TsServerFailed>;
  }
>()('sidediff/TsServer') {
  static readonly layer = (tsserverPath: string) =>
    Layer.effect(
      TsServer,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;

        const outbox = yield* Queue.unbounded<string>();
        const pending = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<unknown, TsServerFailed>>>(new Map());
        const sequence = yield* Ref.make(0);
        const synced = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

        const handle = yield* spawner
          .spawn(
            ChildProcess.make(
              process.execPath,
              [
                '--max-old-space-size=8192',
                tsserverPath,
                '--disableAutomaticTypingAcquisition',
                '--globalPlugins',
                '@effect/language-service',
                '--pluginProbeLocations',
                packageRoot,
              ],
              {
                cwd: path.resolve(path.dirname(tsserverPath), '..', '..', '..'),
                stdin: { stream: Stream.fromQueue(outbox).pipe(Stream.encodeText) },
                stderr: 'ignore',
              },
            ),
          )
          .pipe(Effect.orDie);

        const settle = Effect.fnUntraced(function* (response: Response) {
          const waiting = yield* Ref.modify(pending, (all) => [all.get(response.request_seq), without(all, response.request_seq)]);
          if (waiting === undefined) return;

          yield* response.success
            ? Deferred.succeed(waiting, response.body ?? null)
            : Deferred.fail(waiting, failureOf(response));
        });

        const abandonAll = Effect.flatMap(Ref.getAndSet(pending, new Map()), (all) =>
          Effect.forEach(
            [...all.values()],
            (waiting) => Deferred.fail(waiting, new TsServerFailed({ command: 'tsserver', reason: 'tsserver exited' })),
            { discard: true },
          ),
        );

        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.startsWith('{')),
          Stream.runForEach((line) => Option.match(decodeResponse(line), { onNone: () => Effect.void, onSome: settle })),
          Effect.ignore,
          Effect.ensuring(abandonAll),
          Effect.forkScoped,
        );

        const request = Effect.fn('TsServer.request')(function* (command: string, args: unknown) {
          const seq = yield* Ref.updateAndGet(sequence, (current) => current + 1);
          const reply = yield* Deferred.make<unknown, TsServerFailed>();

          yield* Ref.update(pending, (all) => new Map([...all, [seq, reply]]));
          yield* Queue.offer(outbox, `${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`);

          return yield* Deferred.await(reply).pipe(
            Effect.timeoutOrElse({
              duration: REQUEST_TIMEOUT,
              orElse: () => Effect.fail(new TsServerFailed({ command, reason: 'tsserver did not answer in time' })),
            }),
            Effect.ensuring(Ref.update(pending, (all) => without(all, seq))),
          );
        });

        const sync = Effect.fn('TsServer.sync')(function* (file: string, content: string, projectRoot: string) {
          const known = yield* Ref.get(synced);
          if (known.get(file) === content) return;

          yield* request('updateOpen', {
            openFiles: [{ file, fileContent: content, projectRootPath: projectRoot }],
          });
          yield* Ref.update(synced, (all) => new Map([...all, [file, content]]));
        });

        yield* request('configure', { preferences: { maximumHoverLength: UNTRUNCATED_HOVER_LENGTH } }).pipe(
          Effect.catch((error) => Effect.logWarning('[tsserver] configure failed', error)),
        );

        return TsServer.of({ request, sync });
      }),
    );
}

export class TsServers extends LayerMap.Service<TsServers>()('sidediff/TsServers', {
  lookup: (tsserverPath: string) => TsServer.layer(tsserverPath),
  idleTimeToLive: '15 minutes',
}) {}
