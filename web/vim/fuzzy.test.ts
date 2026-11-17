import { describe, expect, it } from 'vitest';

import { parseCommand } from './command';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

const paths = ['src/server.ts', 'src/review.ts', 'web/FileSection.tsx', 'web/vim/state.ts', 'README.md'];

describe('fuzzyFilter', () => {
  it('matches letters in order and ranks file-name hits first', () => {
    expect(fuzzyFilter('fsec', paths, 5).map((match) => match.path)).toEqual(['web/FileSection.tsx']);
    expect(fuzzyFilter('state', paths, 5)[0]?.path).toBe('web/vim/state.ts');
    expect(fuzzyFilter('rev', paths, 5)[0]?.path).toBe('src/review.ts');
  });

  it('returns everything for an empty query, shortest first', () => {
    expect(fuzzyFilter('', paths, 2).map((match) => match.path)).toEqual(['README.md', 'src/review.ts']);
  });

  it('rejects out-of-order letters', () => {
    expect(fuzzyMatch('tsrs', 'src/server.ts')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('reads line numbers, files and searches', () => {
    expect(parseCommand('42')).toEqual({ type: 'gotoLine', line: 42 });
    expect(parseCommand('e src/app.ts:7')).toEqual({ type: 'open', target: { path: 'src/app.ts', line: 7 } });
    expect(parseCommand('e src/app.ts')).toEqual({ type: 'open', target: { path: 'src/app.ts', line: null } });
    expect(parseCommand('rg useState')).toEqual({ type: 'openOverlay', overlay: 'grep', text: 'useState' });
    expect(parseCommand('split')).toEqual({ type: 'setStyle', style: 'split' });
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('wat')).toEqual({ type: 'message', text: 'Not a command: wat' });
  });
});
