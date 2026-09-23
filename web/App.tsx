import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { FileSection } from './FileSection';
import { type FilePatch, type Note, type Snapshot, splitPatch } from './patch';
import { Sidebar } from './Sidebar';
import { type PaletteName, palettes, uiVars } from './themes';
import { buildTree, filesInOrder } from './tree';
import { useViewed } from './viewed';

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

const savedPalette = (): PaletteName => {
  const stored = localStorage.getItem('sidediff:palette');
  return stored !== null && stored in palettes ? (stored as PaletteName) : 'base16-tomorrow-night-eighties';
};

export const App = () => {
  const { snapshot, connected } = useSnapshot();

  if (snapshot === null) return <div className="empty">Loading diff…</div>;

  return <Review snapshot={snapshot} connected={connected} />;
};

const Review = ({ snapshot, connected }: { snapshot: Snapshot; connected: boolean }) => {
  const [palette, setPalette] = useState<PaletteName>(savedPalette);
  const { isViewed, setViewed } = useViewed(snapshot.repo);
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [showNotes, setShowNotes] = useState(true);
  const [openOverrides, setOpenOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const allFiles = useMemo(() => splitPatch(snapshot.patch), [snapshot.patch]);
  const tree = useMemo(
    () =>
      buildTree(
        allFiles.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase())),
      ),
    [allFiles, filter],
  );
  const files = useMemo(() => filesInOrder(buildTree(allFiles)), [allFiles]);
  const visibleFiles = useMemo(() => filesInOrder(tree), [tree]);
  const notesByFile = useMemo(
    () =>
      snapshot.notes.reduce<Record<string, readonly Note[]>>(
        (grouped, note) => ({ ...grouped, [note.filePath]: [...(grouped[note.filePath] ?? []), note] }),
        {},
      ),
    [snapshot.notes],
  );
  const orderedNotes = useMemo(
    () => files.flatMap((file) => notesByFile[file.path] ?? []),
    [files, notesByFile],
  );

  const isOpen = useCallback(
    (file: FilePatch) => openOverrides.get(file.path) ?? !isViewed(file),
    [openOverrides, isViewed],
  );

  const setOpen = (path: string, open: boolean) =>
    setOpenOverrides((current) => new Map([...current, [path, open]]));

  const toggleFile = useCallback(
    (path: string) => {
      const file = allFiles.find((item) => item.path === path);
      if (file !== undefined) setOpen(path, !isOpen(file));
    },
    [allFiles, isOpen],
  );

  const focusNote = useCallback((id: string) => setActiveNote(id), []);

  const markViewed = useCallback(
    (file: FilePatch, viewed: boolean) => {
      setViewed(file, viewed);
      setOpenOverrides(
        (current) => new Map([...current].filter(([path]) => path !== file.path)),
      );
    },
    [setViewed],
  );

  const jumpTo = useCallback((path: string) => {
    setOpen(path, true);
    requestAnimationFrame(() =>
      document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const choosePalette = (next: PaletteName) => {
    localStorage.setItem('sidediff:palette', next);
    setPalette(next);
  };

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

  const viewedCount = files.filter(isViewed).length;
  const totals = files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="app" style={uiVars(palettes[palette]) as React.CSSProperties}>
      <header className="topbar">
        <div className="title">
          <strong>{snapshot.repo.split('/').at(-1)}</strong>
          <span className="branch">{snapshot.branch}</span>
          <code>{snapshot.range.length > 0 ? snapshot.range.join(' ') : 'working tree'}</code>
        </div>
        <span className={connected ? 'live on' : 'live'}>
          {connected ? (snapshot.watching ? 'Watching' : 'Connected') : 'Disconnected'}
        </span>
      </header>
      <div className="toolbar">
        <div className="tabs">
          <span className="tab active">
            Files changed <span className="counter">{files.length}</span>
          </span>
          <span className="tab">
            Notes <span className="counter">{snapshot.notes.length}</span>
          </span>
        </div>
        <div className="summary">
          <span className="add">+{totals.additions}</span>
          <span className="del">−{totals.deletions}</span>
        </div>
        <div className="progress" title="Files marked as viewed">
          <span>
            {viewedCount} / {files.length} files viewed
          </span>
          <span className="bar">
            <span style={{ width: `${files.length === 0 ? 0 : (viewedCount / files.length) * 100}%` }} />
          </span>
        </div>
        <div className="controls">
          <div className="segmented">
            <button className={diffStyle === 'split' ? 'on' : ''} onClick={() => setDiffStyle('split')}>
              Split
            </button>
            <button
              className={diffStyle === 'unified' ? 'on' : ''}
              onClick={() => setDiffStyle('unified')}
            >
              Unified
            </button>
          </div>
          <button onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'Hide notes' : 'Show notes'} <kbd>a</kbd>
          </button>
          <button onClick={() => stepNote(-1)}>
            ↑ <kbd>p</kbd>
          </button>
          <button onClick={() => stepNote(1)}>
            ↓ <kbd>n</kbd>
          </button>
          <select value={palette} onChange={(event) => choosePalette(event.target.value as PaletteName)}>
            {Object.keys(palettes).map((name) => (
              <option key={name} value={name}>
                {name.replace('base16-', '')}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Sidebar
        tree={tree}
        filter={filter}
        onFilter={setFilter}
        notesByFile={notesByFile}
        isViewed={isViewed}
        onSelect={jumpTo}
      />
      <main className="files">
        {files.length === 0 && <div className="empty">No changes in this range.</div>}
        {visibleFiles.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            notes={notesByFile[file.path] ?? []}
            diffStyle={diffStyle}
            palette={palette}
            showNotes={showNotes}
            collapsed={!isOpen(file)}
            viewed={isViewed(file)}
            activeNote={activeNote}
            onToggle={toggleFile}
            onViewed={markViewed}
            onFocusNote={focusNote}
          />
        ))}
      </main>
    </div>
  );
};
