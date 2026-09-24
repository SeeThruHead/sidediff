import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

export class GitFailed extends Schema.TaggedError<GitFailed>()('GitFailed', {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
}) {}

export class Git extends Context.Service<
  Git,
  {
    readonly run: (cwd: string, args: readonly string[]) => Effect.Effect<string, GitFailed>;
    readonly repoRoot: (cwd: string) => Effect.Effect<string, GitFailed>;
    readonly commonDir: (cwd: string) => Effect.Effect<string, GitFailed>;
    readonly branch: (cwd: string) => Effect.Effect<string>;
    readonly diff: (cwd: string, range: readonly string[]) => Effect.Effect<string, GitFailed>;
    readonly sides: (
      cwd: string,
      range: readonly string[],
    ) => Effect.Effect<{ readonly old: string; readonly new: string | null }, GitFailed>;
    readonly show: (cwd: string, rev: string, path: string) => Effect.Effect<string, GitFailed>;
  }
>()('sidediff/Git') {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = (cwd: string, args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make('git', [...args], { cwd }));

            const [stdout, exitCode] = yield* Effect.all(
              [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
              { concurrency: 2 },
            );

            return exitCode === 0 ? stdout : yield* new GitFailed({ args, exitCode });
          }),
        ).pipe(Effect.catchTag('PlatformError', () => Effect.fail(new GitFailed({ args, exitCode: -1 }))));

      const trimmed = (cwd: string, args: readonly string[]) => Effect.map(run(cwd, args), (out) => out.trim());

      const sides = (cwd: string, range: readonly string[]) => {
        const [first, second] = range.filter((arg) => !arg.startsWith('-'));

        if (first === undefined) return Effect.succeed({ old: '', new: null });

        if (first.includes('...')) {
          const [base, head] = first.split('...');
          const tip = head || 'HEAD';

          return Effect.map(trimmed(cwd, ['merge-base', base || 'HEAD', tip]), (old) => ({ old, new: tip }));
        }

        if (first.includes('..')) {
          const [base, head] = first.split('..');
          return Effect.succeed({ old: base || 'HEAD', new: head || 'HEAD' });
        }

        return Effect.succeed({ old: first, new: second ?? null });
      };

      return {
        run,
        repoRoot: (cwd) => trimmed(cwd, ['rev-parse', '--show-toplevel']),
        commonDir: (cwd) => trimmed(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        branch: (cwd) => trimmed(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).pipe(Effect.orElseSucceed(() => 'HEAD')),
        diff: (cwd, range) =>
          run(cwd, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', ...range]),
        sides,
        show: (cwd, rev, path) => run(cwd, ['show', `${rev}:${path}`]),
      };
    }),
  );
}
