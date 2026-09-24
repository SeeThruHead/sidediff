import { Context, Effect, Layer, Path } from 'effect';

import { Git } from './git.js';

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
      const common = yield* git.commonDir(root);
      const state = path.join(common, 'sidediff');

      return { root, notes: path.join(state, 'notes'), state, serverFile: path.join(state, 'server.json') };
    }),
  );
}
