import { useCallback, useEffect, useMemo, useState } from 'react';

import { FileSection } from './FileSection';
import { type Note, type Snapshot, splitPatch } from './patch';

const useSnapshot = () => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch('/api/state', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Snapshot>)
        .then(setSnapshot)
        .catch(() => setConnected(false));

    load();

    const events = new EventSource('/api/events');
    events.addEventListener('hello', () => setConnected(true));
    events.addEventListener('change', () => load());
    events.onerror = () => setConnected(false);
    events.onopen = () => setConnected(true);

    return () => events.close();
  }, []);

  return { snapshot, connected };
};

const scrollToAnchor = (id: string) =>
  document
    .querySelector(`[data-note-anchor="${id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });

export const App = () => {
  const { snapshot, connected } = useSnapshot();
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [showNotes, setShowNotes] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const files = useMemo(() => splitPatch(snapshot?.patch ?? ''), [snapshot?.patch]);
  const notesByFile = useMemo(
    () =>
      (snapshot?.notes ?? []).reduce<Record<string, readonly Note[]>>(
        (grouped, note) => ({ ...grouped, [note.filePath]: [...(grouped[note.filePath] ?? []), note] }),
        {},
      ),
    [snapshot?.notes],
  );
  const orderedNotes = useMemo(
    () => files.flatMap((file) => notesByFile[file.path] ?? []),
    [files, notesByFile],
  );
  const visibleFiles = files.filter((file) =>
    file.path.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const toggleFile = useCallback(
    (path: string) =>
      setCollapsed((current) =>
        current.has(path)
          ? new Set([...current].filter((item) => item !== path))
          : new Set([...current, path]),
      ),
    [],
  );

  const focusNote = useCallback((id: string) => setActiveNote(id), []);

  const stepNote = useCallback(
    (direction: 1 | -1) => {
      const index = orderedNotes.findIndex((note) => note.id === activeNote);
      const next = orderedNotes.at((index + direction + orderedNotes.length) % orderedNotes.length);
      if (next === undefined) return;

      setActiveNote(next.id);
      scrollToAnchor(next.id);
    },
    [orderedNotes, activeNote],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.key === 'n') stepNote(1);
      if (event.key === 'p') stepNote(-1);
      if (event.key === 's') setDiffStyle((style) => (style === 'split' ? 'unified' : 'split'));
      if (event.key === 'a') setShowNotes((visible) => !visible);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepNote]);

  if (snapshot === null) return <div className="empty">Loading diff…</div>;

  const totals = files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <strong>{snapshot.repo.split('/').at(-1)}</strong>
          <span className="muted">{snapshot.branch}</span>
          <code>{snapshot.range.length > 0 ? snapshot.range.join(' ') : 'working tree'}</code>
        </div>
        <div className="stats">
          <span>{files.length} files</span>
          <span className="add">+{totals.additions}</span>
          <span className="del">-{totals.deletions}</span>
          <span>{snapshot.notes.length} notes</span>
        </div>
        <div className="controls">
          <button onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}>
            {diffStyle === 'split' ? 'Split' : 'Unified'} <kbd>s</kbd>
          </button>
          <button onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'Notes on' : 'Notes off'} <kbd>a</kbd>
          </button>
          <button onClick={() => stepNote(-1)}>
            Prev note <kbd>p</kbd>
          </button>
          <button onClick={() => stepNote(1)}>
            Next note <kbd>n</kbd>
          </button>
          <span className={connected ? 'live on' : 'live'}>
            {connected ? (snapshot.watching ? 'Live' : 'Connected') : 'Disconnected'}
          </span>
        </div>
      </header>
      <aside className="sidebar">
        <input
          className="filter"
          placeholder="Filter files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <nav>
          {visibleFiles.map((file) => (
            <a key={file.path} href={`#file-${file.path}`} title={file.path}>
              <span className={`status status-${file.status}`}>{file.status[0]?.toUpperCase()}</span>
              <span className="name">{file.path.split('/').at(-1)}</span>
              <span className="dir">{file.path.split('/').slice(0, -1).join('/')}</span>
              {(notesByFile[file.path]?.length ?? 0) > 0 && (
                <span className="note-count">{notesByFile[file.path]?.length}</span>
              )}
            </a>
          ))}
        </nav>
      </aside>
      <main className="files">
        {files.length === 0 && <div className="empty">No changes in this range.</div>}
        {visibleFiles.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            notes={notesByFile[file.path] ?? []}
            diffStyle={diffStyle}
            showNotes={showNotes}
            collapsed={collapsed.has(file.path)}
            activeNote={activeNote}
            onToggle={toggleFile}
            onFocusNote={focusNote}
          />
        ))}
      </main>
    </div>
  );
};
