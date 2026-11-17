export type Side = 'additions' | 'deletions';

export type DiffStyle = 'split' | 'unified';

export type Cell = { readonly line: number; readonly text: string };

export type Row = {
  readonly hunk: number;
  readonly kind: 'context' | 'change';
  readonly additions: Cell | null;
  readonly deletions: Cell | null;
};

export type ChangedLine = {
  readonly side: Side;
  readonly line: number;
  readonly text: string;
  readonly hunk: number;
  readonly block: number;
  readonly key: string;
};

type PatchLine = { readonly kind: 'context' | 'addition' | 'deletion'; readonly text: string; readonly hunk: number };

type Numbered = PatchLine & { readonly old: number; readonly new: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type Scan = {
  readonly hunk: number;
  readonly old: number;
  readonly new: number;
  readonly lines: readonly Numbered[];
};

const kindOf = (line: string): PatchLine['kind'] | null => {
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  if (line.startsWith(' ')) return 'context';
  return null;
};

const scanLine = (scan: Scan, line: string): Scan => {
  const header = HUNK_HEADER.exec(line);
  if (header !== null) return { ...scan, hunk: scan.hunk + 1, old: Number(header[1]), new: Number(header[2]) };
  if (scan.hunk < 0) return scan;

  const kind = kindOf(line);
  if (kind === null) return scan;

  const numbered: Numbered = { kind, text: line.slice(1), hunk: scan.hunk, old: scan.old, new: scan.new };

  return {
    ...scan,
    old: kind === 'addition' ? scan.old : scan.old + 1,
    new: kind === 'deletion' ? scan.new : scan.new + 1,
    lines: [...scan.lines, numbered],
  };
};

const bodyOf = (patch: string) => {
  const lines = patch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  return start < 0 ? [] : lines.slice(start);
};

export const patchLines = (patch: string): readonly Numbered[] =>
  bodyOf(patch).reduce(scanLine, { hunk: -1, old: 0, new: 0, lines: [] }).lines;

type Run = { readonly kind: 'context' | 'change'; readonly hunk: number; readonly lines: readonly Numbered[] };

const runsOf = (lines: readonly Numbered[]): readonly Run[] =>
  lines.reduce<readonly Run[]>((runs, line) => {
    const kind = line.kind === 'context' ? 'context' : 'change';
    const last = runs.at(-1);
    const joins = last !== undefined && last.kind === kind && last.hunk === line.hunk && kind === 'change';

    return joins
      ? [...runs.slice(0, -1), { ...last, lines: [...last.lines, line] }]
      : [...runs, { kind, hunk: line.hunk, lines: [line] }];
  }, []);

const cell = (line: number, text: string): Cell => ({ line, text });

const unifiedRows = (lines: readonly Numbered[]): readonly Row[] =>
  lines.map((line) => ({
    hunk: line.hunk,
    kind: line.kind === 'context' ? 'context' : 'change',
    additions: line.kind === 'deletion' ? null : cell(line.new, line.text),
    deletions: line.kind === 'addition' ? null : cell(line.old, line.text),
  }));

const pairedRows = (run: Run): readonly Row[] => {
  const removed = run.lines.filter((line) => line.kind === 'deletion');
  const added = run.lines.filter((line) => line.kind === 'addition');

  return Array.from({ length: Math.max(removed.length, added.length) }, (_, index) => {
    const before = removed[index];
    const after = added[index];

    return {
      hunk: run.hunk,
      kind: 'change' as const,
      additions: after === undefined ? null : cell(after.new, after.text),
      deletions: before === undefined ? null : cell(before.old, before.text),
    };
  });
};

const splitRows = (lines: readonly Numbered[]): readonly Row[] =>
  runsOf(lines).flatMap((run) =>
    run.kind === 'change'
      ? pairedRows(run)
      : run.lines.map((line) => ({
          hunk: line.hunk,
          kind: 'context' as const,
          additions: cell(line.new, line.text),
          deletions: cell(line.old, line.text),
        })),
  );

export const rowsOf = (patch: string, style: DiffStyle): readonly Row[] =>
  style === 'split' ? splitRows(patchLines(patch)) : unifiedRows(patchLines(patch));

export const fingerprint = (text: string): string =>
  Array.from(text)
    .reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) | 0, 7)
    .toString(36);

const occurrenceKeys = (lines: readonly { readonly side: Side; readonly text: string }[]) =>
  lines.reduce<{ readonly seen: ReadonlyMap<string, number>; readonly keys: readonly string[] }>(
    (acc, line) => {
      const base = `${line.side === 'additions' ? '+' : '-'}${fingerprint(line.text)}`;
      const count = acc.seen.get(base) ?? 0;

      return { seen: new Map([...acc.seen, [base, count + 1]]), keys: [...acc.keys, `${base}.${count}`] };
    },
    { seen: new Map(), keys: [] },
  ).keys;

export const changedLinesOf = (patch: string): readonly ChangedLine[] => {
  const runs = runsOf(patchLines(patch));
  const changes = runs.flatMap((run, block) =>
    run.kind === 'change'
      ? run.lines.map((line) => ({
          side: line.kind === 'addition' ? ('additions' as const) : ('deletions' as const),
          line: line.kind === 'addition' ? line.new : line.old,
          text: line.text,
          hunk: line.hunk,
          block,
        }))
      : [],
  );
  const keys = occurrenceKeys(changes);

  return changes.map((change, index) => ({ ...change, key: keys[index] ?? '' }));
};

export const preferredCell = (row: Row, side: Side): { readonly side: Side; readonly line: number } | null => {
  const wanted = row[side];
  if (wanted !== null) return { side, line: wanted.line };

  const other: Side = side === 'additions' ? 'deletions' : 'additions';
  const fallback = row[other];

  return fallback === null ? null : { side: other, line: fallback.line };
};

export const rowText = (row: Row) => [row.additions?.text, row.deletions?.text].filter((text) => text !== undefined);
