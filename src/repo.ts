import { Config, Context, Effect, Layer, Path } from 'effect';

import { Git } from './git.js';

const worktreeKey = (root: string) => root.replace(/^\/+/, '').replaceAll('/', '-');

export class Repo extends Context.Service<
  Repo,
  {
    readonly root: string;
    readonly notes: string;
    readonly state: string;
    readonly serverFile: string;
  }
>()('sidediff/Repo') {
  static readonly layer = Layer.effect(
    Repo,
    Effect.gen(function* () {
      const git = yield* Git;
      const path = yield* Path.Path;

      const root = yield* git.repoRoot(process.cwd());
      const home = yield* Effect.orDie(Config.String('HOME'));
      const stateHome = yield* Effect.orDie(
        Config.NonEmptyString('XDG_STATE_HOME').pipe(
          Config.withDefault(path.join(home, '.local', 'state')),
        ),
      );
      const state = path.join(stateHome, 'sidediff', worktreeKey(root));

      return { root, notes: path.join(state, 'notes'), state, serverFile: path.join(state, 'server.json') };
    }),
  );
}
