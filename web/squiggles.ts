import { useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { useEffect } from 'react';

import type { Diagnostic, Severity } from '../src/protocol';
import { diagnosticsAtom, registry } from './client';

const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info', 'hint'];

type Painted = ReadonlyMap<string, readonly (readonly [Severity, Range])[]>;

const paintedAtom = Atom.make<Painted>(new Map()).pipe(Atom.keepAlive);

const paint = (painted: Painted) => {
  if (!('highlights' in CSS)) return;

  const all = [...painted.values()].flat();

  SEVERITIES.forEach((severity) =>
    CSS.highlights.set(
      `sidediff-${severity}`,
      new Highlight(...all.filter(([found]) => found === severity).map(([, range]) => range)),
    ),
  );
};

registry.subscribe(paintedAtom, paint);

const shadowRootOf = (section: HTMLElement) => section.querySelector('diffs-container')?.shadowRoot ?? null;

const isNewSideRow = (row: Element) => row.getAttribute('data-line-type') !== 'change-deletion';

const rowFor = (root: ShadowRoot, line: number) => {
  const code = root.querySelector('code[data-additions]') ?? root.querySelector('code[data-unified]') ?? root;
  return [...code.querySelectorAll(`[data-line="${line}"]`)].find(isNewSideRow);
};

type Point = { readonly node: Text; readonly offset: number };

const tokensOf = (row: Element) =>
  [...row.querySelectorAll<HTMLElement>('[data-char]')].flatMap((token) => {
    const text = token.firstChild;
    if (!(text instanceof Text)) return [];

    return [{ start: Number(token.getAttribute('data-char')), text }];
  });

const pointAt = (row: Element, column: number, preferEnd: boolean): Point | null => {
  const tokens = tokensOf(row);
  const inside = tokens.find(({ start, text }) =>
    preferEnd ? column > start && column <= start + text.length : column >= start && column < start + text.length,
  );
  if (inside !== undefined) return { node: inside.text, offset: column - inside.start };

  const last = tokens.at(-1);
  if (last === undefined) return null;
  if (!preferEnd) return null;

  return { node: last.text, offset: last.text.length };
};

const rowLength = (row: Element) => {
  const last = tokensOf(row).at(-1);
  return last === undefined ? 0 : last.start + last.text.length;
};

const rangeOnRow = (row: Element, from: number, to: number) => {
  const start = pointAt(row, from, false);
  const end = pointAt(row, Math.max(to, from + 1), true);
  if (start === null) return [];
  if (end === null) return [];

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  return [range];
};

const rangesFor = (root: ShadowRoot, diagnostic: Diagnostic): readonly Range[] =>
  Array.from({ length: diagnostic.endLine - diagnostic.line + 1 }, (_, index) => diagnostic.line + index).flatMap(
    (line) => {
      const row = rowFor(root, line);
      if (row === undefined) return [];

      const from = line === diagnostic.line ? diagnostic.column - 1 : 0;
      const to = line === diagnostic.endLine ? diagnostic.endColumn - 1 : rowLength(row);

      return rangeOnRow(row, from, to);
    },
  );

const withoutKey = (painted: Painted, key: string): Painted =>
  new Map([...painted].filter(([candidate]) => candidate !== key));

const repaint = (section: HTMLElement, key: string, diagnostics: readonly Diagnostic[]) => {
  const root = shadowRootOf(section);
  const ranges =
    root === null
      ? []
      : diagnostics.flatMap((diagnostic) =>
          rangesFor(root, diagnostic).map((range) => [diagnostic.severity, range] as const),
        );

  registry.set(paintedAtom, new Map([...withoutKey(registry.get(paintedAtom), key), [key, ranges]]));
};

export const useDiagnostics = (path: string): readonly Diagnostic[] => {
  const result = useAtomValue(diagnosticsAtom(path));
  return result._tag === 'Success' ? result.value : [];
};

export const useSquiggles = (
  sectionRef: { readonly current: HTMLElement | null },
  key: string,
  diagnostics: readonly Diagnostic[],
) => {
  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;

    const schedule = () => requestAnimationFrame(() => repaint(section, key, diagnostics));
    const observed = new MutationObserver(schedule);
    const watchShadow = () => {
      const root = shadowRootOf(section);
      if (root !== null) observed.observe(root, { childList: true, subtree: true });
    };

    const hosts = new MutationObserver(() => {
      watchShadow();
      schedule();
    });

    hosts.observe(section, { childList: true, subtree: true });
    watchShadow();
    schedule();

    return () => {
      hosts.disconnect();
      observed.disconnect();
      registry.set(paintedAtom, withoutKey(registry.get(paintedAtom), key));
    };
  }, [sectionRef, key, diagnostics]);
};

export const isAt = (diagnostic: Diagnostic, line: number, column: number) => {
  if (line < diagnostic.line) return false;
  if (line > diagnostic.endLine) return false;
  if (line === diagnostic.line && column < diagnostic.column) return false;
  if (line === diagnostic.endLine && column > Math.max(diagnostic.endColumn, diagnostic.column + 1)) return false;

  return true;
};
