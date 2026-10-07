export type { Note, Snapshot } from '../src/protocol';

export interface FilePatch {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: 'added' | 'deleted' | 'renamed' | 'modified';
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
}

const headerPath = (header: string): { path: string; previousPath: string } => {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);

  return { previousPath: match?.[1] ?? header, path: match?.[2] ?? header };
};

const toFilePatch = (chunk: string): FilePatch => {
  const lines = chunk.split('\n');
  const { path, previousPath } = headerPath(lines[0] ?? '');
  const body = lines.filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
  const status = lines.some((line) => line.startsWith('new file mode'))
    ? 'added'
    : lines.some((line) => line.startsWith('deleted file mode'))
      ? 'deleted'
      : lines.some((line) => line.startsWith('rename from'))
        ? 'renamed'
        : 'modified';

  return {
    path,
    previousPath: status === 'renamed' ? previousPath : null,
    status,
    patch: chunk,
    additions: body.filter((line) => line.startsWith('+')).length,
    deletions: body.filter((line) => line.startsWith('-')).length,
  };
};

export const splitPatch = (patch: string): FilePatch[] =>
  patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => toFilePatch(chunk.endsWith('\n') ? chunk : `${chunk}\n`));

type HunkRange = { readonly start: number; readonly count: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const rangeOf = (start: string | undefined, count: string | undefined): HunkRange => ({
  start: Number(start ?? 0),
  count: count === undefined ? 1 : Number(count),
});

const hunkRanges = (patch: string) =>
  patch
    .split('\n')
    .map((line) => HUNK_HEADER.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      deletions: rangeOf(match[1], match[2]),
      additions: rangeOf(match[3], match[4]),
    }));

const contains = (range: HunkRange, line: number) => line >= range.start && line < range.start + range.count;

export const isLineInDiff = (patch: string, side: 'additions' | 'deletions', line: number) =>
  hunkRanges(patch).some((hunk) => contains(hunk[side], line));
