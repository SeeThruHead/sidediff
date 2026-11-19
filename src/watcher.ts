import { Cause, Duration, Effect, FileSystem, Ref, Schedule, Stream } from 'effect';

export const WATCH_LIMIT = 256;

export type WatchPlan = { readonly dirs: readonly string[]; readonly complete: boolean };

export type WatchSettings = {
  readonly poll: boolean;
  readonly workingTree: boolean;
  readonly pollEvery: Duration.Duration;
  readonly backstopEvery: Duration.Duration;
};

export type Trigger = 'watch' | 'poll';

export const planWatches = (input: {
  readonly gitDirs: readonly string[];
  readonly fileDirs: readonly string[];
  readonly limit: number;
}): WatchPlan => {
  const gitDirs = [...new Set(input.gitDirs)];
  const fileDirs = [...new Set(input.fileDirs)].filter((dir) => !gitDirs.includes(dir));
  const room = Math.max(0, input.limit - gitDirs.length);

  return { dirs: [...gitDirs, ...fileDirs].slice(0, input.limit), complete: fileDirs.length <= room };
};

export const changedPaths = (patch: string): readonly string[] =>
  patch.split('\n').flatMap((line) => {
    const match = /^(?:\+\+\+ b|--- a)\/(.+)$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const refreshTriggers = (
  plans: Stream.Stream<WatchPlan>,
  settings: WatchSettings,
): Stream.Stream<Trigger, never, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const degraded = yield* Ref.make(false);
      const complete = yield* Ref.make(true);

      const degrade = (cause: Cause.Cause<unknown>) =>
        Ref.getAndSet(degraded, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : Effect.logWarning(
                  `[watch] cannot watch files (${describe(cause)}); checking for changes every ${Duration.format(settings.pollEvery)} instead`,
                ),
          ),
        );

      const watchDir = (dir: string): Stream.Stream<Trigger> =>
        Stream.unwrap(
          fs
            .exists(dir)
            .pipe(Effect.map((exists) => (exists ? fs.watch(dir).pipe(Stream.as<Trigger>('watch')) : Stream.empty))),
        ).pipe(Stream.catchCause((cause) => Stream.fromEffect(degrade(cause)).pipe(Stream.drain)));

      const watching: Stream.Stream<Trigger> = settings.poll
        ? Stream.empty
        : plans.pipe(
            Stream.tap((plan) => Ref.set(complete, plan.complete)),
            Stream.switchMap((plan) => Stream.mergeAll(plan.dirs.map(watchDir), { concurrency: 'unbounded' })),
          );

      const needsPolling = Effect.map(Effect.all([Ref.get(degraded), Ref.get(complete)]), ([isDegraded, isComplete]) => {
        if (settings.poll) return true;
        if (settings.workingTree) return true;
        if (isDegraded) return true;

        return !isComplete;
      });

      const polling = Stream.fromSchedule(Schedule.spaced(settings.pollEvery)).pipe(
        Stream.filterEffect(() => needsPolling),
        Stream.as<Trigger>('poll'),
      );

      const backstop = Stream.fromSchedule(Schedule.spaced(settings.backstopEvery)).pipe(Stream.as<Trigger>('poll'));

      return Stream.mergeAll([watching, polling, backstop], { concurrency: 'unbounded' });
    }),
  );
