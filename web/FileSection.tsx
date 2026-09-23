import { PatchDiff } from '@pierre/diffs/react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { FilePatch, Note } from './patch';
import type { PaletteName } from './themes';
import { diffCss, palettes } from './themes';

interface Placement {
  readonly id: string;
  readonly top: number;
}

const GAP = 8;

const fetchSide = (side: 'old' | 'new', path: string) =>
  fetch(`/api/file?side=${side}&path=${encodeURIComponent(path)}`).then((response) =>
    response.ok ? response.text() : Promise.reject(new Error(`${side} ${path}: ${response.status}`)),
  );

const loadSides = async (file: FilePatch) => {
  const oldPath = file.previousPath ?? file.path;
  const [oldContents, newContents] = await Promise.all([
    fetchSide('old', oldPath),
    fetchSide('new', file.path),
  ]);

  return {
    oldFile: { name: oldPath, contents: oldContents },
    newFile: { name: file.path, contents: newContents },
  };
};

const DiffStat = ({ additions, deletions }: { additions: number; deletions: number }) => {
  const total = additions + deletions;
  const filled = (count: number) => (total === 0 ? 0 : Math.round((count / total) * 5));
  const added = filled(additions);
  const removed = Math.min(5 - added, filled(deletions));

  return (
    <span className="diffstat" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span className="add">+{additions}</span>
      <span className="del">-{deletions}</span>
      <span className="blocks">
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            className={index < added ? 'block add' : index < added + removed ? 'block del' : 'block'}
          />
        ))}
      </span>
    </span>
  );
};

const place = (
  notes: readonly Note[],
  anchorTop: (id: string) => number | null,
  heightOf: (id: string) => number,
): Placement[] =>
  notes
    .map((note, index) => ({ id: note.id, desired: anchorTop(note.id) ?? index * 24 }))
    .toSorted((a, b) => a.desired - b.desired)
    .reduce<Placement[]>((placed, { id, desired }) => {
      const previous = placed.at(-1);
      const floor = previous === undefined ? 0 : previous.top + heightOf(previous.id) + GAP;

      return [...placed, { id, top: Math.max(desired, floor) }];
    }, []);

const NoteCard = ({
  note,
  top,
  active,
  onFocus,
  measureRef,
}: {
  note: Note;
  top: number;
  active: boolean;
  onFocus: (id: string) => void;
  measureRef: (id: string, element: HTMLElement | null) => void;
}) => (
  <article
    ref={(element) => measureRef(note.id, element)}
    className={active ? 'note active' : 'note'}
    style={{ top }}
    onMouseEnter={() => onFocus(note.id)}
    onClick={() => onFocus(note.id)}
  >
    <header>
      <span className="note-author">{note.author}</span>
      <span className="note-line">
        {note.side === 'deletions' ? 'L' : 'R'}
        {note.line}
      </span>
    </header>
    <h4>{note.summary}</h4>
    {note.rationale && note.rationale !== note.summary && <p>{note.rationale}</p>}
  </article>
);

export const FileSection = memo(function FileSection({
  file,
  notes,
  diffStyle,
  palette,
  showNotes,
  collapsed,
  viewed,
  activeNote,
  onToggle,
  onViewed,
  onFocusNote,
}: {
  file: FilePatch;
  notes: readonly Note[];
  diffStyle: 'split' | 'unified';
  palette: PaletteName;
  showNotes: boolean;
  collapsed: boolean;
  viewed: boolean;
  activeNote: string | null;
  onToggle: (path: string) => void;
  onViewed: (file: FilePatch, viewed: boolean) => void;
  onFocusNote: (id: string) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [placements, setPlacements] = useState<readonly Placement[]>([]);

  const lineAnnotations = useMemo(
    () =>
      showNotes
        ? notes.map((note) => ({ side: note.side, lineNumber: note.line, metadata: { id: note.id } }))
        : [],
    [notes, showNotes],
  );

  const measureRef = useCallback((id: string, element: HTMLElement | null) => {
    if (element) cards.current.set(id, element);
    else cards.current.delete(id);
  }, []);

  const layout = useCallback(() => {
    const section = sectionRef.current;
    const column = columnRef.current;
    if (section === null || column === null) return;

    const columnTop = column.getBoundingClientRect().top;
    const anchorTop = (id: string) => {
      const anchor = section.querySelector(`[data-note-anchor="${id}"]`);
      return anchor === null ? null : anchor.getBoundingClientRect().top - columnTop;
    };
    const heightOf = (id: string) => cards.current.get(id)?.offsetHeight ?? 64;
    const next = place(notes, anchorTop, heightOf);

    setPlacements((current) =>
      current.length === next.length &&
      current.every((item, index) => item.id === next[index]?.id && item.top === next[index]?.top)
        ? current
        : next,
    );
  }, [notes]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null || !showNotes || collapsed) return;

    layout();

    const resize = new ResizeObserver(() => layout());
    const mutation = new MutationObserver(() => layout());
    resize.observe(section);
    mutation.observe(section, { childList: true, subtree: true });

    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [layout, showNotes, collapsed]);

  const topOf = (id: string) => placements.find((placement) => placement.id === id)?.top ?? 0;
  const columnHeight = placements.reduce(
    (max, placement) => Math.max(max, placement.top + (cards.current.get(placement.id)?.offsetHeight ?? 64)),
    0,
  );

  return (
    <section ref={sectionRef} className="file" id={`file-${file.path}`}>
      <div className={viewed ? 'file-header viewed' : 'file-header'}>
        <button
          className="chevron"
          aria-label={collapsed ? 'Expand file' : 'Collapse file'}
          onClick={() => onToggle(file.path)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <span className="file-path" onClick={() => onToggle(file.path)}>
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <button
          className="icon-button"
          title="Copy path"
          onClick={() => void navigator.clipboard.writeText(file.path)}
        >
          ⧉
        </button>
        {file.status !== 'modified' && <span className={`badge badge-${file.status}`}>{file.status}</span>}
        <span className="spacer" />
        {notes.length > 0 && <span className="note-count">{notes.length} notes</span>}
        <label className={viewed ? 'viewed-toggle checked' : 'viewed-toggle'}>
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => onViewed(file, event.target.checked)}
          />
          Viewed
        </label>
      </div>
      {!collapsed && (
        <div className={showNotes ? 'file-body with-notes' : 'file-body'}>
          <div className="diff">
            <PatchDiff
              patch={file.patch}
              disableWorkerPool
              options={{
                diffStyle,
                theme: palette,
                themeType: 'dark',
                disableFileHeader: true,
                overflow: 'wrap',
                lineDiffType: 'word-alt',
                diffIndicators: 'classic',
                unsafeCSS: diffCss(palettes[palette]),
                hunkSeparators: 'line-info',
                expansionLineCount: 20,
                loadDiffFiles: () => loadSides(file),
              }}
              lineAnnotations={lineAnnotations}
              renderAnnotation={(annotation) => (
                <div
                  className={annotation.metadata.id === activeNote ? 'anchor active' : 'anchor'}
                  data-note-anchor={annotation.metadata.id}
                  onClick={() => onFocusNote(annotation.metadata.id)}
                />
              )}
            />
          </div>
          {showNotes && (
            <div ref={columnRef} className="notes-column" style={{ minHeight: columnHeight }}>
              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  top={topOf(note.id)}
                  active={note.id === activeNote}
                  onFocus={onFocusNote}
                  measureRef={measureRef}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
