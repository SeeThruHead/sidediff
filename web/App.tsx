import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FileSection } from './FileSection';
import { useGuide } from './guide';
import { GuideLayer } from './GuideLayer';
import { type FilePatch, type Note, type Snapshot, splitPatch } from './patch';
import { Sidebar } from './Sidebar';
import { type PaletteName, palettes, uiVars } from './themes';
import { buildTree, filesInOrder } from './tree';
import { useViewed } from './viewed';
import { parseIntent } from './intents';
import { sendUtterance, useVoice } from './voice';

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

const noNotes: readonly Note[] = [];

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
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [pinnedFile, setPinnedFile] = useState<string | null>(null);

  useEffect(() => {
    const main = document.querySelector('main.files');
    if (main === null) return;

    const frames = new Map<'f', number>();
    const track = () => {
      const top = main.getBoundingClientRect().top;
      const section = [...main.querySelectorAll<HTMLElement>('section.file')].find(
        (item) => item.getBoundingClientRect().bottom > top + 48,
      );
      setCurrentFile(section?.id.replace(/^file-/, '') ?? null);
    };
    const onScroll = () => {
      const pending = frames.get('f');
      if (pending !== undefined) cancelAnimationFrame(pending);
      frames.set('f', requestAnimationFrame(track));
    };

    track();
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, []);

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
    setPinnedFile(path);
    requestAnimationFrame(() =>
      document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'instant', block: 'start' }),
    );
  }, []);

  const openFile = useCallback((path: string) => {
    setOpen(path, true);
    setPinnedFile(path);
  }, []);
  const guide = useGuide(openFile);


  useEffect(() => {
    const main = document.querySelector('main.files');
    if (main === null) return;

    const timers = new Map<'t', ReturnType<typeof setTimeout>>();
    const report = () => {
      const top = main.getBoundingClientRect().top;
      const current = [...main.querySelectorAll<HTMLElement>('section.file')].find(
        (section) => section.getBoundingClientRect().bottom > top + 40,
      );
      void fetch('/api/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: current?.id.replace(/^file-/, '') ?? null,
          activeNote,
          tourStep: guide.state.tour?.index ?? null,
          explaining: guide.state.explanation?.file ?? null,
        }),
      });
    };
    const onScroll = () => {
      const existing = timers.get('t');
      if (existing) clearTimeout(existing);
      timers.set('t', setTimeout(report, 250));
    };

    report();
    main.addEventListener('scroll', onScroll);
    return () => main.removeEventListener('scroll', onScroll);
  }, [activeNote, guide.state.tour?.index, guide.state.explanation]);

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

  const handleSpeech = useCallback(
    (text: string) => {
      const intent = parseIntent(text, allFiles.map((file) => file.path));
      const main = document.querySelector('main.files');
      const tour = guide.state.tour;

      if (intent === null) return void sendUtterance(text, false);
      if ((intent.kind === 'next' || intent.kind === 'back') && tour === null)
        return void sendUtterance(text, false);

      if (intent.kind === 'stop') voiceRef.current?.stop();
      if (intent.kind === 'note') stepNote(intent.direction);
      if (intent.kind === 'layout') setDiffStyle(intent.style);
      if (intent.kind === 'notes') setShowNotes(intent.visible);
      if (intent.kind === 'viewed' || intent.kind === 'expand') {
        const current = [...document.querySelectorAll<HTMLElement>('section.file')].find(
          (section) => section.getBoundingClientRect().bottom > (main?.getBoundingClientRect().top ?? 0) + 40,
        );
        const file = allFiles.find((item) => `file-${item.path}` === current?.id);
        if (file && intent.kind === 'viewed') markViewed(file, intent.value);
        if (current && intent.kind === 'expand')
          current
            .querySelector('diffs-container')
            ?.shadowRoot?.querySelectorAll<HTMLElement>('[data-expand-button]')
            .forEach((button) => {
              const rect = button.getBoundingClientRect();
              if (rect.bottom > 0 && rect.top < window.innerHeight) button.click();
            });
      }
      if (intent.kind === 'next' && tour) guide.goTo(tour.index + 1);
      if (intent.kind === 'back' && tour) guide.goTo(tour.index - 1);
      if (intent.kind === 'close') guide.dismiss();
      if (intent.kind === 'scroll') main?.scrollBy({ top: intent.direction * main.clientHeight * 0.8, behavior: 'instant' });
      if (intent.kind === 'top') main?.scrollTo({ top: 0, behavior: 'instant' });
      if (intent.kind === 'file') {
        guide.dismiss();
        jumpTo(intent.path);
      }
      if (intent.kind === 'line') {
        const current = [...document.querySelectorAll<HTMLElement>('section.file')].find(
          (section) => section.getBoundingClientRect().bottom > (main?.getBoundingClientRect().top ?? 0) + 40,
        );
        const file = current?.id.replace(/^file-/, '');
        if (file) guide.run({ type: 'highlight', file, start: intent.line, end: intent.line, side: 'additions' });
      }

      void sendUtterance(text, true);
    },
    [allFiles, guide, jumpTo, stepNote, markViewed],
  );
  const voice = useVoice(handleSpeech);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useEffect(() => {
    (window as unknown as { sidediffHear?: (text: string) => void }).sidediffHear = handleSpeech;
  }, [handleSpeech]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.key === 'n') stepNote(1);
      if (event.key === 'p') stepNote(-1);
      if (event.key === 's') setDiffStyle((style) => (style === 'split' ? 'unified' : 'split'));
      if (event.key === 'a') setShowNotes((visible) => !visible);
      if (event.key === 'Escape') guide.dismiss();
      if (event.key === ']' && guide.state.tour) guide.goTo(guide.state.tour.index + 1);
      if (event.key === '[' && guide.state.tour) guide.goTo(guide.state.tour.index - 1);
      if (event.key === 'm') (voice.listening ? voice.stop : voice.start)();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepNote, guide, voice]);

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
          {voice.supported && (
            <button className={voice.listening ? 'mic on' : 'mic'} onClick={voice.listening ? voice.stop : voice.start}>
              {voice.listening ? '● Listening' : 'Talk'} <kbd>m</kbd>
            </button>
          )}
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
        currentFile={currentFile}
        onSelect={jumpTo}
      />
      <main className="files">
        {files.length === 0 && <div className="empty">No changes in this range.</div>}
        {visibleFiles.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            notes={notesByFile[file.path] ?? noNotes}
            diffStyle={diffStyle}
            palette={palette}
            showNotes={showNotes}
            collapsed={!isOpen(file)}
            viewed={isViewed(file)}
            activeNote={activeNote}
            pinned={file.path === pinnedFile || guide.state.highlight?.file === file.path}
            selection={
              guide.state.highlight?.file === file.path && guide.state.highlight.start !== undefined
                ? {
                    start: guide.state.highlight.start,
                    end: guide.state.highlight.end ?? guide.state.highlight.start,
                    side: guide.state.highlight.side,
                  }
                : null
            }
            onToggle={toggleFile}
            onViewed={markViewed}
            onFocusNote={focusNote}
          />
        ))}
      </main>
      <GuideLayer
        state={guide.state}
        palette={palette}
        voice={voice}
        onDismiss={guide.dismiss}
        onStep={guide.goTo}
        onEndTour={guide.endTour}
        onClearCaption={() => guide.run({ type: 'say', text: '' })}
      />
    </div>
  );
};
