import { useAtomValue } from '@effect/atom-react';
import { File } from '@pierre/diffs/react';
import { Atom } from 'effect/reactivity';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CodeLocation, CodePosition, Diagnostic, HoverInfo } from '../src/protocol';
import {
  currentDiagnostics,
  definitionAt,
  hoverAt,
  isInDiff,
  readSource,
  referencesAt,
  registry,
  showInDiff,
} from './client';
import { isAt, useDiagnostics, useSquiggles } from './squiggles';
import { type PaletteName, diffCss, palettes } from './themes';

type HoverTarget = { readonly at: CodePosition; readonly rect: DOMRect };

type Panel =
  | { readonly kind: 'file'; readonly path: string; readonly line: number }
  | { readonly kind: 'references'; readonly symbol: string; readonly locations: readonly CodeLocation[] | null }
  | { readonly kind: 'message'; readonly text: string };

const hoverTargetAtom = Atom.make<HoverTarget | null>(null).pipe(Atom.keepAlive);

const panelAtom = Atom.make<Panel | null>(null).pipe(Atom.keepAlive);

const HOVER_DELAY_MS = 300;
const HIDE_DELAY_MS = 200;

type TokenEvent = {
  readonly lineNumber: number;
  readonly lineCharStart: number;
  readonly tokenText: string;
  readonly tokenElement: HTMLElement;
  readonly side?: 'additions' | 'deletions';
};

const isOldSide = (event: TokenEvent) => event.side === 'deletions';

const positionOf = (path: string, event: TokenEvent): CodePosition => ({
  path,
  line: event.lineNumber,
  offset: event.lineCharStart + 1,
});

const wantsDefinition = (pointer: MouseEvent) => pointer.metaKey || pointer.ctrlKey;

export const goTo = (location: CodeLocation) => {
  if (!location.inRepo) return registry.set(panelAtom, { kind: 'message', text: `${location.path}:${location.line}` });
  if (isInDiff(location.path)) return showInDiff(location.path, location.line);

  return registry.set(panelAtom, { kind: 'file', path: location.path, line: location.line });
};

export const goToDefinition = async (at: CodePosition) => {
  const found = await definitionAt(at).catch(() => []);
  const first = found[0];
  if (first === undefined) return registry.set(panelAtom, { kind: 'message', text: 'No definition found' });

  return goTo(first);
};

export const findReferences = async (at: CodePosition, symbol: string) => {
  registry.set(panelAtom, { kind: 'references', symbol, locations: null });

  const locations = await referencesAt(at).catch(() => []);

  registry.set(panelAtom, { kind: 'references', symbol, locations });
};

export const tokenHandlers = (path: string) => ({
  onTokenEnter: (event: TokenEvent) => {
    if (isOldSide(event)) return;

    registry.set(hoverTargetAtom, { at: positionOf(path, event), rect: event.tokenElement.getBoundingClientRect() });
  },
  onTokenLeave: () => registry.set(hoverTargetAtom, null),
  onTokenClick: (event: TokenEvent, pointer: MouseEvent) => {
    if (isOldSide(event)) return;
    if (!wantsDefinition(pointer)) return;

    pointer.preventDefault();
    void goToDefinition(positionOf(path, event));
  },
});

type Block = { readonly kind: 'code' | 'text' | 'rule'; readonly text: string };

const FENCE = /```[\w-]*\n([\s\S]*?)```/;

const textBlocks = (part: string): readonly Block[] =>
  part.split(/\n\s*-{3,}\s*\n/).flatMap((chunk, index) => [
    ...(index > 0 ? [{ kind: 'rule' as const, text: '' }] : []),
    ...(chunk.trim() === '' ? [] : [{ kind: 'text' as const, text: chunk.trim() }]),
  ]);

const blocksOf = (markdown: string): readonly Block[] =>
  markdown
    .split(FENCE)
    .flatMap((part, index) => (index % 2 === 1 ? [{ kind: 'code' as const, text: part.trimEnd() }] : textBlocks(part)));

const symbolOf = (info: HoverInfo | null) => {
  const code = blocksOf(info?.markdown ?? '').find((block) => block.kind === 'code');
  return code?.text.split('\n')[0] ?? 'References';
};

type Shown = {
  readonly target: HoverTarget;
  readonly info: HoverInfo | null;
  readonly problems: readonly Diagnostic[];
};

const problemsAt = (at: CodePosition) =>
  currentDiagnostics(at.path).filter((diagnostic) => isAt(diagnostic, at.line, at.offset));

const shownFor = (target: HoverTarget, info: HoverInfo | null): Shown | null => {
  const problems = problemsAt(target.at);
  if (info === null && problems.length === 0) return null;

  return { target, info, problems };
};

const useHoverInfo = (target: HoverTarget | null) => {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    if (target === null) return;

    const timer = window.setTimeout(() => {
      void hoverAt(target.at)
        .catch(() => null)
        .then((info) => setShown(shownFor(target, info)));
    }, HOVER_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [target]);

  return [shown, setShown] as const;
};

const PAGE_MARGIN = 8;

const leftWithinPage = (anchor: number, width: number) =>
  Math.max(PAGE_MARGIN, Math.min(anchor, window.innerWidth - width - PAGE_MARGIN));

export const HoverCard = () => {
  const target = useAtomValue(hoverTargetAtom);
  const [shown, setShown] = useHoverInfo(target);
  const [overCard, setOverCard] = useState(false);

  useEffect(() => {
    if (target !== null) return;
    if (overCard) return;

    const timer = window.setTimeout(() => setShown(null), HIDE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [target, overCard, setShown]);

  const card = useRef<HTMLDivElement | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (shown === null) return setLeft(null);
    if (card.current === null) return;

    setLeft(leftWithinPage(shown.target.rect.left, card.current.offsetWidth));
  }, [shown]);

  if (shown === null) return null;

  const { rect, at } = shown.target;
  const below = rect.bottom + 6;
  const vertical = below > window.innerHeight * 0.6 ? { bottom: window.innerHeight - rect.top + 6 } : { top: below };

  return (
    <div
      ref={card}
      className="hover-card"
      style={{ ...vertical, left: left ?? rect.left, visibility: left === null ? 'hidden' : 'visible' }}
      onMouseEnter={() => setOverCard(true)}
      onMouseLeave={() => {
        setOverCard(false);
        setShown(null);
      }}
    >
      {shown.problems.map((problem, index) => (
        <p key={`${problem.source}-${index}`} className={`hover-problem ${problem.severity}`}>
          <span className="hover-problem-source">
            {problem.source}
            {problem.code === undefined ? '' : `(${problem.code})`}
          </span>{' '}
          {problem.message}
        </p>
      ))}
      {blocksOf(shown.info?.markdown ?? '').map((block, index) => {
        if (block.kind === 'code') return <pre key={index} className="hover-display">{block.text}</pre>;
        if (block.kind === 'rule') return <hr key={index} className="hover-rule" />;

        return (
          <p key={index} className="hover-docs">
            {block.text}
          </p>
        );
      })}
      <div className="hover-actions">
        <button
          onClick={() => {
            setShown(null);
            void goToDefinition(at);
          }}
        >
          Go to definition <kbd>⌘ click</kbd>
        </button>
        <button
          onClick={() => {
            setShown(null);
            void findReferences(at, symbolOf(shown.info));
          }}
        >
          Find references
        </button>
      </div>
    </div>
  );
};

const groupByFile = (locations: readonly CodeLocation[]) =>
  locations.reduce<readonly (readonly [string, readonly CodeLocation[]])[]>((groups, location) => {
    const existing = groups.find(([path]) => path === location.path);
    if (existing === undefined) return [...groups, [location.path, [location]]];

    return groups.map((group) => (group === existing ? [group[0], [...group[1], location]] : group));
  }, []);

const shadowRootsIn = (container: Element | null): readonly ShadowRoot[] =>
  container === null
    ? []
    : [...container.querySelectorAll('*')].flatMap((element) => (element.shadowRoot === null ? [] : [element.shadowRoot]));

const isNewSideRow = (row: Element) => row.getAttribute('data-line-type') !== 'change-deletion';

const renderedRow = (path: string, line: number) =>
  [...shadowRootsIn(document.getElementById(`file-${path}`)), ...shadowRootsIn(document.querySelector('.code-panel'))]
    .flatMap((root) => [...root.querySelectorAll(`[data-line="${line}"]`)])
    .find(isNewSideRow);

const RenderedLine = ({ location }: { location: CodeLocation }) => {
  const target = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const row = renderedRow(location.path, location.line);
    if (row === undefined) return setCopied(false);
    if (target.current === null) return;

    target.current.replaceChildren(...[...row.childNodes].map((node) => node.cloneNode(true)));
    setCopied(true);
  }, [location]);

  return (
    <>
      <code ref={target} hidden={!copied} />
      {!copied && <code>{location.preview}</code>}
    </>
  );
};

const References = ({ symbol, locations }: { symbol: string; locations: readonly CodeLocation[] | null }) => (
  <div className="code-panel-body">
    <h3 className="code-panel-title">{symbol}</h3>
    {locations === null && <p className="code-panel-status">Finding references…</p>}
    {locations !== null && locations.length === 0 && <p className="code-panel-status">No references</p>}
    {groupByFile(locations ?? []).map(([path, entries]) => (
      <div key={path} className="reference-file">
        <div className="reference-path">{path}</div>
        {entries.map((entry) => (
          <button
            key={`${entry.line}:${entry.offset}`}
            className="reference"
            onClick={() => goTo(entry)}
          >
            <span className="reference-line">{entry.line}</span>
            <RenderedLine location={entry} />
            {entry.isDefinition && <span className="badge">definition</span>}
          </button>
        ))}
      </div>
    ))}
  </div>
);

const PanelSquiggles = ({ path, bodyRef }: { path: string; bodyRef: { readonly current: HTMLElement | null } }) => {
  useSquiggles(bodyRef, `panel:${path}`, useDiagnostics(path));
  return null;
};

const SourceFile = ({ path, line, palette }: { path: string; line: number; palette: PaletteName }) => {
  const [contents, setContents] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setContents(null);
    setFailed(false);
    void readSource(path)
      .then(setContents)
      .catch(() => setFailed(true));
  }, [path]);

  useEffect(() => {
    if (contents === null) return;

    const frame = requestAnimationFrame(() =>
      body.current?.querySelector('[data-code-target]')?.scrollIntoView({ behavior: 'instant', block: 'center' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [contents, line]);

  const options = useMemo(
    () => ({
      theme: palette,
      themeType: 'dark' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
      unsafeCSS: diffCss(palettes[palette]),
      ...tokenHandlers(path),
    }),
    [palette, path],
  );

  if (failed) return <p className="code-panel-status">Could not read {path}</p>;
  if (contents === null) return <p className="code-panel-status">Loading…</p>;

  return (
    <div ref={body} className="code-panel-body">
      <h3 className="code-panel-title">
        {path}:{line}
      </h3>
      <File
        file={{ name: path, contents }}
        disableWorkerPool
        options={options}
        selectedLines={{ start: line, end: line }}
        lineAnnotations={[{ lineNumber: line, metadata: undefined }]}
        renderAnnotation={() => <div data-code-target />}
      />
      <PanelSquiggles path={path} bodyRef={body} />
    </div>
  );
};

export const CodePanel = ({ palette }: { palette: PaletteName }) => {
  const panel = useAtomValue(panelAtom);
  if (panel === null) return null;

  return (
    <aside className="code-panel">
      <button className="code-panel-close" aria-label="Close" onClick={() => registry.set(panelAtom, null)}>
        ×
      </button>
      {panel.kind === 'file' && <SourceFile path={panel.path} line={panel.line} palette={palette} />}
      {panel.kind === 'references' && <References symbol={panel.symbol} locations={panel.locations} />}
      {panel.kind === 'message' && <p className="code-panel-status">{panel.text}</p>}
    </aside>
  );
};
