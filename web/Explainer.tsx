import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { ExplainerInfo, Side } from '../src/protocol';

export type DiffLink = { readonly file: string; readonly line: number | undefined; readonly side: Side };

export type SectionRequest = { readonly anchor: string; readonly nonce: number };

type SectionLinks = { readonly open: (anchor: string) => void; readonly available: boolean };

const ExplainerContext = createContext<SectionLinks>({ open: () => undefined, available: false });

export const ExplainerLinks = ExplainerContext.Provider;

export const MIN_WIDTH = 320;

const sectionLabel = (anchor: string) => anchor.replace(/[-_]+/g, ' ');

export const SectionLink = ({ anchor }: { anchor: string }) => {
  const links = useContext(ExplainerContext);
  if (!links.available) return null;

  return (
    <button
      className="explainer-link"
      title="Open this section of the explainer"
      onClick={(event) => {
        event.stopPropagation();
        links.open(anchor);
      }}
    >
      § {sectionLabel(anchor)}
    </button>
  );
};

const flash = (element: Element) =>
  element.animate(
    [
      { outline: '3px solid #de935f', outlineOffset: '4px' },
      { outline: '3px solid transparent', outlineOffset: '4px' },
    ],
    { duration: 1800, easing: 'ease-out' },
  );

const closestWith = (target: EventTarget | null, selector: string): HTMLElement | null => {
  if (target === null) return null;
  if (!('closest' in target)) return null;

  return (target as Element).closest<HTMLElement>(selector);
};

const diffLinkOf = (element: HTMLElement): DiffLink => ({
  file: element.dataset['file'] ?? '',
  line: element.dataset['line'] === undefined ? undefined : Number(element.dataset['line']),
  side: element.dataset['side'] === 'old' ? 'deletions' : 'additions',
});

const isOutbound = (anchor: HTMLAnchorElement) =>
  anchor.href.startsWith('http') && new URL(anchor.href).origin !== window.location.origin;

const routeClick = (event: MouseEvent, onShow: (link: DiffLink) => void) => {
  const linked = closestWith(event.target, '[data-file]');
  if (linked !== null) {
    event.preventDefault();
    return onShow(diffLinkOf(linked));
  }

  const anchor = closestWith(event.target, 'a[href]') as HTMLAnchorElement | null;
  if (anchor === null) return;
  if (!isOutbound(anchor)) return;

  event.preventDefault();
  window.open(anchor.href, '_blank', 'noopener');
};

const typingTags = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const forwardKey = (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typingTags.has((event.target as Element | null)?.tagName ?? '')) return;

  window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key }));
};

const Resizer =({ onResize, onDragging }: { onResize: (x: number) => void; onDragging: (on: boolean) => void }) => {
  const [dragging, setDragging] = useState(false);
  const toggle = (on: boolean) => {
    setDragging(on);
    onDragging(on);
  };

  return (
    <div
      className={dragging ? 'explainer-resizer dragging' : 'explainer-resizer'}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        toggle(true);
      }}
      onPointerMove={(event) => (dragging ? onResize(event.clientX) : undefined)}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        toggle(false);
      }}
    />
  );
};

export const ExplainerPanel = ({
  info,
  open,
  request,
  onResize,
  onClose,
  onShow,
}: {
  info: ExplainerInfo;
  open: boolean;
  request: SectionRequest | null;
  onResize: (width: number) => void;
  onClose: () => void;
  onShow: (link: DiffLink) => void;
}) => {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const scrolled = useRef(0);
  const pending = useRef<string | null>(null);
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const [dragging, setDragging] = useState(false);

  const reveal = useCallback((anchor: string) => {
    const element = frame.current?.contentDocument?.getElementById(anchor);
    if (element === null || element === undefined) return false;

    element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    flash(element);
    return true;
  }, []);

  useEffect(() => {
    if (request === null) return;
    if (reveal(request.anchor)) return;

    pending.current = request.anchor;
  }, [request, reveal]);

  const onLoad = () => {
    const view = frame.current?.contentWindow;
    if (view === null || view === undefined) return;

    view.document.addEventListener('click', (event) => routeClick(event, (link) => onShowRef.current(link)));
    view.document.addEventListener('keydown', forwardKey);
    view.addEventListener('scroll', () => (scrolled.current = view.scrollY), { passive: true });

    const anchor = pending.current;
    pending.current = null;
    if (anchor !== null && reveal(anchor)) return;

    view.scrollTo({ top: scrolled.current });
  };

  return (
    <aside className={dragging ? 'explainer dragging' : 'explainer'} hidden={!open}>
      <header className="explainer-head">
        <strong title={info.title}>{info.title}</strong>
        <span className="explainer-actions">
          <a href="/explainer" target="_blank" rel="noopener">
            Open in tab ↗
          </a>
          <button onClick={onClose} title="Hide the explainer">
            Hide <kbd>e</kbd>
          </button>
        </span>
      </header>
      <iframe ref={frame} title={info.title} src={`/explainer?v=${info.version}`} onLoad={onLoad} />
      <Resizer onResize={onResize} onDragging={setDragging} />
    </aside>
  );
};
