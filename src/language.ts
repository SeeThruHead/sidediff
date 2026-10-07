import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from 'effect';

import { type CodeLocation, type CodePosition, type HoverInfo, LanguageUnavailable } from './protocol.js';
import { Repo } from './repo.js';
import { Review } from './review.js';
import { TsServer, type TsServerFailed, TsServers } from './tsserver.js';

const Location = Schema.Struct({ line: Schema.Int, offset: Schema.Int });

const Span = Schema.Struct({ file: Schema.String, start: Location, end: Location });
type Span = typeof Span.Type;

const DisplayText = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.String }))]);
type DisplayText = typeof DisplayText.Type;

const QuickInfo = Schema.Struct({
  displayString: Schema.String,
  documentation: DisplayText,
  tags: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, text: Schema.optionalKey(DisplayText) }))),
});

const Definitions = Schema.Array(Span);

const References = Schema.Struct({
  refs: Schema.Array(
    Schema.Struct({
      ...Span.fields,
      lineText: Schema.optionalKey(Schema.String),
      isDefinition: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const NO_CONTENT = 'No content available.';

const plainText = (text: DisplayText | undefined) =>
  Predicate.isString(text) ? text : (text ?? []).map((part) => part.text).join('');

const isNoContent = (error: TsServerFailed) => error.reason === NO_CONTENT;

export class LanguageService extends Context.Service<
  LanguageService,
  {
    readonly hover: (at: CodePosition) => Effect.Effect<HoverInfo | null, LanguageUnavailable>;
    readonly definition: (at: CodePosition) => Effect.Effect<readonly CodeLocation[], LanguageUnavailable>;
    readonly references: (at: CodePosition) => Effect.Effect<readonly CodeLocation[], LanguageUnavailable>;
  }
>()('sidediff/LanguageService') {
  static readonly layer = Layer.effect(
    LanguageService,
    Effect.gen(function* () {
      const repo = yield* Repo;
      const review = yield* Review;
      const servers = yield* TsServers;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const unavailable = (at: { readonly path: string }) => (error: { readonly reason: string }) =>
        new LanguageUnavailable({ path: at.path, reason: error.reason });

      const isInsideRepo = (absolute: string) => !path.relative(repo.root, absolute).startsWith('..');

      const ancestors = (directory: string): readonly string[] => {
        if (!isInsideRepo(directory)) return [];
        if (directory === repo.root) return [directory];

        return [directory, ...ancestors(path.dirname(directory))];
      };

      const tsserverFor = Effect.fnUntraced(function* (absolute: string) {
        const candidates = ancestors(path.dirname(absolute)).map((directory) =>
          path.join(directory, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
        );

        return yield* Effect.findFirst(candidates, (candidate) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)));
      });

      const withServer = Effect.fnUntraced(function* <A>(
        at: CodePosition,
        use: (server: TsServer['Service'], file: string) => Effect.Effect<A, TsServerFailed>,
      ): Effect.fn.Return<A, LanguageUnavailable> {
        const file = path.join(repo.root, at.path);
        if (!isInsideRepo(file)) return yield* new LanguageUnavailable({ path: at.path, reason: 'outside the repository' });

        const tsserver = yield* tsserverFor(file);
        if (Option.isNone(tsserver))
          return yield* new LanguageUnavailable({ path: at.path, reason: 'no TypeScript language server for this file' });

        const content = yield* review
          .source(at.path)
          .pipe(Effect.mapError(() => new LanguageUnavailable({ path: at.path, reason: 'file not found' })));

        return yield* Effect.gen(function* () {
          const server = yield* TsServer;

          yield* server.sync(file, content, repo.root);

          return yield* use(server, file);
        }).pipe(Effect.provide(servers.get(tsserver.value)), Effect.mapError(unavailable(at)));
      });

      const decode = <S extends Schema.Top>(schema: S, at: CodePosition) => (body: unknown) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => new LanguageUnavailable({ path: at.path, reason: 'unexpected tsserver reply' })),
        );

      const lineOf = (file: string, line: number) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => (text.split('\n')[line - 1] ?? '').trim()),
          Effect.orElseSucceed(() => ''),
        );

      const toLocation = (span: Span, preview: string, isDefinition: boolean): CodeLocation => {
        const relative = path.relative(repo.root, span.file);
        const inRepo = !relative.startsWith('..');

        return {
          path: inRepo ? relative : span.file,
          inRepo,
          line: span.start.line,
          offset: span.start.offset,
          endLine: span.end.line,
          endOffset: span.end.offset,
          preview,
          isDefinition,
        };
      };

      const hover = Effect.fn('LanguageService.hover')(function* (at: CodePosition) {
        const body = yield* withServer(at, (server, file) =>
          server.request('quickinfo', { file, line: at.line, offset: at.offset }).pipe(
            Effect.map(Option.some),
            Effect.catchIf(isNoContent, () => Effect.succeedNone),
          ),
        );
        if (Option.isNone(body)) return null;

        const info = yield* decode(QuickInfo, at)(body.value);

        return {
          display: info.displayString,
          documentation: plainText(info.documentation),
          tags: (info.tags ?? []).map((tag) => ({ name: tag.name, text: plainText(tag.text) })),
        };
      });

      const definition = Effect.fn('LanguageService.definition')(function* (at: CodePosition) {
        const body = yield* withServer(at, (server, file) =>
          server.request('definition', { file, line: at.line, offset: at.offset }),
        );
        const spans = yield* decode(Definitions, at)(body);

        return yield* Effect.forEach(spans, (span) =>
          Effect.map(lineOf(span.file, span.start.line), (preview) => toLocation(span, preview, true)),
        );
      });

      const references = Effect.fn('LanguageService.references')(function* (at: CodePosition) {
        const body = yield* withServer(at, (server, file) =>
          server.request('references', { file, line: at.line, offset: at.offset }),
        );
        const found = yield* decode(References, at)(body);

        return found.refs.map((ref) => toLocation(ref, (ref.lineText ?? '').trim(), ref.isDefinition ?? false));
      });

      return LanguageService.of({ hover, definition, references });
    }),
  );
}
