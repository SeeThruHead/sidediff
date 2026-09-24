import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Random, Schema } from 'effect';

import { Note, type NoteInput } from './protocol.js';
import { Repo } from './repo.js';

export class NoteWithoutLine extends Schema.TaggedError<NoteWithoutLine>()('NoteWithoutLine', {
  filePath: Schema.String,
}) {
  override get message() {
    return `A note on ${this.filePath} needs a positive newLine or oldLine`;
  }
}

export class NotesUnwritable extends Schema.TaggedError<NotesUnwritable>()('NotesUnwritable', {
  directory: Schema.String,
}) {
  override get message() {
    return `cannot write notes in ${this.directory}`;
  }
}

const decodeNote = Schema.decodeUnknownOption(Schema.fromJsonString(Note));

const hex = (value: number) => value.toString(16).padStart(8, '0');

export class Notes extends Context.Service<
  Notes,
  {
    readonly add: (inputs: readonly NoteInput[]) => Effect.Effect<readonly Note[], NoteWithoutLine | NotesUnwritable>;
    readonly list: Effect.Effect<readonly Note[]>;
    readonly remove: (id: string) => Effect.Effect<void, NotesUnwritable>;
    readonly clear: (filePath: string | undefined) => Effect.Effect<number, NotesUnwritable>;
  }
>()('sidediff/Notes') {
  static readonly layer = Layer.effect(
    Notes,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { notes: directory } = yield* Repo;

      const unwritable = () => new NotesUnwritable({ directory });
      const fileOf = (id: string) => path.join(directory, `${id}.json`);

      const newId = Effect.map(
        Effect.all([Random.nextIntBetween(0, 0xffffffff), Random.nextIntBetween(0, 0xffffffff)]),
        ([a, b]) => `${hex(a)}${hex(b)}`,
      );

      const toNote = (input: NoteInput) =>
        Effect.gen(function* () {
          const line = input.newLine ?? input.oldLine;
          if (line === undefined) return yield* new NoteWithoutLine({ filePath: input.filePath });

          const id = yield* newId;
          const now = yield* DateTime.now;

          return {
            id,
            filePath: input.filePath,
            side: input.newLine === undefined ? 'deletions' : 'additions',
            line,
            summary: input.summary,
            ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
            author: input.author ?? 'agent',
            createdAt: DateTime.formatIso(now),
          } satisfies Note;
        });

      const list = Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

        const read = yield* Effect.forEach(
          names.filter((name) => name.endsWith('.json')),
          (name) =>
            fs.readFileString(path.join(directory, name)).pipe(
              Effect.map(decodeNote),
              Effect.orElseSucceed(() => Option.none<Note>()),
            ),
          { concurrency: 16 },
        );

        return read
          .flatMap((note) => (Option.isSome(note) ? [note.value] : []))
          .toSorted((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
      });

      const remove = (id: string) => fs.remove(fileOf(id), { force: true }).pipe(Effect.mapError(unwritable));

      const add = (inputs: readonly NoteInput[]) =>
        Effect.gen(function* () {
          const created = yield* Effect.forEach(inputs, toNote);

          yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unwritable));

          yield* Effect.forEach(
            created,
            (note) => fs.writeFileString(fileOf(note.id), JSON.stringify(note)).pipe(Effect.mapError(unwritable)),
            { concurrency: 16, discard: true },
          );

          return created;
        });

      const clear = (filePath: string | undefined) =>
        Effect.gen(function* () {
          const doomed = (yield* list).filter((note) => filePath === undefined || note.filePath === filePath);

          yield* Effect.forEach(doomed, (note) => remove(note.id), { concurrency: 16, discard: true });

          return doomed.length;
        });

      return { add, list, remove, clear };
    }),
  );
}
