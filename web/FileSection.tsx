import { PatchDiff } from '@pierre/diffs/react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { FilePatch, Note } from './patch';

interface Placement {
  readonly id: string;
  readonly top: number;
}

const GAP = 8;

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
  showNotes,
  collapsed,
  activeNote,
  onToggle,
  onFocusNote,
}: {
  file: FilePatch;
  notes: readonly Note[];
  diffStyle: 'split' | 'unified';
  showNotes: boolean;
  collapsed: boolean;
  activeNote: string | null;
  onToggle: (path: string) => void;
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
      <button className="file-header" onClick={() => onToggle(file.path)}>
        <span className={`status status-${file.status}`}>{file.status[0]?.toUpperCase()}</span>
        <span className="file-path">
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <span className="counts">
          <span className="add">+{file.additions}</span>
          <span className="del">-{file.deletions}</span>
          {notes.length > 0 && <span className="note-count">{notes.length} notes</span>}
        </span>
      </button>
      {!collapsed && (
        <div className={showNotes ? 'file-body with-notes' : 'file-body'}>
          <div className="diff">
            <PatchDiff
              patch={file.patch}
              disableWorkerPool
              options={{
                diffStyle,
                theme: 'pierre-dark',
                themeType: 'dark',
                disableFileHeader: true,
                overflow: 'wrap',
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
