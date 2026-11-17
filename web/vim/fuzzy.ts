export type Match = { readonly path: string; readonly score: number; readonly positions: readonly number[] };

type Walk = {
  readonly index: number;
  readonly score: number;
  readonly positions: readonly number[];
};

const isBoundary = (text: string, index: number) => {
  if (index === 0) return true;

  return /[/_\-. ]/.test(text[index - 1] ?? '');
};

const step = (text: string, lower: string) => (walk: Walk | null, char: string): Walk | null => {
  if (walk === null) return null;

  const found = lower.indexOf(char, walk.index);
  if (found < 0) return null;

  const previous = walk.positions.at(-1);
  const adjacent = previous !== undefined && previous === found - 1 ? 6 : 0;
  const boundary = isBoundary(text, found) ? 8 : 0;
  const gap = previous === undefined ? 0 : Math.min(found - previous - 1, 6);

  return {
    index: found + 1,
    score: walk.score + 1 + adjacent + boundary - gap,
    positions: [...walk.positions, found],
  };
};

const basenameStart = (path: string) => path.lastIndexOf('/') + 1;

export const fuzzyMatch = (query: string, path: string): Match | null => {
  const needle = query.replace(/\s+/g, '').toLowerCase();
  if (needle === '') return { path, score: 0, positions: [] };

  const lower = path.toLowerCase();
  const walk = Array.from(needle).reduce(step(path, lower), { index: 0, score: 0, positions: [] });
  if (walk === null) return null;

  const inBasename = walk.positions.filter((position) => position >= basenameStart(path)).length;

  return { path, score: walk.score + inBasename * 2 - path.length / 100, positions: walk.positions };
};

export const fuzzyFilter = (query: string, paths: readonly string[], limit: number): readonly Match[] =>
  paths
    .flatMap((path) => {
      const match = fuzzyMatch(query, path);
      return match === null ? [] : [match];
    })
    .toSorted((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit);
