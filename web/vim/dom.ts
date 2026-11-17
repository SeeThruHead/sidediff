import type { Point } from './actions';
import type { Side } from './model';

export type VisibleLine = { readonly path: string; readonly side: Side; readonly line: number };

const SCROLL_MARGIN = 72;

const shadowRootIn = (element: Element | null) => element?.querySelector('diffs-container')?.shadowRoot ?? null;

export const fileSection = (path: string) => document.getElementById(`file-${path}`);

const isSide = (side: Side) => (row: Element) =>
  side === 'deletions'
    ? row.getAttribute('data-line-type') !== 'change-addition'
    : row.getAttribute('data-line-type') !== 'change-deletion';

const rowIn = (root: ShadowRoot | null, at: Point) => {
  if (root === null) return undefined;

  const code = root.querySelector(`code[data-${at.side}]`) ?? root.querySelector('code[data-unified]') ?? root;
  return [...code.querySelectorAll<HTMLElement>(`[data-line="${at.line}"]`)].find(isSide(at.side));
};

export const diffRow = (path: string, at: Point) => rowIn(shadowRootIn(fileSection(path)), at);

export const fileRow = (container: Element | null, line: number) =>
  rowIn(shadowRootIn(container), { side: 'additions', line });

const isOutside = (element: Element, container: Element) => {
  const box = element.getBoundingClientRect();
  const frame = container.getBoundingClientRect();
  if (box.top < frame.top + SCROLL_MARGIN) return true;

  return box.bottom > frame.bottom - SCROLL_MARGIN;
};

export const reveal = (element: Element | undefined | null, container: Element | null, block: ScrollLogicalPosition) => {
  if (element === undefined || element === null) return false;
  if (container === null) return false;
  if (isOutside(element, container)) element.scrollIntoView({ behavior: 'instant', block });

  return true;
};

const changedSelector = '[data-line][data-line-type="change-addition"], [data-line][data-line-type="change-deletion"]';

const sideOf = (row: Element): Side =>
  row.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions';

const isFullyInside = (frame: DOMRect) => (row: Element) => {
  const box = row.getBoundingClientRect();
  if (box.height === 0) return false;
  if (box.top < frame.top) return false;

  return box.bottom <= frame.bottom;
};

export const visibleChangedLines = (main: Element): readonly VisibleLine[] => {
  const frame = main.getBoundingClientRect();
  const sections = [...main.querySelectorAll<HTMLElement>('section.file')].filter((section) => {
    const box = section.getBoundingClientRect();
    return box.bottom > frame.top && box.top < frame.bottom;
  });

  return sections.flatMap((section) => {
    const root = shadowRootIn(section);
    if (root === null) return [];

    const path = section.id.replace(/^file-/, '');
    return [...root.querySelectorAll(changedSelector)]
      .filter(isFullyInside(frame))
      .map((row) => ({ path, side: sideOf(row), line: Number(row.getAttribute('data-line')) }));
  });
};

const UNREAD = 'data-sidediff-unread';

export const markUnread = (section: Element, cells: ReadonlySet<string>) => {
  const root = shadowRootIn(section);
  if (root === null) return;

  [...root.querySelectorAll(changedSelector)].forEach((row) => {
    const unread = cells.has(`${sideOf(row)}:${row.getAttribute('data-line')}`);
    if (unread === row.hasAttribute(UNREAD)) return;
    if (unread) return row.setAttribute(UNREAD, '');

    row.removeAttribute(UNREAD);
  });
};

export const watchShadow = (section: Element, onChange: () => void) => {
  const schedule = () => requestAnimationFrame(onChange);
  const inner = new MutationObserver(schedule);
  const observeRoot = () => {
    const root = shadowRootIn(section);
    if (root !== null) inner.observe(root, { childList: true, subtree: true });
  };
  const outer = new MutationObserver(() => {
    observeRoot();
    schedule();
  });

  outer.observe(section, { childList: true, subtree: true });
  observeRoot();
  schedule();

  return () => {
    outer.disconnect();
    inner.disconnect();
  };
};

export const retryEachFrame = (attempt: () => boolean, tries: number): (() => void) => {
  const pending = new Map<'frame', number>();
  const run = (left: number) =>
    pending.set(
      'frame',
      requestAnimationFrame(() => {
        if (attempt()) return;
        if (left > 0) run(left - 1);
      }),
    );

  run(tries);
  return () => pending.forEach((frame) => cancelAnimationFrame(frame));
};

const isWithin = (frame: DOMRect) => (element: Element) => {
  const box = element.getBoundingClientRect();
  if (box.height === 0) return false;
  if (box.top < frame.top) return false;

  return box.bottom <= frame.bottom;
};

const pointOf = (row: Element): Point => {
  const deleted = row.closest('code[data-deletions]') !== null || row.getAttribute('data-line-type') === 'change-deletion';
  return { side: deleted ? 'deletions' : 'additions', line: Number(row.getAttribute('data-line')) };
};

export type ScreenPlace = { readonly path: string; readonly at: Point | null };

export const firstOnScreen = (main: Element): ScreenPlace | null => {
  const frame = main.getBoundingClientRect();
  const inside = isWithin(frame);
  const places = [...main.querySelectorAll<HTMLElement>('section.file')]
    .filter((section) => {
      const box = section.getBoundingClientRect();
      return box.bottom > frame.top && box.top < frame.bottom;
    })
    .flatMap((section): readonly ScreenPlace[] => {
      const path = section.id.replace(/^file-/, '');
      const root = shadowRootIn(section);
      const row = root === null ? undefined : [...root.querySelectorAll('[data-line]')].find(inside);

      if (headerInPlace(section, frame)) return [{ path, at: null }];
      return row === undefined ? [] : [{ path, at: pointOf(row) }];
    });

  return places[0] ?? null;
};

export const isOnScreen = (element: Element | null | undefined, main: Element) =>
  element !== null && element !== undefined && isWithin(main.getBoundingClientRect())(element);

const STICKY_OFFSET = 16;

const headerInPlace = (section: Element, frame: DOMRect) => {
  const top = section.getBoundingClientRect().top;
  if (top < frame.top - STICKY_OFFSET) return false;

  return top <= frame.bottom - SCROLL_MARGIN;
};

export const headerOnScreen = (path: string, main: Element) => {
  const section = fileSection(path);
  return section !== null && headerInPlace(section, main.getBoundingClientRect());
};

export const revealHeader = (path: string, main: Element | null) => {
  const section = fileSection(path);
  if (section === null) return false;
  if (main === null) return false;
  if (!headerInPlace(section, main.getBoundingClientRect())) section.scrollIntoView({ behavior: 'instant', block: 'start' });

  return true;
};
