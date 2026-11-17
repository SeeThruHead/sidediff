import { describe, expect, it } from 'vitest';

import { type Pending, feed, noPending, tokenOf } from './keys';

const press = (tokens: readonly string[], mode: 'normal' | 'overlay' = 'normal') =>
  tokens.reduce<{ readonly pending: Pending; readonly fired: readonly unknown[] }>(
    (acc, token) => {
      const fed = feed(mode, acc.pending, token);
      return { pending: fed.pending, fired: fed.action === null ? acc.fired : [...acc.fired, [fed.action, fed.count]] };
    },
    { pending: noPending, fired: [] },
  );

describe('tokenOf', () => {
  it('names keys the way vim does', () => {
    expect(tokenOf({ key: 'j', ctrlKey: false, metaKey: false, altKey: false })).toBe('j');
    expect(tokenOf({ key: 'G', ctrlKey: false, metaKey: false, altKey: false })).toBe('G');
    expect(tokenOf({ key: 'd', ctrlKey: true, metaKey: false, altKey: false })).toBe('<C-d>');
    expect(tokenOf({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false })).toBe('<Esc>');
    expect(tokenOf({ key: ' ', ctrlKey: false, metaKey: false, altKey: false })).toBe('<Space>');
  });

  it('leaves Cmd and Alt shortcuts to the browser', () => {
    expect(tokenOf({ key: 'c', ctrlKey: false, metaKey: true, altKey: false })).toBeNull();
    expect(tokenOf({ key: 'f', ctrlKey: false, metaKey: false, altKey: true })).toBeNull();
    expect(tokenOf({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });
});

describe('feed', () => {
  it('fires single keys at once', () => {
    expect(press(['j']).fired).toEqual([[{ type: 'move', motion: 'down' }, 1]]);
  });

  it('waits for the rest of a sequence', () => {
    const half = press(['g']);
    expect(half.fired).toEqual([]);
    expect(half.pending.keys).toEqual(['g']);

    expect(press(['g', 'g']).fired).toEqual([[{ type: 'move', motion: 'top' }, 1]]);
    expect(press([']', 'c']).fired).toEqual([[{ type: 'move', motion: 'nextHunk' }, 1]]);
    expect(press(['<Space>', 'f']).fired).toEqual([[{ type: 'openOverlay', overlay: 'finder' }, 1]]);
  });

  it('takes a count before a motion', () => {
    expect(press(['1', '2', 'j']).fired).toEqual([[{ type: 'move', motion: 'down' }, 12]]);
    expect(press(['3', ']', 'f']).fired).toEqual([[{ type: 'move', motion: 'nextFile' }, 3]]);
  });

  it('drops a broken sequence and reads the key on its own', () => {
    const result = press(['g', 'j']);
    expect(result.fired).toEqual([[{ type: 'move', motion: 'down' }, 1]]);
    expect(result.pending).toEqual(noPending);
  });

  it('only knows prompt keys while a prompt is open', () => {
    expect(press(['j'], 'overlay').fired).toEqual([]);
    expect(press(['<CR>'], 'overlay').fired).toEqual([[{ type: 'submit' }, 1]]);
    expect(press(['<C-n>'], 'overlay').fired).toEqual([[{ type: 'overlaySelect', delta: 1 }, 1]]);
    expect(press(['<Esc>'], 'overlay').fired).toEqual([[{ type: 'closeOverlay' }, 1]]);
  });

  it('does not treat a leading zero as a count', () => {
    expect(press(['0']).pending).toEqual(noPending);
  });
});
