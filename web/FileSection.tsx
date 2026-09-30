import { PatchDiff } from '@pierre/diffs/react';
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { isComment } from '../src/protocol';
import { readFile, replyToThread, resolveThread, startThread, toComment } from './client';
import type { FilePatch, Note } from './patch';
import type { PaletteName } from './themes';
import { diffCss, palettes } from './themes';

interface Placement {
  readonly id: string;
  readonly top: number;
}

const GAP = 8;

const fetchSide = readFile;

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

const COMPOSER = 'composer';

type Composer = { readonly side: 'additions' | 'deletions'; readonly line: number };

type LineMark = {
  side: 'additions' | 'deletions';
  lineNumber: number;
  metadata: { id: string; type: 'anchor' | 'comment' | 'composer' };
};

const place = (
  notes: readonly { readonly id: string }[],
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

const submitOnEnter = (submit: () => void) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key !== 'Enter') return;
  if (event.shiftKey) return;
  if (event.nativeEvent.isComposing) return;

  event.preventDefault();
  submit();
};

const InlineThread = ({ note }: { note: Note }) => {
  const [draft, setDraft] = useState('');
  const replies = note.replies ?? [];
  const send = () => {
    if (draft.trim() === '') return;

    replyToThread(note.id, draft.trim());
    setDraft('');
  };

  return (
    <div className={note.resolved === true ? 'inline-thread resolved' : 'inline-thread'}>
      <div className="comment">
        <span className="comment-author">{note.author}</span>
        <p>{note.summary}</p>
        {note.rationale && note.rationale !== note.summary && <p className="comment-detail">{note.rationale}</p>}
      </div>
      {replies.map((entry) => (
        <div key={entry.id} className="comment">
          <span className="comment-author">{entry.author}</span>
          <p>{entry.body}</p>
        </div>
      ))}
      <textarea
        className="comment-input"
        placeholder="Reply"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={submitOnEnter(send)}
      />
      <div className="comment-actions">
        <button className="primary" disabled={draft.trim() === ''} onClick={send}>
          Reply
        </button>
        <button onClick={() => resolveThread(note.id, note.resolved !== true)}>
          {note.resolved === true ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </div>
  );
};

const InlineComposer = ({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) => {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement | null>(null);
  const submit = () => {
    if (draft.trim() === '') return;

    onSubmit(draft.trim());
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="inline-thread composing">
      <textarea
        ref={input}
        className="comment-input"
        placeholder="Leave a comment"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          submitOnEnter(submit)(event);
        }}
      />
      <div className="comment-actions">
        <button className="primary" disabled={draft.trim() === ''} onClick={submit}>
          Comment
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

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
    <button
      className="annotation-comment"
      onClick={(event) => {
        event.stopPropagation();
        toComment(note.id);
      }}
    >
      Comment
    </button>
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
  selection,
  pinned,
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
  selection: { start: number; end: number; side: 'additions' | 'deletions' } | null;
  pinned: boolean;
  onToggle: (path: string) => void;
  onViewed: (file: FilePatch, viewed: boolean) => void;
  onFocusNote: (id: string) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [placements, setPlacements] = useState<readonly Placement[]>([]);
  const [composer, setComposer] = useState<Composer | null>(null);
  const annotations = useMemo(() => notes.filter((note) => !isComment(note)), [notes]);
  const comments = useMemo(() => notes.filter(isComment), [notes]);
  const [near, setNear] = useState(false);
  const bodyHeight = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mounted = near || pinned;

  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        if (!entry.isIntersecting && bodyRef.current) bodyHeight.current = bodyRef.current.offsetHeight;
        setNear(entry.isIntersecting);
      },
      { root: section.closest('main'), rootMargin: '1800px 0px' },
    );
    observer.observe(section);

    return () => observer.disconnect();
  }, []);

  const estimatedHeight = bodyHeight.current ?? Math.max(80, (file.additions + file.deletions + 12) * 20);

  const diffOptions = useMemo(
    () => ({
      diffStyle,
      theme: palette,
      themeType: 'dark' as const,
      disableFileHeader: true,
      overflow: 'wrap' as const,
      lineDiffType: 'word-alt' as const,
      diffIndicators: 'classic' as const,
      unsafeCSS: diffCss(palettes[palette]),
      hunkSeparators: 'line-info' as const,
      expansionLineCount: 20,
      loadDiffFiles: () => loadSides(file),
      enableGutterUtility: true,
      onGutterUtilityClick: (range: { end: number; side?: 'additions' | 'deletions' }) =>
        setComposer({ side: range.side === 'deletions' ? 'deletions' : 'additions', line: range.end }),
    }),
    [diffStyle, palette, file],
  );

  const composerView =
    composer === null ? null : (
      <InlineComposer
        onCancel={() => setComposer(null)}
        onSubmit={(body) => {
          startThread({ filePath: file.path, side: composer.side, line: composer.line, body });
          setComposer(null);
        }}
      />
    );

  const lineAnnotations = useMemo(
    (): LineMark[] => [
      ...(showNotes
        ? annotations.map((note) => ({
            side: note.side,
            lineNumber: note.line,
            metadata: { id: note.id, type: 'anchor' as const },
          }))
        : []),
      ...comments.map((note) => ({
        side: note.side,
        lineNumber: note.line,
        metadata: { id: note.id, type: 'comment' as const },
      })),
      ...(composer === null
        ? []
        : [{ side: composer.side, lineNumber: composer.line, metadata: { id: COMPOSER, type: 'composer' as const } }]),
    ],
    [annotations, comments, showNotes, composer],
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
    const next = place(annotations, anchorTop, heightOf);

    setPlacements((current) =>
      current.length === next.length &&
      current.every((item, index) => item.id === next[index]?.id && item.top === next[index]?.top)
        ? current
        : next,
    );
  }, [annotations]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null || !showNotes || collapsed || !mounted) return;

    layout();

    const resize = new ResizeObserver(() => layout());
    const mutation = new MutationObserver(() => layout());
    resize.observe(section);
    mutation.observe(section, { childList: true });

    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [layout, showNotes, collapsed, mounted]);

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
        {comments.length > 0 && (
          <span className="note-count">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
        )}
        {annotations.length > 0 && <span className="note-count">{annotations.length} notes</span>}
        <label className={viewed ? 'viewed-toggle checked' : 'viewed-toggle'}>
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => onViewed(file, event.target.checked)}
          />
          Viewed
        </label>
      </div>
      {!collapsed && !mounted && <div className="file-placeholder" style={{ height: estimatedHeight }} />}
      {!collapsed && mounted && (
        <div ref={bodyRef} className={showNotes ? 'file-body with-notes' : 'file-body'}>
          <div className="diff">
            <PatchDiff
              patch={file.patch}
              disableWorkerPool
              options={diffOptions}
              lineAnnotations={lineAnnotations}
              selectedLines={selection}
              renderAnnotation={(annotation) => {
                const { id, type } = annotation.metadata;
                const comment = comments.find((note) => note.id === id);

                if (type === 'composer') return composerView;
                if (type === 'comment') return comment === undefined ? null : <InlineThread note={comment} />;

                return (
                  <div
                    className={id === activeNote ? 'anchor active' : 'anchor'}
                    data-note-anchor={id}
                    onClick={() => onFocusNote(id)}
                  />
                );
              }}
            />
          </div>
          {showNotes && (
            <div ref={columnRef} className="notes-column" style={{ minHeight: columnHeight }}>
              {annotations.map((note) => (
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
