import { File } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef } from 'react';

import { tokenHandlers } from '../code';
import { type PaletteName, diffCss, palettes } from '../themes';
import type { Action } from './actions';
import { fileRow, retryEachFrame, reveal } from './dom';

const REVEAL_TRIES = 30;

export const FileView = ({
  path,
  line,
  contents,
  inDiff,
  palette,
  dispatch,
}: {
  path: string;
  line: number;
  contents: string | null;
  inDiff: boolean;
  palette: PaletteName;
  dispatch: (action: Action) => void;
}) => {
  const body = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (contents === null) return;

    return retryEachFrame(
      () => reveal(fileRow(body.current, line), body.current?.closest('main') ?? null, 'center'),
      REVEAL_TRIES,
    );
  }, [contents, line, path]);

  const options = useMemo(
    () => ({
      theme: palette,
      themeType: 'dark' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
      unsafeCSS: diffCss(palettes[palette]),
      ...tokenHandlers(path),
      onLineClick: (event: { lineNumber: number }) => dispatch({ type: 'gotoLine', line: event.lineNumber }),
    }),
    [palette, path, dispatch],
  );

  return (
    <section className="file whole-file">
      <div className="file-header cursor-host">
        <span className="file-path">{path}</span>
        <span className="file-line">line {line}</span>
        {inDiff && <span className="badge">changed</span>}
        <span className="spacer" />
        <span className="file-hint">
          <kbd>q</kbd> back to the diff · <kbd>Ctrl-o</kbd> previous place
        </span>
      </div>
      <div ref={body} className="file-body">
        {contents === null ? (
          <div className="file-placeholder" style={{ height: 400 }} />
        ) : (
          <File
            file={{ name: path, contents }}
            disableWorkerPool
            options={options}
            selectedLines={{ start: line, end: line }}
          />
        )}
      </div>
    </section>
  );
};
