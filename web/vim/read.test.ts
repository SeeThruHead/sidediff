import { describe, expect, it } from 'vitest';

import { appPatch } from './fixtures';
import { changedLinesOf, rowsOf } from './model';
import {
  READ_AFTER_MS,
  type Reading,
  fileProgress,
  overallProgress,
  percent,
  prune,
  tick,
  unreadLines,
  unreadRowsOf,
} from './read';

const empty: Reading = { dwell: new Map(), marks: {} };
const changed = changedLinesOf(appPatch);
const file = { path: 'src/app.ts', changed };
const seen = (index: number) => ({ path: 'src/app.ts', key: changed[index]?.key ?? '' });

const ticks = (reading: Reading, visible: readonly { path: string; key: string }[], count: number, ms: number) =>
  Array.from({ length: count }).reduce<Reading>((current) => tick(current, visible, ms), reading);

describe('tick', () => {
  it('marks a line read once it has been on screen long enough', () => {
    const short = ticks(empty, [seen(0)], 2, 250);
    expect(short.marks).toEqual({});

    const long = ticks(empty, [seen(0)], READ_AFTER_MS / 200, 200);
    expect(long.marks).toEqual({ 'src/app.ts': [seen(0).key] });
    expect(long.dwell.size).toBe(0);
  });

  it('adds up time across separate visits', () => {
    const first = ticks(empty, [seen(1)], 3, 200);
    const away = ticks(first, [], 10, 200);
    const back = ticks(away, [seen(1)], 3, 200);

    expect(back.marks['src/app.ts']).toEqual([seen(1).key]);
  });

  it('does not count a long pause as reading time', () => {
    expect(tick(empty, [seen(0)], 60_000).marks).toEqual({});
  });

  it('ignores lines already read', () => {
    const read = ticks(empty, [seen(0)], 10, 200);
    expect(tick(read, [seen(0)], 200)).toBe(read);
  });
});

describe('progress', () => {
  it('counts read changed lines per file and overall', () => {
    const marks = { 'src/app.ts': [seen(0).key, seen(1).key] };

    expect(fileProgress(marks, file)).toEqual({ read: 2, total: 5 });
    expect(overallProgress(marks, [file, { path: 'b.ts', changed: [] }])).toEqual({ read: 2, total: 5 });
    expect(percent({ read: 2, total: 5 })).toBe(40);
    expect(percent({ read: 0, total: 0 })).toBe(100);
  });

  it('forgets lines that changed since they were read', () => {
    const marks = { 'src/app.ts': [seen(2).key, 'gone.0'], 'other.ts': ['x.0'] };
    const edited = changedLinesOf(appPatch.replace('+const c = 4;', '+const c = 44;'));

    expect(prune(marks, [{ path: 'src/app.ts', changed: edited }])).toEqual({ 'other.ts': ['x.0'] });
    expect(prune(marks, [file])).toEqual({ 'src/app.ts': [seen(2).key], 'other.ts': ['x.0'] });
  });

  it('finds the rows that still hold unread changes', () => {
    const marks = { 'src/app.ts': [seen(0).key, seen(1).key, seen(2).key] };
    const rows = rowsOf(appPatch, 'unified');

    expect(unreadLines(marks, file).map((line) => line.line)).toEqual([11, 12]);
    expect([...unreadRowsOf(rows, unreadLines(marks, file))]).toEqual([7, 8]);
  });
});
