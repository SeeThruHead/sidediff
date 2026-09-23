import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export interface NoteInput {
  readonly filePath: string;
  readonly newLine?: number;
  readonly oldLine?: number;
  readonly summary: string;
  readonly rationale?: string;
  readonly author?: string;
}

export const notesDir = (gitDirectory: string): string => join(gitDirectory, 'sidediff', 'notes');

const isNote = (value: unknown): value is Note =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Note).id === 'string' &&
  typeof (value as Note).filePath === 'string' &&
  typeof (value as Note).line === 'number' &&
  typeof (value as Note).summary === 'string';

export const toNote = (input: NoteInput): Note => {
  const line = input.newLine ?? input.oldLine;

  if (typeof input.filePath !== 'string' || input.filePath.length === 0)
    throw new Error('A note needs a filePath');
  if (typeof input.summary !== 'string' || input.summary.length === 0)
    throw new Error(`A note on ${input.filePath} needs a summary`);
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
    throw new Error(`A note on ${input.filePath} needs a positive newLine or oldLine`);

  return {
    id: randomUUID(),
    filePath: input.filePath,
    side: input.newLine === undefined ? 'deletions' : 'additions',
    line,
    summary: input.summary,
    rationale: input.rationale,
    author: input.author ?? 'agent',
    createdAt: new Date().toISOString(),
  };
};

export const addNotes = async (directory: string, inputs: readonly NoteInput[]): Promise<Note[]> => {
  const notes = inputs.map(toNote);

  await mkdir(directory, { recursive: true });
  await Promise.all(
    notes.map((note) => writeFile(join(directory, `${note.id}.json`), JSON.stringify(note))),
  );

  return notes;
};

export const readNotes = async (directory: string): Promise<Note[]> => {
  const names = await readdir(directory).catch(() => [] as string[]);
  const parsed = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        readFile(join(directory, name), 'utf8')
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null),
      ),
  );

  return parsed
    .filter(isNote)
    .toSorted((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
};

export const removeNote = (directory: string, id: string): Promise<void> =>
  rm(join(directory, `${id}.json`), { force: true });

export const clearNotes = async (directory: string, filePath?: string): Promise<number> => {
  const notes = await readNotes(directory);
  const doomed = notes.filter((note) => filePath === undefined || note.filePath === filePath);

  await Promise.all(doomed.map((note) => removeNote(directory, note.id)));

  return doomed.length;
};
