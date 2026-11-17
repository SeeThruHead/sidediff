import type { Action, DiffCursor, Motion, OverlayKind, Point, Target, Toggle } from './actions';
import { parseCommand } from './command';
import { type Mode, type Pending, feed, noPending } from './keys';
import { type DiffStyle, type Row, type Side, preferredCell, rowText } from './model';

export type FileContext = {
  readonly path: string;
  readonly rows: readonly Row[];
  readonly open: boolean;
  readonly viewed: boolean;
  readonly unreadRows: ReadonlySet<number>;
};

export type Context = {
  readonly files: readonly FileContext[];
  readonly style: DiffStyle;
  readonly halfPage: number;
  readonly fileLines: readonly string[] | null;
  readonly results: readonly Target[];
};

export type View = { readonly kind: 'diff' } | { readonly kind: 'file'; readonly path: string; readonly line: number };

export type Location =
  | { readonly kind: 'diff'; readonly cursor: DiffCursor }
  | { readonly kind: 'file'; readonly path: string; readonly line: number };

export type Overlay = { readonly kind: OverlayKind; readonly text: string; readonly selected: number };

export type Jumps = { readonly list: readonly Location[]; readonly index: number };

export type NavState = {
  readonly pending: Pending;
  readonly cursor: DiffCursor | null;
  readonly side: Side;
  readonly view: View;
  readonly overlay: Overlay | null;
  readonly jumps: Jumps;
  readonly search: string | null;
  readonly message: string | null;
};

export type Effect =
  | { readonly kind: 'setOpen'; readonly path: string; readonly open: boolean }
  | { readonly kind: 'markViewed'; readonly path: string; readonly viewed: boolean }
  | { readonly kind: 'toggle'; readonly what: Toggle }
  | { readonly kind: 'setStyle'; readonly style: DiffStyle }
  | { readonly kind: 'stepNote'; readonly direction: 1 | -1 }
  | { readonly kind: 'compose'; readonly path: string; readonly side: Side; readonly line: number }
  | { readonly kind: 'copy'; readonly text: string }
  | { readonly kind: 'theme'; readonly name: string }
  | { readonly kind: 'dismissGuide' };

export type Result = { readonly state: NavState; readonly effects: readonly Effect[] };

export const initialNav: NavState = {
  pending: noPending,
  cursor: null,
  side: 'additions',
  view: { kind: 'diff' },
  overlay: null,
  jumps: { list: [], index: 0 },
  search: null,
  message: null,
};

type Position = { readonly path: string; readonly row: number };

const done = (state: NavState, ...effects: readonly Effect[]): Result => ({ state, effects });

const say = (state: NavState, message: string): Result => done({ ...state, message });

export const positionsOf = (ctx: Context): readonly Position[] =>
  ctx.files.flatMap((file) => [
    { path: file.path, row: -1 },
    ...(file.open ? file.rows.map((_, row) => ({ path: file.path, row })) : []),
  ]);

const fileOf = (ctx: Context, path: string) => ctx.files.find((file) => file.path === path);

const rowOf = (rows: readonly Row[], at: Point): number => {
  const exact = rows.findIndex((row) => row[at.side]?.line === at.line);
  if (exact >= 0) return exact;

  const after = rows.findIndex((row) => (row[at.side]?.line ?? 0) > at.line);
  return after >= 0 ? after : rows.length - 1;
};

export const cursorRow = (ctx: Context, cursor: DiffCursor): number => {
  const file = fileOf(ctx, cursor.path);
  if (file === undefined) return -1;
  if (!file.open) return -1;
  if (cursor.at === null) return -1;

  return rowOf(file.rows, cursor.at);
};

const indexOf = (ctx: Context, positions: readonly Position[], cursor: DiffCursor | null) => {
  if (cursor === null) return 0;

  const row = cursorRow(ctx, cursor);
  const exact = positions.findIndex((position) => position.path === cursor.path && position.row === row);
  return exact >= 0 ? exact : 0;
};

const pointFor = (ctx: Context, row: Row, side: Side): Point | null => {
  if (ctx.style === 'unified' && row.kind === 'context' && row.additions !== null)
    return { side: 'additions', line: row.additions.line };

  return preferredCell(row, side);
};

const cursorAt = (ctx: Context, position: Position, side: Side): DiffCursor => {
  const row = fileOf(ctx, position.path)?.rows[position.row];
  return { path: position.path, at: row === undefined ? null : pointFor(ctx, row, side) };
};

export const currentCursor = (state: NavState, ctx: Context): DiffCursor | null => {
  const positions = positionsOf(ctx);
  const first = positions[0];
  if (first === undefined) return null;
  if (state.cursor === null) return cursorAt(ctx, first, state.side);
  if (fileOf(ctx, state.cursor.path) === undefined) return cursorAt(ctx, first, state.side);

  const position = positions[indexOf(ctx, positions, state.cursor)] ?? first;
  return position.row === -1 ? { path: position.path, at: null } : cursorAt(ctx, position, state.side);
};

const here = (state: NavState, ctx: Context): Location | null => {
  if (state.view.kind === 'file') return { kind: 'file', path: state.view.path, line: state.view.line };

  const cursor = currentCursor(state, ctx);
  return cursor === null ? null : { kind: 'diff', cursor };
};

const sameLocation = (a: Location | undefined, b: Location) => JSON.stringify(a) === JSON.stringify(b);

const recordJump = (state: NavState, ctx: Context): NavState => {
  const from = here(state, ctx);
  if (from === null) return state;

  const kept = state.jumps.list.slice(0, state.jumps.index);
  const list = sameLocation(kept.at(-1), from) ? kept : [...kept, from];

  return { ...state, jumps: { list, index: list.length } };
};

const goTo = (state: NavState, location: Location): NavState =>
  location.kind === 'diff'
    ? { ...state, view: { kind: 'diff' }, cursor: location.cursor }
    : { ...state, view: { kind: 'file', path: location.path, line: location.line } };

const isBlockStart = (file: FileContext, row: number) => {
  const current = file.rows[row];
  if (current?.kind !== 'change') return false;

  const previous = file.rows[row - 1];
  return previous?.kind !== 'change' || previous.hunk !== current.hunk;
};

const isUnreadStart = (file: FileContext, row: number) =>
  file.unreadRows.has(row) && !file.unreadRows.has(row - 1);

type Predicate = (ctx: Context, position: Position) => boolean;

const startsBlock: Predicate = (ctx, position) => {
  const file = fileOf(ctx, position.path);
  return file !== undefined && isBlockStart(file, position.row);
};

const startsUnread: Predicate = (ctx, position) => {
  const file = fileOf(ctx, position.path);
  return file !== undefined && isUnreadStart(file, position.row);
};

const isHeader: Predicate = (_ctx, position) => position.row === -1;

const seek = (
  ctx: Context,
  positions: readonly Position[],
  from: number,
  direction: 1 | -1,
  count: number,
  matches: Predicate,
): number | null => {
  const hits = positions
    .map((position, index) => ({ position, index }))
    .filter(({ position, index }) => (direction === 1 ? index > from : index < from) && matches(ctx, position))
    .map(({ index }) => index);
  const ordered = direction === 1 ? hits : hits.toReversed();

  return ordered[Math.min(count, ordered.length) - 1] ?? null;
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

type Seeker = { readonly direction: 1 | -1; readonly matches: Predicate; readonly none: string };

const seekers: Partial<Record<Motion, Seeker>> = {
  nextHunk: { direction: 1, matches: startsBlock, none: 'No more changes' },
  prevHunk: { direction: -1, matches: startsBlock, none: 'No earlier changes' },
  nextFile: { direction: 1, matches: isHeader, none: 'Last file' },
  prevFile: { direction: -1, matches: isHeader, none: 'First file' },
  nextUnread: { direction: 1, matches: startsUnread, none: 'Everything below is read' },
  prevUnread: { direction: -1, matches: startsUnread, none: 'Everything above is read' },
};

const isJumpMotion = (motion: Motion) => motion === 'top' || motion === 'bottom';

const stepFor = (motion: Motion, ctx: Context, count: number): number | null => {
  if (motion === 'down') return count;
  if (motion === 'up') return -count;
  if (motion === 'halfDown') return ctx.halfPage * count;
  if (motion === 'halfUp') return -ctx.halfPage * count;
  if (motion === 'pageDown') return ctx.halfPage * 2 * count;
  if (motion === 'pageUp') return -ctx.halfPage * 2 * count;
  return null;
};

const moveInDiff = (state: NavState, ctx: Context, motion: Motion, count: number): Result => {
  if (motion === 'left') return done({ ...state, side: 'deletions', cursor: sideCursor(state, ctx, 'deletions') });
  if (motion === 'right') return done({ ...state, side: 'additions', cursor: sideCursor(state, ctx, 'additions') });

  const positions = positionsOf(ctx);
  if (positions.length === 0) return say(state, 'No changes');

  const from = indexOf(ctx, positions, state.cursor);
  const target = targetIndex(ctx, positions, from, motion, count);
  const position = target === null ? undefined : positions[target];
  if (position === undefined) return say(state, seekers[motion]?.none ?? 'Nowhere to go');

  const jumped = isJumpMotion(motion) ? recordJump(state, ctx) : state;
  return done({ ...jumped, message: null, cursor: cursorAt(ctx, position, state.side) });
};

const targetIndex = (ctx: Context, positions: readonly Position[], from: number, motion: Motion, count: number): number | null => {
  const last = positions.length - 1;
  const step = stepFor(motion, ctx, count);
  if (step !== null) return clamp(from + step, last);
  if (motion === 'top') return 0;
  if (motion === 'bottom') return last;

  const seeker = seekers[motion];
  return seeker === undefined ? null : seek(ctx, positions, from, seeker.direction, count, seeker.matches);
};

const sideCursor = (state: NavState, ctx: Context, side: Side): DiffCursor | null => {
  const cursor = currentCursor(state, ctx);
  if (cursor === null) return null;

  const file = fileOf(ctx, cursor.path);
  const row = file?.rows[cursorRow(ctx, cursor)];
  if (row === undefined) return cursor;

  return { path: cursor.path, at: pointFor(ctx, row, side) };
};

const fileLineFor = (ctx: Context, line: number, last: number, motion: Motion, count: number): number | null => {
  const step = stepFor(motion, ctx, count);
  if (step !== null) return line + step;
  if (motion === 'top') return 1;
  if (motion === 'bottom') return last;

  return null;
};

const moveInFile = (state: NavState, ctx: Context, view: Extract<View, { kind: 'file' }>, motion: Motion, count: number): Result => {
  const last = Math.max(1, ctx.fileLines?.length ?? view.line);
  const line = fileLineFor(ctx, view.line, last, motion, count);
  if (line === null) return say(state, 'Not in the whole-file view; q goes back to the diff');

  const jumped = isJumpMotion(motion) ? recordJump(state, ctx) : state;
  return done({ ...jumped, message: null, view: { ...view, line: Math.max(1, Math.min(line, last)) } });
};

const move = (state: NavState, ctx: Context, motion: Motion, count: number): Result =>
  state.view.kind === 'file' ? moveInFile(state, ctx, state.view, motion, count) : moveInDiff(state, ctx, motion, count);

const isSmartCaseMatch = (query: string) => {
  const caseSensitive = query !== query.toLowerCase();
  return (text: string) => (caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase()));
};

const matchedSide = (row: Row, matches: (text: string) => boolean): Side => {
  if (row.additions !== null && matches(row.additions.text)) return 'additions';
  return row.deletions === null ? 'additions' : 'deletions';
};

const searchDiff = (state: NavState, ctx: Context, query: string, direction: 1 | -1): Result => {
  const matches = isSmartCaseMatch(query);
  const positions = positionsOf(ctx);
  const from = indexOf(ctx, positions, state.cursor);
  const hit: Predicate = (context, position) => {
    const row = fileOf(context, position.path)?.rows[position.row];
    return row !== undefined && rowText(row).some(matches);
  };

  const ahead = seek(ctx, positions, from, direction, 1, hit);
  const wrapped = ahead ?? seek(ctx, positions, direction === 1 ? -1 : positions.length, direction, 1, hit);
  const position = wrapped === null ? undefined : positions[wrapped];
  if (position === undefined) return say({ ...state, search: query }, `Not found: ${query}`);

  const row = fileOf(ctx, position.path)?.rows[position.row];
  const side = row === undefined ? state.side : matchedSide(row, matches);
  const jumped = recordJump(state, ctx);

  return done({
    ...jumped,
    search: query,
    message: ahead === null ? `Search wrapped: ${query}` : `/${query}`,
    cursor: cursorAt(ctx, position, side),
  });
};

const searchFile = (state: NavState, ctx: Context, view: Extract<View, { kind: 'file' }>, query: string, direction: 1 | -1): Result => {
  const lines = ctx.fileLines ?? [];
  const matches = isSmartCaseMatch(query);
  const hits = lines.flatMap((text, index) => (matches(text) ? [index + 1] : []));
  const ahead = direction === 1 ? hits.find((line) => line > view.line) : hits.findLast((line) => line < view.line);
  const line = ahead ?? (direction === 1 ? hits[0] : hits.at(-1));
  if (line === undefined) return say({ ...state, search: query }, `Not found: ${query}`);

  const jumped = recordJump(state, ctx);
  return done({ ...jumped, search: query, message: ahead === undefined ? `Search wrapped: ${query}` : `/${query}`, view: { ...view, line } });
};

const search = (state: NavState, ctx: Context, query: string, direction: 1 | -1): Result =>
  state.view.kind === 'file' ? searchFile(state, ctx, state.view, query, direction) : searchDiff(state, ctx, query, direction);

const open = (state: NavState, ctx: Context, target: Target): Result => {
  const jumped = { ...recordJump(state, ctx), overlay: null, message: null };
  const file = fileOf(ctx, target.path);

  if (file === undefined) return done({ ...jumped, view: { kind: 'file', path: target.path, line: target.line ?? 1 } });
  if (target.line === null) return done({ ...jumped, view: { kind: 'diff' }, cursor: { path: file.path, at: null } }, { kind: 'setOpen', path: file.path, open: true });

  const exact = file.rows.findIndex((row) => row.additions?.line === target.line);
  if (exact < 0) return done({ ...jumped, view: { kind: 'file', path: target.path, line: target.line } });

  return done(
    { ...jumped, view: { kind: 'diff' }, cursor: { path: file.path, at: { side: 'additions', line: target.line } } },
    { kind: 'setOpen', path: file.path, open: true },
  );
};

const cursorLine = (state: NavState, ctx: Context): Target | null => {
  if (state.view.kind === 'file') return { path: state.view.path, line: state.view.line };

  const cursor = currentCursor(state, ctx);
  if (cursor === null) return null;

  return { path: cursor.path, line: cursor.at?.line ?? null };
};

const gotoLine = (state: NavState, ctx: Context, line: number): Result => {
  if (state.view.kind === 'file') return done({ ...recordJump(state, ctx), view: { ...state.view, line: Math.max(1, line) } });

  const cursor = currentCursor(state, ctx);
  if (cursor === null) return say(state, 'No file');

  return update(state, { type: 'open', target: { path: cursor.path, line } }, ctx);
};

const fold = (state: NavState, ctx: Context, how: 'open' | 'close' | 'toggle'): Result => {
  const cursor = currentCursor(state, ctx);
  if (cursor === null) return say(state, 'No file');

  const file = fileOf(ctx, cursor.path);
  const opened = how === 'toggle' ? !(file?.open ?? false) : how === 'open';
  const next = opened ? state.cursor : { path: cursor.path, at: null };

  return done({ ...state, cursor: next, message: null }, { kind: 'setOpen', path: cursor.path, open: opened });
};

const toggleViewed = (state: NavState, ctx: Context): Result => {
  const cursor = currentCursor(state, ctx);
  if (cursor === null) return say(state, 'No file');

  const index = ctx.files.findIndex((file) => file.path === cursor.path);
  const file = ctx.files[index];
  if (file === undefined) return say(state, 'No file');
  if (file.viewed) return done({ ...state, cursor: { path: file.path, at: null } }, { kind: 'markViewed', path: file.path, viewed: false });

  const next = ctx.files[index + 1] ?? file;
  return done(
    { ...state, cursor: { path: next.path, at: null }, message: `Viewed ${file.path}` },
    { kind: 'markViewed', path: file.path, viewed: true },
  );
};

const markViewed = (state: NavState, ctx: Context, viewed: boolean): Result => {
  const cursor = currentCursor(state, ctx);
  if (cursor === null) return say(state, 'No file');

  return done(state, { kind: 'markViewed', path: cursor.path, viewed });
};

const comment = (state: NavState, ctx: Context): Result => {
  if (state.view.kind === 'file') return say(state, 'Comments go on lines in the diff');

  const cursor = currentCursor(state, ctx);
  const at = cursor?.at ?? null;
  if (cursor === null || at === null) return say(state, 'Move to a line first');

  return done(state, { kind: 'compose', path: cursor.path, side: at.side, line: at.line });
};

const jumpBack = (state: NavState, ctx: Context): Result => {
  const current = here(state, ctx);
  const atTip = state.jumps.index >= state.jumps.list.length;
  const list = atTip && current !== null ? [...state.jumps.list, current] : state.jumps.list;
  const index = (atTip ? list.length - 1 : state.jumps.index) - 1;
  const target = list[index];
  if (target === undefined) return say(state, 'Start of the jump list');

  return done({ ...goTo(state, target), jumps: { list, index }, message: null });
};

const jumpForward = (state: NavState): Result => {
  const index = state.jumps.index + 1;
  const target = state.jumps.list[index];
  if (target === undefined) return say(state, 'End of the jump list');

  return done({ ...goTo(state, target), jumps: { list: state.jumps.list, index }, message: null });
};

const submit = (state: NavState, ctx: Context): Result => {
  const overlay = state.overlay;
  if (overlay === null) return done(state);

  const closed = { ...state, overlay: null };

  if (overlay.kind === 'help') return done(closed);
  if (overlay.kind === 'search') return overlay.text === '' ? done(closed) : search(closed, ctx, overlay.text, 1);
  if (overlay.kind === 'command') {
    const action = parseCommand(overlay.text);
    return action === null ? done(closed) : update(closed, action, ctx);
  }

  const count = ctx.results.length;
  const chosen = count === 0 ? undefined : ctx.results[((overlay.selected % count) + count) % count];
  if (chosen === undefined) return say(state, 'No match');

  return open(closed, ctx, chosen);
};

const escape = (state: NavState): Result => {
  if (state.overlay !== null) return done({ ...state, overlay: null });
  if (state.view.kind === 'file') return done({ ...state, view: { kind: 'diff' }, message: null });

  return done({ ...state, message: null, pending: noPending }, { kind: 'dismissGuide' });
};

const modeOf = (state: NavState): Mode => (state.overlay === null ? 'normal' : 'overlay');

const pressKey = (state: NavState, token: string, ctx: Context): Result => {
  const fed = feed(modeOf(state), state.pending, token);
  const next = { ...state, pending: fed.pending };
  if (fed.action === null) return done(next);

  return repeat(next, fed.action, ctx, fed.count);
};

const repeat = (state: NavState, action: Action, ctx: Context, count: number): Result =>
  action.type === 'move' ? move(state, ctx, action.motion, count) : update(state, action, ctx);

export const update = (state: NavState, action: Action, ctx: Context): Result => {
  switch (action.type) {
    case 'key':
      return pressKey(state, action.token, ctx);
    case 'move':
      return move(state, ctx, action.motion, 1);
    case 'fold':
      return fold(state, ctx, action.how);
    case 'toggleViewed':
      return toggleViewed(state, ctx);
    case 'markViewed':
      return markViewed(state, ctx, action.viewed);
    case 'openOverlay':
      return done({ ...state, message: null, overlay: { kind: action.overlay, text: action.text ?? '', selected: 0 } });
    case 'closeOverlay':
      return done({ ...state, overlay: null });
    case 'overlayInput':
      return state.overlay === null ? done(state) : done({ ...state, overlay: { ...state.overlay, text: action.text, selected: 0 } });
    case 'overlaySelect':
      return state.overlay === null
        ? done(state)
        : done({ ...state, overlay: { ...state.overlay, selected: state.overlay.selected + action.delta } });
    case 'submit':
      return submit(state, ctx);
    case 'open':
      return open(state, ctx, action.target);
    case 'openCurrentFile': {
      const target = cursorLine(state, ctx);
      if (target === null) return say(state, 'No file');
      return done({ ...recordJump(state, ctx), view: { kind: 'file', path: target.path, line: target.line ?? 1 } });
    }
    case 'gotoLine':
      return gotoLine(state, ctx, action.line);
    case 'searchNext':
      return state.search === null ? say(state, 'No search yet; / starts one') : search(state, ctx, state.search, action.direction);
    case 'jumpBack':
      return jumpBack(state, ctx);
    case 'jumpForward':
      return jumpForward(state);
    case 'toggle':
      return done(state, { kind: 'toggle', what: action.what });
    case 'setStyle':
      return done(state, { kind: 'setStyle', style: action.style });
    case 'stepNote':
      return done(state, { kind: 'stepNote', direction: action.direction });
    case 'comment':
      return comment(state, ctx);
    case 'copyLocation': {
      const target = cursorLine(state, ctx);
      if (target === null) return say(state, 'No file');
      const text = target.line === null ? target.path : `${target.path}:${target.line}`;
      return done({ ...state, message: `Copied ${text}` }, { kind: 'copy', text });
    }
    case 'theme':
      return done(state, { kind: 'theme', name: action.name });
    case 'escape':
      return escape(state);
    case 'closeFile':
      return state.view.kind === 'file' ? done({ ...state, view: { kind: 'diff' } }) : done(state);
    case 'select':
      return done({ ...state, view: { kind: 'diff' }, cursor: action.cursor, message: null });
    case 'message':
      return say(state, action.text);
  }
};
