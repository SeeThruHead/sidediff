import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { fileURLToPath } from 'node:url';

import { NodeHttpServer } from '@effect/platform-node';
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';

import { ASSET_ROUTE } from './assets.js';
import { Explainer } from './explainer.js';
import { LanguageService } from './language.js';
import { Notes } from './notes.js';
import { NoteUnsaved, SidediffRpcs } from './protocol.js';
import { Repo } from './repo.js';
import { Review, ServeOptions } from './review.js';
import { LspServers } from './lsp.js';
import { LanguageServerCatalog } from './servers.js';

export const ServerInfo = Schema.Struct({ port: Schema.Int, host: Schema.String, pid: Schema.Int });

const unsavedError = (error: { readonly message: string }) => new NoteUnsaved({ reason: error.message });

const RpcHandlers = SidediffRpcs.toLayer(
  Effect.gen(function* () {
    const review = yield* Review;
    const notes = yield* Notes;
    const language = yield* LanguageService;
    const explainer = yield* Explainer;

    return SidediffRpcs.of({
      Hover: (at) => language.hover(at),
      Definition: (at) => language.definition(at),
      References: (at) => language.references(at),
      Source: ({ path }) => review.source(path),
      Diagnostics: ({ path }) => language.diagnostics(path),
      Snapshots: () => review.snapshots,
      File: ({ side, path }) => review.file(side, path),
      Send: ({ command }) => Effect.map(review.send(command), (delivered) => ({ delivered })),
      Commands: () => review.commands,
      ReportView: ({ view }) => review.reportView(view),
      View: () => review.view,
      Utter: ({ text, handled }) => review.utter(text, handled),
      Listen: ({ after }) => review.listen(after),
      StartThread: (input) => review.startThread(input),
      Reply: ({ noteId, body, author }) => review.reply(noteId, body, author),
      Resolve: ({ noteId, resolved, author }) => review.resolve(noteId, resolved, author),
      ToComment: ({ noteId }) => review.toComment(noteId),
      Threads: ({ after }) => review.threads(after),
      Refresh: () => review.refresh,
      SetWorking: ({ noteId, status, done }) => review.setWorking(noteId, status, done),
      SetExplainer: ({ path }) => explainer.set(path),
      ListNotes: () => notes.list,
      AddNotes: ({ notes: inputs }) => notes.add(inputs).pipe(Effect.mapError(unsavedError)),
      RemoveNote: ({ id }) => notes.remove(id).pipe(Effect.mapError(unsavedError)),
      ClearNotes: ({ filePath }) => notes.clear(filePath).pipe(Effect.mapError(unsavedError)),
    });
  }),
);

const webRoot = fileURLToPath(new URL('./web', import.meta.url));

const fileWithin = (root: string, relative: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const file = path.join(root, relative);

    if (path.relative(root, file).startsWith('..')) return HttpServerResponse.empty({ status: 404 });

    return yield* HttpServerResponse.file(file, { headers: { 'cache-control': 'no-store' } }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
    );
  });

const pathnameOf = (request: { readonly url: string }) => new URL(request.url, 'http://localhost').pathname;

const StaticFiles = HttpRouter.add('GET', '/*', (request) => {
  const pathname = pathnameOf(request);

  return fileWithin(webRoot, pathname === '/' ? 'index.html' : pathname.slice(1));
});

const AssetFiles = HttpRouter.add('GET', `${ASSET_ROUTE}/*`, (request) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    return yield* fileWithin(repo.assets, pathnameOf(request).slice(ASSET_ROUTE.length + 1));
  }),
);

const ExplainerPage = HttpRouter.add('GET', '/explainer', () =>
  Effect.gen(function* () {
    const explainer = yield* Explainer;
    const file = yield* explainer.path;

    return yield* Option.match(file, {
      onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      onSome: (asset) =>
        HttpServerResponse.file(asset, { headers: { 'cache-control': 'no-store' } }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
        ),
    });
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
      fs.makeDirectory(repo.state, { recursive: true }).pipe(
        Effect.andThen(
          fs.writeFileString(repo.serverFile, JSON.stringify(Schema.encodeSync(ServerInfo)(info))),
        ),
      ),
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
  HttpRouter.serve(Layer.mergeAll(RpcRoute, ExplainerPage, AssetFiles, StaticFiles), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(LanguageService.layer),
    Layer.provide(Layer.mergeAll(LspServers.layer, LanguageServerCatalog.layer)),
    Layer.provide(Review.layer),
    Layer.provide(Explainer.layer),
    Layer.merge(Announce),
    Layer.provide(NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
        gracefulShutdownTimeout: Duration.millis(300),
      })),
    Layer.provide(Layer.succeed(ServeOptions, options)),
  );
