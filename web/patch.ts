export interface Note {
  readonly id: string;
  readonly filePath: string;
  readonly side: 'additions' | 'deletions';
  readonly line: number;
  readonly summary: string;
  readonly rationale?: string;
  readonly author: string;
  readonly createdAt: string;
}

export interface Snapshot {
  readonly repo: string;
  readonly branch: string;
  readonly range: readonly string[];
  readonly patch: string;
  readonly notes: readonly Note[];
  readonly version: string;
  readonly watching: boolean;
  readonly updatedAt: string;
}

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
