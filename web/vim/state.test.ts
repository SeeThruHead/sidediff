import { describe, expect, it } from 'vitest';

import type { Action } from './actions';
import { appPatch, context, fileContext, utilPatch } from './fixtures';
import { type Context, type NavState, type Result, currentCursor, initialNav, update } from './state';

const run = (actions: readonly Action[], ctx: Context = context(), from: NavState = initialNav): Result =>
  actions.reduce<Result>(
    (result, action) => {
      const next = update(result.state, action, ctx);
      return { state: next.state, effects: [...result.effects, ...next.effects] };
    },
    { state: from, effects: [] },
  );

const keys = (...tokens: readonly string[]): readonly Action[] => tokens.map((token) => ({ type: 'key', token }));

const cursorOf = (result: Result, ctx: Context = context()) => currentCursor(result.state, ctx);

describe('cursor movement', () => {
  it('starts on the first file header and walks down its lines', () => {
    expect(cursorOf(run([]))).toEqual({ path: 'src/app.ts', at: null });
    expect(cursorOf(run(keys('j')))).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 1 } });
    expect(cursorOf(run(keys('j', 'j')))).toEqual({ path: 'src/app.ts', at: { side: 'deletions', line: 2 } });
  });

  it('moves by a count and stops at the ends', () => {
    expect(cursorOf(run(keys('3', 'j')))).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 2 } });
    expect(cursorOf(run(keys('k', 'k')))).toEqual({ path: 'src/app.ts', at: null });
    expect(cursorOf(run(keys('G')))).toEqual({ path: 'src/util.ts', at: { side: 'additions', line: 2 } });
    expect(cursorOf(run(keys('G', 'g', 'g')))).toEqual({ path: 'src/app.ts', at: null });
  });

  it('jumps between changes and files', () => {
    expect(cursorOf(run(keys(']', 'c')))).toEqual({ path: 'src/app.ts', at: { side: 'deletions', line: 2 } });
    expect(cursorOf(run(keys(']', 'c', ']', 'c')))).toEqual({ path: 'src/app.ts', at: { side: 'deletions', line: 11 } });
    expect(cursorOf(run(keys(']', 'c', ']', 'c', ']', 'c')))).toEqual({ path: 'src/util.ts', at: { side: 'deletions', line: 1 } });
    expect(cursorOf(run(keys(']', 'f')))).toEqual({ path: 'src/util.ts', at: null });
    expect(cursorOf(run(keys(']', 'f', '[', 'f')))).toEqual({ path: 'src/app.ts', at: null });
  });

  it('says so when there is nowhere further to jump', () => {
    const result = run(keys(']', 'f', ']', 'f'));
    expect(result.state.message).toBe('Last file');
    expect(cursorOf(result)).toEqual({ path: 'src/util.ts', at: null });
  });

  it('switches sides of a split row with h and l', () => {
    const ctx = context('split');
    const right = run(keys('j', 'j'), ctx);
    expect(cursorOf(right, ctx)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 2 } });

    const left = run(keys('j', 'j', 'h'), ctx);
    expect(cursorOf(left, ctx)).toEqual({ path: 'src/app.ts', at: { side: 'deletions', line: 2 } });
    expect(cursorOf(run(keys('j', 'j', 'h', 'j'), ctx), ctx)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 3 } });
  });

  it('keeps its line when the layout switches', () => {
    const split = context('split');
    const unified = context('unified');
    const result = run(keys('j', 'j', 'j'), split);

    expect(cursorOf(result, split)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 3 } });
    expect(cursorOf(result, unified)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 3 } });
  });

  it('skips the lines of a closed file', () => {
    const ctx = context('unified', {
      files: [fileContext('src/app.ts', appPatch, 'unified', { open: false }), fileContext('src/util.ts', utilPatch, 'unified')],
    });

    expect(cursorOf(run(keys('j'), ctx), ctx)).toEqual({ path: 'src/util.ts', at: null });
  });
});

describe('folds and viewed marks', () => {
  it('closes the file under the cursor and parks on its header', () => {
    const result = run(keys('j', 'z', 'c'));
    expect(result.effects).toEqual([{ kind: 'setOpen', path: 'src/app.ts', open: false }]);
    expect(result.state.cursor).toEqual({ path: 'src/app.ts', at: null });
  });

  it('marks a file viewed and moves to the next file', () => {
    const result = run(keys('j', 'v'));
    expect(result.effects).toEqual([{ kind: 'markViewed', path: 'src/app.ts', viewed: true }]);
    expect(result.state.cursor).toEqual({ path: 'src/util.ts', at: null });
  });

  it('starts a comment on the cursor line', () => {
    expect(run(keys('j', 'j', 'c')).effects).toEqual([{ kind: 'compose', path: 'src/app.ts', side: 'deletions', line: 2 }]);
    expect(run(keys('c')).state.message).toBe('Move to a line first');
  });
});

describe('search', () => {
  it('finds the next matching line and repeats with n and N', () => {
    const typed = run([...keys('/'), { type: 'overlayInput', text: 'return' }, ...keys('<CR>')]);
    expect(typed.state.overlay).toBeNull();
    expect(cursorOf(typed)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 11 } });

    const next = run(keys('n'), context(), typed.state);
    expect(cursorOf(next)).toEqual({ path: 'src/app.ts', at: { side: 'deletions', line: 11 } });

    const back = run(keys('N'), context(), next.state);
    expect(cursorOf(back)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 11 } });
  });

  it('wraps around and says so', () => {
    const typed = run([...keys('G', '/'), { type: 'overlayInput', text: 'const a' }, ...keys('<CR>')]);
    expect(typed.state.message).toBe('Search wrapped: const a');
    expect(cursorOf(typed)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 1 } });
  });

  it('matches case only when the query has capitals', () => {
    const typed = run([...keys('/'), { type: 'overlayInput', text: 'CONST C' }, ...keys('<CR>')]);
    expect(typed.state.message).toBe('Not found: CONST C');
  });
});

describe('opening files and the jump list', () => {
  it('opens a changed line in the diff and a file outside it in the file view', () => {
    const inDiff = run([{ type: 'open', target: { path: 'src/app.ts', line: 12 } }]);
    expect(inDiff.state.view).toEqual({ kind: 'diff' });
    expect(cursorOf(inDiff)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 12 } });

    const outside = run([{ type: 'open', target: { path: 'README.md', line: 40 } }]);
    expect(outside.state.view).toEqual({ kind: 'file', path: 'README.md', line: 40 });
  });

  it('opens a line of a changed file that is outside its hunks in the file view', () => {
    const result = run([{ type: 'open', target: { path: 'src/app.ts', line: 8 } }]);
    expect(result.state.view).toEqual({ kind: 'file', path: 'src/app.ts', line: 8 });
  });

  it('accepts the selected finder result', () => {
    const ctx = context('unified', { results: [{ path: 'a.ts', line: null }, { path: 'b.ts', line: 3 }] });
    const result = run([...keys('<C-p>'), ...keys('<C-n>', '<CR>')], ctx);

    expect(result.state.overlay).toBeNull();
    expect(result.state.view).toEqual({ kind: 'file', path: 'b.ts', line: 3 });
  });

  it('goes back and forward with Ctrl-o and Ctrl-i', () => {
    const ctx = context();
    const opened = run([...keys('j'), { type: 'open', target: { path: 'README.md', line: 5 } }], ctx);
    const back = run(keys('<C-o>'), ctx, opened.state);
    expect(back.state.view).toEqual({ kind: 'diff' });
    expect(cursorOf(back, ctx)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 1 } });

    const forward = run(keys('<C-i>'), ctx, back.state);
    expect(forward.state.view).toEqual({ kind: 'file', path: 'README.md', line: 5 });

    expect(run(keys('<C-i>'), ctx, forward.state).state.message).toBe('End of the jump list');
  });

  it('moves through the whole-file view by line', () => {
    const ctx = context('unified', { fileLines: ['a', 'b', 'c', 'd', 'e'] });
    const opened = run([{ type: 'open', target: { path: 'README.md', line: 2 } }, ...keys('j', 'j')], ctx);
    expect(opened.state.view).toEqual({ kind: 'file', path: 'README.md', line: 4 });
    expect(run(keys('G'), ctx, opened.state).state.view).toEqual({ kind: 'file', path: 'README.md', line: 5 });
    expect(run(keys('q'), ctx, opened.state).state.view).toEqual({ kind: 'diff' });
  });

  it('runs a command line', () => {
    const typed = run([...keys(':'), { type: 'overlayInput', text: 'e docs/a.md:9' }, ...keys('<CR>')]);
    expect(typed.state.view).toEqual({ kind: 'file', path: 'docs/a.md', line: 9 });

    const style = run([...keys(':'), { type: 'overlayInput', text: 'unified' }, ...keys('<CR>')]);
    expect(style.effects).toEqual([{ kind: 'setStyle', style: 'unified' }]);
  });
});

describe('unread changes', () => {
  it('jumps to the next change that has not been read', () => {
    const ctx = context('unified', {
      files: [
        fileContext('src/app.ts', appPatch, 'unified', { unreadRows: new Set([8]) }),
        fileContext('src/util.ts', utilPatch, 'unified', { unreadRows: new Set() }),
      ],
    });

    expect(cursorOf(run(keys(']', 'u'), ctx), ctx)).toEqual({ path: 'src/app.ts', at: { side: 'additions', line: 12 } });
    expect(run(keys(']', 'u', ']', 'u'), ctx).state.message).toBe('Everything below is read');
  });
});
