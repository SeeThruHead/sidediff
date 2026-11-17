import type { Action } from './actions';

export type Mode = 'normal' | 'overlay';

export type Binding = {
  readonly keys: readonly string[];
  readonly action: Action;
  readonly group: string;
  readonly help: string;
};

export type Pending = { readonly count: string; readonly keys: readonly string[] };

export const noPending: Pending = { count: '', keys: [] };

type KeyEvent = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
};

const named: Record<string, string> = {
  ' ': '<Space>',
  Enter: '<CR>',
  Escape: '<Esc>',
  Tab: '<Tab>',
  ArrowDown: '<Down>',
  ArrowUp: '<Up>',
  ArrowLeft: '<Left>',
  ArrowRight: '<Right>',
  PageDown: '<PageDown>',
  PageUp: '<PageUp>',
  Home: '<Home>',
  End: '<End>',
};

export const tokenOf = (event: KeyEvent): string | null => {
  if (event.metaKey) return null;
  if (event.altKey) return null;
  if (event.ctrlKey && event.key.length === 1) return `<C-${event.key.toLowerCase()}>`;
  if (event.ctrlKey) return null;

  const name = named[event.key];
  if (name !== undefined) return name;

  return event.key.length === 1 ? event.key : null;
};

const bind = (group: string, help: string, action: Action, ...sequences: readonly string[]): readonly Binding[] =>
  sequences.map((sequence) => ({ keys: sequence.match(/<[^>]+>|./g) ?? [], action, group, help }));

const move = (motion: Extract<Action, { type: 'move' }>['motion']): Action => ({ type: 'move', motion });

export const normalBindings: readonly Binding[] = [
  ...bind('Move', 'Next line', move('down'), 'j', '<Down>'),
  ...bind('Move', 'Previous line', move('up'), 'k', '<Up>'),
  ...bind('Move', 'Old side (split)', move('left'), 'h', '<Left>'),
  ...bind('Move', 'New side (split)', move('right'), 'l', '<Right>'),
  ...bind('Move', 'First line', move('top'), 'gg', '<Home>'),
  ...bind('Move', 'Last line', move('bottom'), 'G', '<End>'),
  ...bind('Move', 'Half page down', move('halfDown'), '<C-d>'),
  ...bind('Move', 'Half page up', move('halfUp'), '<C-u>'),
  ...bind('Move', 'Page down', move('pageDown'), '<C-f>', '<PageDown>'),
  ...bind('Move', 'Page up', move('pageUp'), '<C-b>', '<PageUp>'),
  ...bind('Jump', 'Next change', move('nextHunk'), ']c'),
  ...bind('Jump', 'Previous change', move('prevHunk'), '[c'),
  ...bind('Jump', 'Next file', move('nextFile'), ']f'),
  ...bind('Jump', 'Previous file', move('prevFile'), '[f'),
  ...bind('Jump', 'Next unread change', move('nextUnread'), ']u'),
  ...bind('Jump', 'Previous unread change', move('prevUnread'), '[u'),
  ...bind('Jump', 'Next note', { type: 'stepNote', direction: 1 }, ']n'),
  ...bind('Jump', 'Previous note', { type: 'stepNote', direction: -1 }, '[n'),
  ...bind('Jump', 'Back (jump list)', { type: 'jumpBack' }, '<C-o>'),
  ...bind('Jump', 'Forward (jump list)', { type: 'jumpForward' }, '<C-i>', '<Tab>'),
  ...bind('Find', 'Search the diff', { type: 'openOverlay', overlay: 'search' }, '/'),
  ...bind('Find', 'Next match', { type: 'searchNext', direction: 1 }, 'n'),
  ...bind('Find', 'Previous match', { type: 'searchNext', direction: -1 }, 'N'),
  ...bind('Find', 'Find a file in the repo', { type: 'openOverlay', overlay: 'finder' }, '<C-p>', '<Space>f'),
  ...bind('Find', 'Search the repo (ripgrep)', { type: 'openOverlay', overlay: 'grep' }, '<Space>/', '<Space>g'),
  ...bind('Find', 'Open the whole file at the cursor', { type: 'openCurrentFile' }, 'gf'),
  ...bind('Find', 'Command line', { type: 'openOverlay', overlay: 'command' }, ':'),
  ...bind('Review', 'Open file', { type: 'fold', how: 'open' }, 'zo'),
  ...bind('Review', 'Close file', { type: 'fold', how: 'close' }, 'zc'),
  ...bind('Review', 'Open or close file', { type: 'fold', how: 'toggle' }, 'za', '<CR>'),
  ...bind('Review', 'Mark file viewed and go to the next', { type: 'toggleViewed' }, 'v'),
  ...bind('Review', 'Comment on the cursor line', { type: 'comment' }, 'c'),
  ...bind('Review', 'Copy path:line', { type: 'copyLocation' }, 'yy'),
  ...bind('View', 'Split or unified', { type: 'toggle', what: 'style' }, 's'),
  ...bind('View', 'Show or hide notes', { type: 'toggle', what: 'notes' }, 'a'),
  ...bind('View', 'Show or hide comments', { type: 'toggle', what: 'comments' }, 'i'),
  ...bind('View', 'Show or hide the explainer', { type: 'toggle', what: 'explainer' }, 'e'),
  ...bind('View', 'Talk', { type: 'toggle', what: 'voice' }, 'm'),
  ...bind('View', 'This help', { type: 'openOverlay', overlay: 'help' }, '?'),
  ...bind('View', 'Close the open file, dismiss', { type: 'escape' }, '<Esc>'),
  ...bind('View', 'Back to the diff', { type: 'closeFile' }, 'q'),
];

export const overlayBindings: readonly Binding[] = [
  ...bind('Prompt', 'Close', { type: 'closeOverlay' }, '<Esc>'),
  ...bind('Prompt', 'Accept', { type: 'submit' }, '<CR>'),
  ...bind('Prompt', 'Next result', { type: 'overlaySelect', delta: 1 }, '<C-n>', '<C-j>', '<Down>', '<Tab>'),
  ...bind('Prompt', 'Previous result', { type: 'overlaySelect', delta: -1 }, '<C-p>', '<C-k>', '<Up>'),
];

const bindingsFor = (mode: Mode) => (mode === 'normal' ? normalBindings : overlayBindings);

const startsWith = (sequence: readonly string[], prefix: readonly string[]) =>
  prefix.length <= sequence.length && prefix.every((key, index) => sequence[index] === key);

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && startsWith(a, b);

export type Fed = {
  readonly pending: Pending;
  readonly action: Action | null;
  readonly count: number;
  readonly consumed: boolean;
};

const isCountDigit = (pending: Pending, token: string) => {
  if (pending.keys.length > 0) return false;
  if (!/^[0-9]$/.test(token)) return false;

  return token !== '0' || pending.count !== '';
};

export const feed = (mode: Mode, pending: Pending, token: string): Fed => {
  if (mode === 'normal' && isCountDigit(pending, token))
    return { pending: { ...pending, count: pending.count + token }, action: null, count: 1, consumed: true };

  const keys = [...pending.keys, token];
  const bindings = bindingsFor(mode);
  const exact = bindings.find((binding) => same(binding.keys, keys));
  const count = Math.max(1, Number(pending.count === '' ? '1' : pending.count));

  if (exact !== undefined) return { pending: noPending, action: exact.action, count, consumed: true };
  if (bindings.some((binding) => startsWith(binding.keys, keys)))
    return { pending: { count: pending.count, keys }, action: null, count: 1, consumed: true };
  if (pending.keys.length > 0) return feed(mode, noPending, token);

  return { pending: noPending, action: null, count: 1, consumed: pending.count !== '' };
};

export const describePending = (pending: Pending) => `${pending.count}${pending.keys.join('')}`;

export const helpGroups = (): readonly (readonly [string, readonly Binding[]])[] =>
  [...normalBindings, ...overlayBindings].reduce<readonly (readonly [string, readonly Binding[]])[]>(
    (groups, binding) => {
      const existing = groups.find(([group]) => group === binding.group);
      if (existing === undefined) return [...groups, [binding.group, [binding]]];

      return groups.map((group) => (group === existing ? [group[0], [...group[1], binding]] : group));
    },
    [],
  );
