import { describe, expect, it } from 'vitest';

import { appPatch } from './fixtures';
import { changedLinesOf, rowsOf } from './model';

describe('rowsOf', () => {
  it('lists every patch line in unified order with its line numbers', () => {
    const rows = rowsOf(appPatch, 'unified');

    expect(rows.map((row) => [row.kind, row.deletions?.line ?? null, row.additions?.line ?? null])).toEqual([
      ['context', 1, 1],
      ['change', 2, null],
      ['change', null, 2],
      ['change', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
      ['context', 10, 11],
      ['change', 11, null],
      ['change', null, 12],
      ['context', 12, 13],
    ]);
  });

  it('pairs deletions with additions side by side in split view', () => {
    const rows = rowsOf(appPatch, 'split');

    expect(rows.slice(0, 4).map((row) => [row.deletions?.text ?? null, row.additions?.text ?? null])).toEqual([
      ['const a = 1;', 'const a = 1;'],
      ['const b = 2;', 'const b = 3;'],
      [null, 'const c = 4;'],
      ['const d = 5;', 'const d = 5;'],
    ]);
    expect(rows).toHaveLength(8);
  });
});

describe('changedLinesOf', () => {
  it('keys changed lines by side and content so a shifted line keeps its key', () => {
    const before = changedLinesOf(appPatch);
    const shifted = changedLinesOf(appPatch.replace('@@ -1,4 +1,5 @@', '@@ -5,4 +5,5 @@'));

    expect(before.map((line) => line.key)).toEqual(shifted.map((line) => line.key));
    expect(before.map((line) => [line.side, line.line])).toEqual([
      ['deletions', 2],
      ['additions', 2],
      ['additions', 3],
      ['deletions', 11],
      ['additions', 12],
    ]);
  });

  it('gives a changed line a new key', () => {
    const before = changedLinesOf(appPatch);
    const edited = changedLinesOf(appPatch.replace('+const c = 4;', '+const c = 44;'));

    expect(edited[2]?.key).not.toEqual(before[2]?.key);
    expect(edited[1]?.key).toEqual(before[1]?.key);
  });

  it('tells repeated identical lines apart', () => {
    const patch = '@@ -1,0 +1,2 @@\n+}\n+}\n';
    const keys = changedLinesOf(patch).map((line) => line.key);

    expect(new Set(keys).size).toBe(2);
  });
});
