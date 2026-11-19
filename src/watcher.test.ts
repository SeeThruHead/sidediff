import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeFileSystem } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Fiber, FileSystem, PlatformError, Stream } from 'effect';
import { TestClock } from 'effect/testing';

import { WATCH_LIMIT, type WatchSettings, changedPaths, planWatches, refreshTriggers } from './watcher.js';

const emfile = PlatformError.systemError({
  _tag: 'Unknown',
  module: 'FileSystem',
  method: 'watch',
  description: 'EMFILE: too many open files, watch',
});

const settings = (overrides: Partial<WatchSettings> = {}): WatchSettings => ({
  poll: false,
  workingTree: false,
  pollEvery: Duration.seconds(2),
  backstopEvery: Duration.seconds(60),
  ...overrides,
});

const advance = (seconds: number) =>
  Effect.forEach(Array.from({ length: seconds }), () => TestClock.adjust(Duration.seconds(1)), { discard: true });

const plan = (dirs: readonly string[]) => Stream.make(planWatches({ gitDirs: ['/repo/.git'], fileDirs: dirs, limit: WATCH_LIMIT }));

describe('planWatches', () => {
  it('never plans more watches than the limit, however big the tree', () => {
    const fileDirs = Array.from({ length: 20_000 }, (_, index) => `/repo/pkg${index % 5_000}/src`);
    const result = planWatches({ gitDirs: ['/repo/.git', '/repo/.git/refs/heads'], fileDirs, limit: WATCH_LIMIT });

    expect(result.dirs).toHaveLength(WATCH_LIMIT);
    expect(result.dirs.slice(0, 2)).toEqual(['/repo/.git', '/repo/.git/refs/heads']);
    expect(result.complete).toBe(false);
  });

  it('watches each changed directory once when they fit', () => {
    const result = planWatches({ gitDirs: ['/repo/.git'], fileDirs: ['/repo/src', '/repo/src', '/repo/web'], limit: 8 });

    expect(result).toEqual({ dirs: ['/repo/.git', '/repo/src', '/repo/web'], complete: true });
  });
});

describe('changedPaths', () => {
  it('reads both sides of every file in a patch', () => {
    const patch = 'diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n--- a/gone.ts\n+++ /dev/null\n';
    expect(changedPaths(patch)).toEqual(['x', 'y', 'gone.ts']);
  });
});

describe('refreshTriggers', () => {
  it.effect('falls back to polling when every watch fails with EMFILE', () =>
    Effect.gen(function* () {
      const fiber = yield* refreshTriggers(plan(['/repo/src', '/repo/web']), settings()).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(true), watch: () => Stream.fail(emfile) })),
        Effect.forkChild,
      );

      yield* advance(7);
      expect(yield* Fiber.join(fiber)).toEqual(['poll', 'poll', 'poll']);
    }),
  );

  it.effect('survives a watch that throws instead of failing', () =>
    Effect.gen(function* () {
      const fiber = yield* refreshTriggers(plan(['/repo/src']), settings()).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(true), watch: () => Stream.die(emfile) })),
        Effect.forkChild,
      );

      yield* advance(3);
      expect(yield* Fiber.join(fiber)).toEqual(['poll']);
    }),
  );

  it.effect('does not poll a committed range while its watches work', () =>
    Effect.gen(function* () {
      const fiber = yield* refreshTriggers(plan(['/repo/src']), settings()).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(
          FileSystem.layerNoop({ exists: () => Effect.succeed(true), watch: () => Stream.never }),
        ),
        Effect.timeoutOption(Duration.seconds(30)),
        Effect.forkChild,
      );

      yield* advance(31);
      expect((yield* Fiber.join(fiber))._tag).toBe('None');
    }),
  );

  it.live('sees edits on disk in a tree bigger than the watch limit', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'sidediff-watch-'));
      const dirs = Array.from({ length: WATCH_LIMIT * 8 }, (_, index) => join(root, `pkg${index}`));
      dirs.forEach((dir) => {
        mkdirSync(dir);
        writeFileSync(join(dir, 'file.ts'), 'export {};\n');
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })));

      const plans = Stream.make(planWatches({ gitDirs: [], fileDirs: dirs, limit: WATCH_LIMIT }));
      const triggers = (edit: string) =>
        refreshTriggers(plans, settings({ pollEvery: Duration.millis(100) })).pipe(
          Stream.filter((trigger) => trigger === (edit === dirs[0] ? 'watch' : 'poll')),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout(Duration.seconds(5)),
          Effect.forkChild,
        );

      const watched = yield* triggers(dirs[0] ?? root);
      yield* Effect.sleep(Duration.millis(300));
      writeFileSync(join(dirs[0] ?? root, 'file.ts'), 'export const changed = 1;\n');
      expect(yield* Fiber.join(watched)).toEqual(['watch']);

      const unwatched = yield* triggers(dirs.at(-1) ?? root);
      writeFileSync(join(dirs.at(-1) ?? root, 'file.ts'), 'export const changed = 2;\n');
      expect(yield* Fiber.join(unwatched)).toEqual(['poll']);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
