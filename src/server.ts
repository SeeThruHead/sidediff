import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { fileURLToPath } from 'node:url';

import { NodeHttpServer } from '@effect/platform-node';
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';

import { Git } from './git.js';
import { Notes } from './notes.js';
import { type Command, FileMissing, SidediffRpcs, type Snapshot, type Utterance, type View } from './protocol.js';
import { Repo } from './repo.js';

export class ServeOptions extends Context.Service<
  ServeOptions,
  {
    readonly range: readonly string[];
    readonly port: number;
    readonly host: string;
    readonly watch: boolean;
  }
>()('sidediff/ServeOptions') {}

export const ServerInfo = Schema.Struct({ port: Schema.Int, host: Schema.String, pid: Schema.Int });

const ignoredSegments = new Set(['node_modules', 'dist', '.next', '.turbo', '.cache', 'coverage']);

const isRelevant = (file: string) => {
  const parts = file.split('/');
  if (parts.some((part) => ignoredSegments.has(part))) return false;
  if (parts[0] !== '.git') return true;

  return file.includes('HEAD') || file.includes('refs') || file.endsWith('index');
};

const versionOf = (patch: string, notes: unknown) =>
  createHash('sha1').update(patch).update(JSON.stringify(notes)).digest('hex').slice(0, 12);

export class Review extends Context.Service<
  Review,
  {
    readonly snapshots: Stream.Stream<Snapshot>;
    readonly file: (side: 'old' | 'new', path: string) => Effect.Effect<string, FileMissing>;
    readonly send: (command: Command) => Effect.Effect<number>;
    readonly commands: Stream.Stream<Command>;
    readonly reportView: (view: View) => Effect.Effect<void>;
    readonly view: Effect.Effect<View | null>;
    readonly utter: (text: string, handled: boolean) => Effect.Effect<Utterance>;
    readonly listen: (after: number | undefined) => Stream.Stream<readonly Utterance[]>;
  }
>()('sidediff/Review') {
  static readonly layer = Layer.effect(
    Review,
    Effect.gen(function* () {
      const git = yield* Git;
      const notes = yield* Notes;
      const repo = yield* Repo;
      const options = yield* ServeOptions;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const build = Effect.gen(function* () {
        const [patch, current, branch, now] = yield* Effect.all(
          [git.diff(repo.root, options.range), notes.list, git.branch(repo.root), DateTime.now],
          { concurrency: 'unbounded' },
        );

        return {
          repo: repo.root,
          branch,
          range: options.range,
          patch,
          notes: current,
          version: versionOf(patch, current),
          watching: options.watch,
          updatedAt: DateTime.formatIso(now),
        } satisfies Snapshot;
      });

      const snapshot = yield* SubscriptionRef.make(yield* build);

      const refresh = build.pipe(
        Effect.flatMap((next) =>
          SubscriptionRef.update(snapshot, (current) => (current.version === next.version ? current : next)),
        ),
        Effect.catch((error) => Effect.logWarning('[refresh] diff failed', error)),
      );

      yield* fs.makeDirectory(repo.notes, { recursive: true });

      const changes = Stream.merge(
        fs.watch(repo.notes),
        options.watch
          ? fs.watch(repo.root, { recursive: true }).pipe(Stream.filter((event) => isRelevant(event.path)))
          : Stream.empty,
      );

      yield* changes.pipe(
        Stream.debounce(Duration.millis(250)),
        Stream.runForEach(() => refresh),
        Effect.catch((error) => Effect.logWarning('[watch] stopped', error)),
        Effect.forkScoped,
      );

      const commands = yield* PubSub.unbounded<Command>();
      const watchers = yield* Ref.make(0);
      const views = yield* Ref.make<View | null>(null);
      const heard = yield* Ref.make<readonly Utterance[]>([]);
      const spoken = yield* PubSub.unbounded<Utterance>();

      const file = (side: 'old' | 'new', relative: string) =>
        Effect.gen(function* () {
          const missing = new FileMissing({ side, path: relative });
          const inside = path.join(repo.root, relative);
          if (path.relative(repo.root, inside).startsWith('..')) return yield* missing;

          const sides = yield* git.sides(repo.root, options.range).pipe(Effect.mapError(() => missing));

          return side === 'new' && sides.new === null
            ? yield* fs.readFileString(inside).pipe(Effect.mapError(() => missing))
            : yield* git
                .show(repo.root, side === 'new' ? (sides.new ?? 'HEAD') : sides.old, relative)
                .pipe(Effect.mapError(() => missing));
        });

      const utter = (text: string, handled: boolean) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;

          const utterance = yield* Ref.modify(heard, (all) => {
            const next = { id: all.length + 1, text: text.trim(), at: DateTime.formatIso(now), handled };
            return [next, [...all, next]];
          });

          if (!handled) yield* PubSub.publish(spoken, utterance);

          return utterance;
        });

      const listen = (after: number | undefined) =>
        Stream.unwrap(
          Effect.map(Ref.get(heard), (all) => {
            const since = after ?? all.length;
            const pending = all.filter((utterance) => utterance.id > since && !utterance.handled);
            const live = Stream.fromPubSub(spoken).pipe(
              Stream.filter((utterance) => utterance.id > since),
              Stream.map((utterance) => [utterance]),
            );

            return pending.length > 0 ? Stream.concat(Stream.make(pending), live) : live;
          }),
        );

      return {
        snapshots: SubscriptionRef.changes(snapshot),
        file,
        send: (command) => Effect.andThen(PubSub.publish(commands, command), Ref.get(watchers)),

        commands: Stream.unwrap(
          Effect.as(
            Ref.update(watchers, (count) => count + 1),
            Stream.fromPubSub(commands).pipe(Stream.ensuring(Ref.update(watchers, (count) => count - 1))),
          ),
        ),

        reportView: (view) => Ref.set(views, view),
        view: Ref.get(views),
        utter,
        listen,
      };
    }),
  );
}

const RpcHandlers = SidediffRpcs.toLayer(
  Effect.gen(function* () {
    const review = yield* Review;

    return SidediffRpcs.of({
      Snapshots: () => review.snapshots,
      File: ({ side, path }) => review.file(side, path),
      Send: ({ command }) => Effect.map(review.send(command), (delivered) => ({ delivered })),
      Commands: () => review.commands,
      ReportView: ({ view }) => review.reportView(view),
      View: () => review.view,
      Utter: ({ text, handled }) => review.utter(text, handled),
      Listen: ({ after }) => review.listen(after),
    });
  }),
);

const webRoot = fileURLToPath(new URL('./web', import.meta.url));

const StaticFiles = HttpRouter.add('GET', '/*', (request) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const asset = path.join(webRoot, pathname === '/' ? 'index.html' : pathname.slice(1));

    if (path.relative(webRoot, asset).startsWith('..')) return HttpServerResponse.empty({ status: 404 });

    return yield* HttpServerResponse.file(asset, { headers: { 'cache-control': 'no-store' } }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
    );
  }),
);

const RpcRoute = RpcServer.layerHttp({ group: SidediffRpcs, path: '/rpc', protocol: 'websocket' }).pipe(
  Layer.provide(RpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);

const portFree = (port: number, host: string) =>
  Effect.callback<boolean>((resume) => {
    const probe = createProbe();
    probe.once('error', () => resume(Effect.succeed(false)));
    probe.listen(port, host, () => probe.close(() => resume(Effect.succeed(true))));
  });

export const freePort = (start: number, host: string): Effect.Effect<number> =>
  Effect.flatMap(portFree(start, host), (free) => (free ? Effect.succeed(start) : freePort(start + 1, host)));

const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* Repo;
    const options = yield* ServeOptions;

    const info = { port: options.port, host: options.host, pid: process.pid };

    yield* Effect.acquireRelease(
      fs.writeFileString(repo.serverFile, JSON.stringify(Schema.encodeSync(ServerInfo)(info))),
      () =>
        fs.readFileString(repo.serverFile).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerInfo))),
          Effect.flatMap((current) =>
            current.pid === info.pid ? fs.remove(repo.serverFile, { force: true }) : Effect.void,
          ),
          Effect.ignore,
        ),
    );
  }),
);

export const serverLayer = (options: Context.Service.Shape<typeof ServeOptions>) =>
  HttpRouter.serve(Layer.mergeAll(RpcRoute, StaticFiles), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(Review.layer),
    Layer.merge(Announce),
    Layer.provide(NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
        gracefulShutdownTimeout: Duration.millis(300),
      })),
    Layer.provide(Layer.succeed(ServeOptions, options)),
  );
