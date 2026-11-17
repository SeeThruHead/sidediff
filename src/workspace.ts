import { Context, Effect, Layer, Result, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { Git } from './git.js';
import { type SearchHit, SearchUnavailable } from './protocol.js';
import { Repo } from './repo.js';

const RgText = Schema.Struct({ text: Schema.String });

const RgMatch = Schema.Struct({
  type: Schema.Literal('match'),
  data: Schema.Struct({
    path: RgText,
    line_number: Schema.Int,
    lines: RgText,
    submatches: Schema.Array(Schema.Struct({ start: Schema.Int })),
  }),
});

const decodeMatch = Schema.decodeUnknownOption(Schema.fromJsonString(RgMatch));

const SEARCH_LIMIT = 300;

const PREVIEW_LENGTH = 300;

const rgArgs = (query: string) => [
  '--json',
  '--smart-case',
  '--fixed-strings',
  '--max-count',
  '20',
  '--max-columns',
  String(PREVIEW_LENGTH),
  '--',
  query,
  '.',
];

const toHit = (match: typeof RgMatch.Type): SearchHit => ({
  path: match.data.path.text.replace(/^\.\//, ''),
  line: Math.max(1, match.data.line_number),
  column: (match.data.submatches[0]?.start ?? 0) + 1,
  text: match.data.lines.text.replace(/\r?\n$/, '').slice(0, PREVIEW_LENGTH),
});

const unavailable = (reason: string) => () => new SearchUnavailable({ reason });

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly files: Effect.Effect<readonly string[], SearchUnavailable>;
    readonly search: (query: string) => Effect.Effect<readonly SearchHit[], SearchUnavailable>;
  }
>()('sidediff/Workspace') {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = yield* Git;
      const repo = yield* Repo;

      const files = git
        .run(repo.root, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .pipe(
          Effect.map((out) => [...new Set(out.split('\0').filter((path) => path !== ''))]),
          Effect.mapError(unavailable('git ls-files failed')),
          Effect.withSpan('Workspace.files'),
        );

      const search = Effect.fn('Workspace.search')(
        function* (query: string) {
          const handle = yield* spawner.spawn(ChildProcess.make('rg', rgArgs(query), { cwd: repo.root }));

          return yield* handle.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filterMap((line: string) => Result.fromOption(decodeMatch(line), () => line)),
            Stream.map(toHit),
            Stream.take(SEARCH_LIMIT),
            Stream.runCollect,
          );
        },
        Effect.scoped,
        Effect.mapError(unavailable('ripgrep (rg) is not installed on the machine running sidediff')),
      );

      return Workspace.of({ files, search });
    }),
  );
}
