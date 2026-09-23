import { useCallback, useState } from 'react';

import type { FilePatch } from './patch';

const fingerprint = (patch: string): string =>
  Array.from(patch)
    .reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) | 0, 7)
    .toString(36);

const storageKey = (repo: string) => `sidediff:viewed:${repo}`;

const load = (repo: string): Record<string, string> => {
  const raw = localStorage.getItem(storageKey(repo));
  if (raw === null) return {};

  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
};

export const useViewed = (repo: string) => {
  const [marks, setMarks] = useState<Record<string, string>>(() => load(repo));

  const isViewed = useCallback(
    (file: FilePatch) => marks[file.path] === fingerprint(file.patch),
    [marks],
  );

  const setViewed = useCallback(
    (file: FilePatch, viewed: boolean) =>
      setMarks((current) => {
        const next = viewed
          ? { ...current, [file.path]: fingerprint(file.patch) }
          : Object.fromEntries(Object.entries(current).filter(([path]) => path !== file.path));

        localStorage.setItem(storageKey(repo), JSON.stringify(next));
        return next;
      }),
    [repo],
  );

  return { isViewed, setViewed };
};
