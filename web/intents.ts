export type Intent =
  | { readonly kind: 'next' }
  | { readonly kind: 'back' }
  | { readonly kind: 'close' }
  | { readonly kind: 'scroll'; readonly direction: 1 | -1; readonly amount: 'page' | 'half' }
  | { readonly kind: 'line'; readonly line: number }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'top' };

const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const toNumber = (words: readonly string[]): number | null => {
  const direct = words.find((word) => /^\d+$/.test(word));
  if (direct !== undefined) return Number(direct);

  const values = words.map((word) => numberWords[word]).filter((value): value is number => value !== undefined);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
};

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);

const nameWords = (path: string): string[] =>
  (path.split('/').at(-1) ?? path)
    .replace(/\.(vitest\.)?(test\.)?[a-z]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);

const singular = (word: string) => word.replace(/s$/, '');

const matchFile = (spoken: readonly string[], files: readonly string[]): string | null => {
  const heard = new Set(spoken.map(singular));
  const scored = files
    .filter((path) => !/\.(vitest\.)?test\.|\.stories\./.test(path))
    .map((path) => {
      const name = nameWords(path).map(singular);
      const folders = path.split('/').slice(0, -1).flatMap((part) => part.toLowerCase().split(/[-_.]/)).map(singular);
      const hits = name.filter((word) => heard.has(word)).length;
      const folderHits = folders.filter((word) => heard.has(word)).length;
      return {
        path,
        nameScore: hits === name.length ? hits + 1 : hits,
        score: (hits === name.length ? hits + 1 : hits) * 2 + folderHits,
        size: name.length,
      };
    })
    .filter((entry) => entry.nameScore >= Math.min(2, entry.size))
    .toSorted((a, b) => b.score - a.score || a.size - b.size);

  const best = scored[0]?.path;
  if (best !== undefined) return best;

  const stop = new Set(['open', 'show', 'go', 'to', 'the', 'jump', 'file', 'me', 'a', 'please']);
  const singles = files
    .filter((path) => !/\.(vitest\.)?test\.|\.stories\./.test(path))
    .filter((path) => nameWords(path).map(singular).some((word) => heard.has(word) && !stop.has(word)));

  return singles.length === 1 ? (singles[0] ?? null) : null;
};

const has = (spoken: readonly string[], ...phrase: string[]) =>
  spoken.join(' ').includes(phrase.join(' '));

export const parseIntent = (text: string, files: readonly string[]): Intent | null => {
  const spoken = words(text);
  if (spoken.length === 0 || spoken.length > 8) return null;

  const first = spoken[0];

  if (spoken.length <= 3 && (has(spoken, 'next') || has(spoken, 'move', 'on') || has(spoken, 'continue')))
    return { kind: 'next' };
  if (spoken.length <= 3 && (has(spoken, 'back') || has(spoken, 'previous') || has(spoken, 'go', 'back')))
    return { kind: 'back' };
  if (spoken.length <= 3 && (has(spoken, 'close') || has(spoken, 'dismiss') || has(spoken, 'hide', 'that')))
    return { kind: 'close' };
  if (spoken.length <= 4 && has(spoken, 'scroll', 'down')) return { kind: 'scroll', direction: 1, amount: 'page' };
  if (spoken.length <= 4 && has(spoken, 'scroll', 'up')) return { kind: 'scroll', direction: -1, amount: 'page' };
  if (spoken.length <= 3 && (has(spoken, 'top') || has(spoken, 'beginning'))) return { kind: 'top' };

  if (has(spoken, 'line')) {
    const line = toNumber(spoken.slice(spoken.indexOf('line') + 1));
    if (line !== null) return { kind: 'line', line };
  }

  if (first === 'open' || first === 'show' || has(spoken, 'go', 'to') || first === 'jump') {
    const path = matchFile(spoken, files);
    if (path !== null) return { kind: 'file', path };
  }

  return null;
};
