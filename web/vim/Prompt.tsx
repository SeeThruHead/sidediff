import { useAtomValue } from '@effect/atom-react';
import { Cause } from 'effect';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';

import type { SearchHit } from '../../src/protocol';
import { preloadSource, repoFilesAtom, searchRepoAtom } from '../client';
import type { Action, Target } from './actions';
import { commandNames } from './command';
import { type Match, fuzzyFilter } from './fuzzy';
import { useDebounced, useLastDefined } from './hooks';
import { type Binding, helpGroups } from './keys';
import type { Overlay } from './state';

export type PromptRow =
  | { readonly kind: 'file'; readonly match: Match; readonly changed: boolean }
  | { readonly kind: 'hit'; readonly hit: SearchHit };

export type PromptResults = {
  readonly rows: readonly PromptRow[];
  readonly targets: readonly Target[];
  readonly status: string | null;
};

const FINDER_LIMIT = 60;

const MIN_GREP = 2;

const noResults: PromptResults = { rows: [], targets: [], status: null };

const failureText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : 'Search failed';
};

const rankFiles = (query: string, files: readonly string[], changed: ReadonlySet<string>): readonly PromptRow[] => {
  const ordered = [...changed, ...files.filter((path) => !changed.has(path))];
  const boost = (path: string) => (changed.has(path) ? 4 : 0);

  return fuzzyFilter(query, ordered, FINDER_LIMIT * 4)
    .map((match) => ({ match, rank: query === '' ? -ordered.indexOf(match.path) : match.score + boost(match.path) }))
    .toSorted((a, b) => b.rank - a.rank)
    .slice(0, FINDER_LIMIT)
    .map(({ match }) => ({ kind: 'file', match, changed: changed.has(match.path) }));
};

export const usePromptResults = (overlay: Overlay | null, version: string, changed: ReadonlySet<string>): PromptResults => {
  const filesResult = useAtomValue(repoFilesAtom(version));
  const files = useLastDefined(filesResult._tag === 'Success' ? filesResult.value : undefined) ?? [];
  const grepText = overlay?.kind === 'grep' ? overlay.text.trim() : '';
  const query = useDebounced(grepText.length >= MIN_GREP ? grepText : '', 90);
  const searchResult = useAtomValue(searchRepoAtom(query));
  const hits = useLastDefined(searchResult._tag === 'Success' ? searchResult.value : undefined) ?? [];
  const finderText = overlay?.kind === 'finder' ? overlay.text : null;

  const finderRows = useMemo(
    () => (finderText === null ? [] : rankFiles(finderText, files, changed)),
    [finderText, files, changed],
  );

  if (overlay?.kind === 'finder')
    return {
      rows: finderRows,
      targets: finderRows.flatMap((row) => (row.kind === 'file' ? [{ path: row.match.path, line: null }] : [])),
      status: files.length === 0 ? 'Reading the file list' : `${finderRows.length} of ${new Set([...files, ...changed]).size} files`,
    };

  if (overlay?.kind !== 'grep') return noResults;
  if (grepText.length < MIN_GREP) return { ...noResults, status: 'Type at least two characters' };

  const shown = query === '' ? [] : hits;
  const status =
    searchResult._tag === 'Failure'
      ? failureText(searchResult.cause)
      : `${shown.length}${shown.length >= 300 ? '+' : ''} matches`;

  return {
    rows: shown.map((hit) => ({ kind: 'hit', hit })),
    targets: shown.map((hit) => ({ path: hit.path, line: hit.line })),
    status,
  };
};

const Highlighted = ({ text, positions }: { text: string; positions: readonly number[] }) => {
  const marked = new Set(positions);
  return (
    <>
      {Array.from(text).map((char, index) => (marked.has(index) ? <mark key={index}>{char}</mark> : char))}
    </>
  );
};

const withQuery = (text: string, query: string): ReactNode => {
  const at = query === '' ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;

  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
};

const titles: Record<Overlay['kind'], string> = {
  finder: 'Find a file',
  grep: 'Search the repository',
  command: 'Command',
  search: 'Search the diff',
  help: 'Keys',
};

const placeholders: Record<Overlay['kind'], string> = {
  finder: 'File name, letters in order',
  grep: 'Text to find in every file',
  command: 'e path:line · rg text · 42 · split · help',
  search: 'Text in the changed lines',
  help: '',
};

const prefixes: Record<Overlay['kind'], string> = { finder: '›', grep: 'rg', command: ':', search: '/', help: '' };

const ResultRow = ({ row, query, selected, onPick }: { row: PromptRow; query: string; selected: boolean; onPick: () => void }) => {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (row.kind === 'file')
    return (
      <button ref={ref} className={selected ? 'prompt-row selected' : 'prompt-row'} onClick={onPick}>
        <span className="prompt-path">
          <Highlighted text={row.match.path} positions={row.match.positions} />
        </span>
        {row.changed && <span className="badge">changed</span>}
      </button>
    );

  return (
    <button ref={ref} className={selected ? 'prompt-row selected' : 'prompt-row'} onClick={onPick}>
      <span className="prompt-location">
        {row.hit.path}:{row.hit.line}
      </span>
      <code className="prompt-preview">{withQuery(row.hit.text.trim(), query)}</code>
    </button>
  );
};

const mergedHelp = (bindings: readonly Binding[]) =>
  bindings.reduce<readonly { readonly help: string; readonly keys: readonly string[] }[]>((rows, binding) => {
    const sequence = binding.keys.join('');
    const existing = rows.find((row) => row.help === binding.help);
    if (existing === undefined) return [...rows, { help: binding.help, keys: [sequence] }];

    return rows.map((row) => (row === existing ? { ...row, keys: [...row.keys, sequence] } : row));
  }, []);

const Help = () => (
  <div className="help-grid">
    {helpGroups().map(([group, bindings]) => (
      <section key={group}>
        <h4>{group}</h4>
        {mergedHelp(bindings).map((row) => (
          <div key={row.help} className="help-row">
            <span className="help-keys">
              {row.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
            <span>{row.help}</span>
          </div>
        ))}
      </section>
    ))}
    <section>
      <h4>Commands</h4>
      <div className="help-commands">
        {commandNames.map((name) => (
          <code key={name}>:{name}</code>
        ))}
      </div>
      <p className="help-note">A count goes before a motion: 5j, 3]c. Lines on screen long enough count as read.</p>
    </section>
  </div>
);

export const Prompt = ({
  overlay,
  results,
  dispatch,
}: {
  overlay: Overlay;
  results: PromptResults;
  dispatch: (action: Action) => void;
}) => {
  const count = results.rows.length;
  const selected = count === 0 ? -1 : ((overlay.selected % count) + count) % count;
  const highlighted = results.targets[selected];

  useEffect(() => {
    if (highlighted === undefined) return;

    const timer = window.setTimeout(() => preloadSource(highlighted.path), 60);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  return (
    <div className="prompt-backdrop" onMouseDown={() => dispatch({ type: 'closeOverlay' })}>
      <div
        className={overlay.kind === 'help' ? 'prompt help' : 'prompt'}
        role="dialog"
        aria-label={titles[overlay.kind]}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="prompt-title">
          {titles[overlay.kind]}
          {results.status !== null && <span className="prompt-status">{results.status}</span>}
        </div>
        {overlay.kind === 'help' ? (
          <Help />
        ) : (
          <label className="prompt-input">
            <span className="prompt-prefix">{prefixes[overlay.kind]}</span>
            <input
              autoFocus
              spellCheck={false}
              placeholder={placeholders[overlay.kind]}
              value={overlay.text}
              onChange={(event) => dispatch({ type: 'overlayInput', text: event.target.value })}
            />
          </label>
        )}
        {count > 0 && (
          <div className="prompt-results">
            {results.rows.map((row, index) => (
              <ResultRow
                key={row.kind === 'file' ? row.match.path : `${row.hit.path}:${row.hit.line}:${index}`}
                row={row}
                query={overlay.text.trim()}
                selected={index === selected}
                onPick={() => dispatch({ type: 'open', target: results.targets[index] ?? { path: '', line: null } })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
