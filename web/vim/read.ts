import type { ChangedLine, Row, Side } from './model';

export type ReadMarks = Readonly<Record<string, readonly string[]>>;

export type Dwell = ReadonlyMap<string, number>;

export type Seen = { readonly path: string; readonly key: string };

export type Reading = { readonly dwell: Dwell; readonly marks: ReadMarks };

export const READ_AFTER_MS = 1200;

export const MAX_TICK_MS = 1000;

const dwellKey = (seen: Seen) => `${seen.path}\u0000${seen.key}`;

const isRead = (marks: ReadMarks, seen: Seen) => marks[seen.path]?.includes(seen.key) ?? false;

const addMarks = (marks: ReadMarks, finished: readonly Seen[]): ReadMarks =>
  finished.reduce<ReadMarks>(
    (all, seen) => ({ ...all, [seen.path]: [...(all[seen.path] ?? []), seen.key] }),
    marks,
  );

export const tick = (reading: Reading, visible: readonly Seen[], elapsed: number): Reading => {
  const dt = Math.max(0, Math.min(elapsed, MAX_TICK_MS));
  if (dt === 0) return reading;

  const unread = visible.filter((seen) => !isRead(reading.marks, seen));
  if (unread.length === 0) return reading;

  const totals = unread.map((seen) => ({ seen, total: (reading.dwell.get(dwellKey(seen)) ?? 0) + dt }));
  const finished = totals.filter(({ total }) => total >= READ_AFTER_MS).map(({ seen }) => seen);
  const finishedKeys = new Set(finished.map(dwellKey));
  const dwell = new Map([
    ...[...reading.dwell].filter(([key]) => !finishedKeys.has(key)),
    ...totals.filter(({ seen }) => !finishedKeys.has(dwellKey(seen))).map(({ seen, total }) => [dwellKey(seen), total] as const),
  ]);

  return { dwell, marks: finished.length === 0 ? reading.marks : addMarks(reading.marks, finished) };
};

export type FileLines = { readonly path: string; readonly changed: readonly ChangedLine[] };

export const prune = (marks: ReadMarks, files: readonly FileLines[]): ReadMarks =>
  files.reduce<ReadMarks>((all, file) => {
    const current = new Set(file.changed.map((line) => line.key));
    const kept = (all[file.path] ?? []).filter((key) => current.has(key));

    return kept.length === 0
      ? Object.fromEntries(Object.entries(all).filter(([path]) => path !== file.path))
      : { ...all, [file.path]: [...new Set(kept)] };
  }, marks);

export type Progress = { readonly read: number; readonly total: number };

export const fileProgress = (marks: ReadMarks, file: FileLines): Progress => {
  const read = new Set(marks[file.path] ?? []);
  return { read: file.changed.filter((line) => read.has(line.key)).length, total: file.changed.length };
};

export const overallProgress = (marks: ReadMarks, files: readonly FileLines[]): Progress =>
  files
    .map((file) => fileProgress(marks, file))
    .reduce((sum, progress) => ({ read: sum.read + progress.read, total: sum.total + progress.total }), { read: 0, total: 0 });

export const percent = (progress: Progress) =>
  progress.total === 0 ? 100 : Math.floor((progress.read / progress.total) * 100);

const cellKey = (side: Side, line: number) => `${side}:${line}`;

export const unreadLines = (marks: ReadMarks, file: FileLines): readonly ChangedLine[] => {
  const read = new Set(marks[file.path] ?? []);
  return file.changed.filter((line) => !read.has(line.key));
};

export const unreadRowsOf = (rows: readonly Row[], unread: readonly ChangedLine[]): ReadonlySet<number> => {
  const cells = new Set(unread.map((line) => cellKey(line.side, line.line)));
  const isUnread = (row: Row) => {
    if (row.kind !== 'change') return false;
    if (row.additions !== null && cells.has(cellKey('additions', row.additions.line))) return true;
    return row.deletions !== null && cells.has(cellKey('deletions', row.deletions.line));
  };

  return new Set(rows.flatMap((row, index) => (isUnread(row) ? [index] : [])));
};

export const keyLookup = (changed: readonly ChangedLine[]): ReadonlyMap<string, string> =>
  new Map(changed.map((line) => [cellKey(line.side, line.line), line.key]));

export const seenKey = (lookup: ReadonlyMap<string, string>, side: Side, line: number) => lookup.get(cellKey(side, line));
