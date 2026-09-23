import { File } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';

import type { Explanation, GuideState } from './guide';
import { type PaletteName, diffCss, palettes } from './themes';

const useFileContents = (explanation: Explanation | null) => {
  const [contents, setContents] = useState<string | null>(null);

  useEffect(() => {
    if (explanation === null) return setContents(null);

    const side = explanation.side === 'deletions' ? 'old' : 'new';
    const controller = new AbortController();
    fetch(`/api/file?side=${side}&path=${encodeURIComponent(explanation.file)}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : null))
      .then(setContents)
      .catch(() => undefined);

    return () => controller.abort();
  }, [explanation]);

  return contents;
};

const Popover = ({
  explanation,
  palette,
  onClose,
}: {
  explanation: Explanation;
  palette: PaletteName;
  onClose: () => void;
}) => {
  const contents = useFileContents(explanation);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const start = explanation.start;
  const end = explanation.end ?? start;

  useEffect(() => {
    if (contents === null || start === undefined) return;

    const scroll = (tries: number) =>
      setTimeout(() => {
        const root = codeRef.current?.querySelector('diffs-container')?.shadowRoot;
        const row = root?.querySelector<HTMLElement>(`[data-line="${start}"]`);
        if (row) row.scrollIntoView({ block: 'center' });
        else if (tries > 0) scroll(tries - 1);
      }, 100);
    scroll(20);
  }, [contents, start]);

  return (
    <div className="guide-backdrop" onClick={onClose}>
      <section className="guide-popover" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <div className="guide-location">
              {explanation.file}
              {start !== undefined && `:${start}${end !== start ? `-${end}` : ''}`}
            </div>
            {explanation.title && <h2>{explanation.title}</h2>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {explanation.body && <p className="guide-body">{explanation.body}</p>}
        <div className="guide-code" ref={codeRef}>
          {contents === null ? (
            <div className="empty">Loading code…</div>
          ) : (
            <File
              file={{ name: explanation.file, contents }}
              disableWorkerPool
              selectedLines={start === undefined ? null : { start, end: end ?? start }}
              options={{
                theme: palette,
                themeType: 'dark',
                disableFileHeader: true,
                overflow: 'wrap',
                unsafeCSS: `${diffCss(palettes[palette])} :host { --diffs-font-size: 15px; --diffs-line-height: 24px; }`,
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
};

export const GuideLayer = ({
  state,
  palette,
  voice,
  onDismiss,
  onStep,
  onEndTour,
  onClearCaption,
}: {
  state: GuideState;
  palette: PaletteName;
  voice: { listening: boolean; interim: string };
  onDismiss: () => void;
  onStep: (index: number) => void;
  onEndTour: () => void;
  onClearCaption: () => void;
}) => (
  <>
    {state.explanation && <Popover explanation={state.explanation} palette={palette} onClose={onDismiss} />}
    {(state.caption || state.tour || (voice.listening && voice.interim)) && (
      <footer className="guide-bar">
        {state.tour && (
          <div className="tour-controls">
            <button disabled={state.tour.index === 0} onClick={() => onStep(state.tour!.index - 1)}>
              ← Back
            </button>
            <span>
              Step {state.tour.index + 1} of {state.tour.steps.length}
            </span>
            <button
              disabled={state.tour.index >= state.tour.steps.length - 1}
              onClick={() => onStep(state.tour!.index + 1)}
            >
              Next →
            </button>
            <button onClick={onEndTour}>End tour</button>
          </div>
        )}
        {state.caption && (
          <div className="caption" onClick={onClearCaption}>
            {state.caption}
          </div>
        )}
        {voice.listening && voice.interim && <div className="interim">🎙 {voice.interim}</div>}
      </footer>
    )}
  </>
);
