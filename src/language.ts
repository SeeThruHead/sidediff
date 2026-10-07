import { fileURLToPath } from 'node:url';

import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema, Stream } from 'effect';

import { LspServer, LspServers, type LaunchSpec, type LspDiagnostic, LspRange, fileUri, specKey } from './lsp.js';
import {
  type CodeLocation,
  type CodePosition,
  type Diagnostic,
  type HoverInfo,
  LanguageUnavailable,
  type Severity,
} from './protocol.js';
import { Repo } from './repo.js';
import { Review } from './review.js';
import { LanguageServerCatalog } from './servers.js';

const MarkedString = Schema.Union([Schema.String, Schema.Struct({ value: Schema.String })]);

const HoverResult = Schema.Struct({
  contents: Schema.Union([MarkedString, Schema.Array(MarkedString)]),
});

const Location = Schema.Struct({ uri: Schema.String, range: LspRange });

const LocationLink = Schema.Struct({ targetUri: Schema.String, targetSelectionRange: LspRange });

const Locations = Schema.Union([
  Schema.Null,
  Location,
  Schema.Array(Schema.Union([Location, LocationLink])),
]);

const asHover = Schema.decodeUnknownOption(HoverResult);
const asLocations = Schema.decodeUnknownOption(Locations);
const isMarkedString = Schema.is(MarkedString);
const isLocation = Schema.is(Location);
const isLocationLink = Schema.is(LocationLink);

type Span = { readonly uri: string; readonly range: typeof LspRange.Type };

const markdownOf = (marked: typeof MarkedString.Type) => (Predicate.isString(marked) ? marked : marked.value);

const markdownParts = (contents: typeof HoverResult.Type.contents) =>
  (isMarkedString(contents) ? [contents] : contents).map(markdownOf);

const spanOf = (entry: typeof Location.Type | typeof LocationLink.Type): Span =>
  isLocationLink(entry) ? { uri: entry.targetUri, range: entry.targetSelectionRange } : entry;

const spansOf = (found: typeof Locations.Type): readonly Span[] => {
  if (found === null) return [];
  if (isLocation(found)) return [found];

  return found.map(spanOf);
};

const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info', 'hint'];

const severityOf = (value: number | undefined) => SEVERITIES[(value ?? 1) - 1] ?? 'info';

const toDiagnostic = (server: string, diagnostic: LspDiagnostic): Diagnostic => ({
  source: diagnostic.source ?? server,
  severity: severityOf(diagnostic.severity),
  message: diagnostic.message,
  ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
  line: diagnostic.range.start.line + 1,
  column: diagnostic.range.start.character + 1,
  endLine: diagnostic.range.end.line + 1,
  endColumn: diagnostic.range.end.character + 1,
});

export class LanguageService extends Context.Service<
  LanguageService,
  {
    readonly hover: (at: CodePosition) => Effect.Effect<HoverInfo | null, LanguageUnavailable>;
    readonly definition: (at: CodePosition) => Effect.Effect<readonly CodeLocation[], LanguageUnavailable>;
    readonly references: (at: CodePosition) => Effect.Effect<readonly CodeLocation[], LanguageUnavailable>;
    readonly diagnostics: (path: string) => Stream.Stream<readonly Diagnostic[]>;
  }
>()('sidediff/LanguageService') {
  static readonly layer = Layer.effect(
    LanguageService,
    Effect.gen(function* () {
      const repo = yield* Repo;
      const review = yield* Review;
      const servers = yield* LspServers;
      const catalog = yield* LanguageServerCatalog;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const unavailable = (relative: string, reason: string) => new LanguageUnavailable({ path: relative, reason });

      const absoluteOf = (relative: string) => path.join(repo.root, relative);

      const isInsideRepo = (absolute: string) => !path.relative(repo.root, absolute).startsWith('..');

      const connect = (spec: LaunchSpec) =>
        Effect.provide(LspServer.use(Effect.succeed), servers.get(specKey(spec))).pipe(
          Effect.tapError((error) => Effect.logWarning(`[lsp] ${spec.id} unavailable`, error)),
          Effect.option,
        );

      const openServers = Effect.fnUntraced(function* (relative: string) {
        const file = absoluteOf(relative);
        if (!isInsideRepo(file)) return yield* unavailable(relative, 'outside the repository');

        const language = catalog.languageOf(file);
        if (Option.isNone(language)) return yield* unavailable(relative, 'no language server for this file type');

        const specs = yield* catalog.serversFor(file);
        if (specs.length === 0) return yield* unavailable(relative, 'no language server found for this file');

        const text = yield* review.source(relative).pipe(Effect.mapError(() => unavailable(relative, 'file not found')));
        const connected = yield* Effect.forEach(specs, connect, { concurrency: 'unbounded' });
        const live = connected.flatMap(Option.toArray);

        yield* Effect.forEach(live, (server) => server.sync(file, language.value, text), {
          concurrency: 'unbounded',
          discard: true,
        });

        return { file, servers: live };
      });

      const positionParams = (file: string, at: CodePosition) => ({
        textDocument: { uri: fileUri(file) },
        position: { line: at.line - 1, character: at.offset - 1 },
      });

      const ask = (server: Context.Service.Shape<typeof LspServer>, method: string, params: unknown) =>
        server.request(method, params).pipe(
          Effect.tapError((error) => Effect.logDebug(`[lsp] ${server.id} ${method} failed`, error)),
          Effect.orElseSucceed(() => null),
        );

      const lineOf = (file: string, line: number) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => (text.split('\n')[line - 1] ?? '').trim()),
          Effect.orElseSucceed(() => ''),
        );

      const toLocation = Effect.fnUntraced(function* (span: Span, isDefinition: boolean) {
        const file = fileURLToPath(span.uri);
        const relative = path.relative(repo.root, file);
        const inRepo = !relative.startsWith('..');
        const preview = yield* lineOf(file, span.range.start.line + 1);

        return {
          path: inRepo ? relative : file,
          inRepo,
          line: span.range.start.line + 1,
          offset: span.range.start.character + 1,
          endLine: span.range.end.line + 1,
          endOffset: span.range.end.character + 1,
          preview,
          isDefinition,
        } satisfies CodeLocation;
      });

      const firstLocations = Effect.fnUntraced(function* (
        at: CodePosition,
        method: string,
        provider: 'definitionProvider' | 'referencesProvider',
        extra: Readonly<Record<string, unknown>>,
      ) {
        const { file, servers: live } = yield* openServers(at.path);
        const capable = live.filter((server) => server.capabilities[provider] !== undefined);

        const answers = yield* Effect.forEach(
          capable,
          (server) => Effect.map(ask(server, method, { ...positionParams(file, at), ...extra }), asLocations),
          { concurrency: 'unbounded' },
        );
        return (
          answers
            .map((answer) => Option.match(answer, { onNone: (): readonly Span[] => [], onSome: spansOf }))
            .find((found) => found.length > 0) ?? []
        );
      });

      const hover = Effect.fn('LanguageService.hover')(function* (at: CodePosition) {
        const { file, servers: live } = yield* openServers(at.path);
        const capable = live.filter((server) => server.capabilities.hoverProvider !== undefined);

        const answers = yield* Effect.forEach(
          capable,
          (server) => Effect.map(ask(server, 'textDocument/hover', positionParams(file, at)), asHover),
          { concurrency: 'unbounded' },
        );
        const markdown = answers
          .flatMap(Option.toArray)
          .map((answer) => markdownParts(answer.contents).join('\n\n'))
          .filter((text) => text.trim() !== '')
          .join('\n\n---\n\n');

        return markdown === '' ? null : { markdown };
      });

      const definition = Effect.fn('LanguageService.definition')(function* (at: CodePosition) {
        const spans = yield* firstLocations(at, 'textDocument/definition', 'definitionProvider', {});
        return yield* Effect.forEach(spans, (span) => toLocation(span, true));
      });

      const references = Effect.fn('LanguageService.references')(function* (at: CodePosition) {
        const spans = yield* firstLocations(at, 'textDocument/references', 'referencesProvider', {
          context: { includeDeclaration: true },
        });
        return yield* Effect.forEach(spans, (span) => toLocation(span, false));
      });

      const diagnostics = (relative: string) =>
        Stream.unwrap(
          openServers(relative).pipe(
            Effect.map(({ file, servers: live }) =>
              Stream.zipLatestAll(
                ...live.map((server) =>
                  Stream.concat(Stream.make([] as readonly LspDiagnostic[]), server.diagnostics(file)).pipe(
                    Stream.map((found) => found.map((diagnostic) => toDiagnostic(server.id, diagnostic))),
                  ),
                ),
              ).pipe(Stream.map((perServer): readonly Diagnostic[] => perServer.flat())),
            ),
            Effect.catch((error) =>
              Effect.as(Effect.logDebug('[lsp] no diagnostics', error), Stream.succeed<readonly Diagnostic[]>([])),
            ),
          ),
        ).pipe(
          Stream.merge(
            review.snapshots.pipe(
              Stream.mapEffect(() => Effect.ignore(openServers(relative))),
              Stream.drain,
            ),
          ),
        );

      return LanguageService.of({ hover, definition, references, diagnostics });
    }),
  );
}
