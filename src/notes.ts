import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Random, Schema, Stream, SubscriptionRef } from 'effect';

import { Note, type NoteInput, NoteMissing } from './protocol.js';
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

const ordered = (notes: readonly Note[]) =>
  notes.toSorted((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

export class Notes extends Context.Service<
  Notes,
  {
    readonly list: Effect.Effect<readonly Note[]>;
    readonly changes: Stream.Stream<readonly Note[]>;
    readonly add: (inputs: readonly NoteInput[]) => Effect.Effect<readonly Note[], NoteWithoutLine | NotesUnwritable>;
    readonly remove: (id: string) => Effect.Effect<void, NotesUnwritable>;
    readonly clear: (filePath: string | undefined) => Effect.Effect<number, NotesUnwritable>;
    readonly reply: (id: string, author: string, body: string) => Effect.Effect<Note, NoteMissing | NotesUnwritable>;
    readonly resolve: (id: string, resolved: boolean) => Effect.Effect<Note, NoteMissing | NotesUnwritable>;
    readonly toComment: (id: string) => Effect.Effect<Note, NoteMissing | NotesUnwritable>;
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

      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const loaded = yield* Effect.forEach(
        names.filter((name) => name.endsWith('.json')),
        (name) =>
          fs.readFileString(path.join(directory, name)).pipe(
            Effect.map(decodeNote),
            Effect.orElseSucceed(() => Option.none<Note>()),
          ),
        { concurrency: 16 },
      );

      const state = yield* SubscriptionRef.make(
        ordered(loaded.flatMap((note) => (Option.isSome(note) ? [note.value] : []))),
      );

      const write = (note: Note) =>
        fs.makeDirectory(directory, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(fileOf(note.id), JSON.stringify(note))),
          Effect.mapError(unwritable),
        );

      const erase = (id: string) => fs.remove(fileOf(id), { force: true }).pipe(Effect.mapError(unwritable));

      const put = (notes: readonly Note[]) =>
        SubscriptionRef.update(state, (current) =>
          ordered([...current.filter((note) => !notes.some((next) => next.id === note.id)), ...notes]),
        );

      const find = (id: string) =>
        Effect.flatMap(SubscriptionRef.get(state), (current) =>
          Option.match(Option.fromNullishOr(current.find((note) => note.id === id)), {
            onNone: () => Effect.fail(new NoteMissing({ id })),
            onSome: Effect.succeed,
          }),
        );

      const toNote = Effect.fnUntraced(function* (input: NoteInput) {
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
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        } satisfies Note;
      });

      const add = Effect.fn('Notes.add')(function* (inputs: readonly NoteInput[]) {
        const created = yield* Effect.forEach(inputs, toNote);

        yield* Effect.forEach(created, write, { concurrency: 16, discard: true });
        yield* put(created);

        return created;
      });

      const remove = Effect.fn('Notes.remove')(function* (id: string) {
        yield* erase(id);
        yield* SubscriptionRef.update(state, (current) => current.filter((note) => note.id !== id));
      });

      const clear = Effect.fn('Notes.clear')(function* (filePath: string | undefined) {
        const doomed = (yield* SubscriptionRef.get(state)).filter(
          (note) => filePath === undefined || note.filePath === filePath,
        );

        yield* Effect.forEach(doomed, (note) => erase(note.id), { concurrency: 16, discard: true });
        yield* SubscriptionRef.update(state, (current) => current.filter((note) => !doomed.includes(note)));

        return doomed.length;
      });

      const change = Effect.fnUntraced(function* (id: string, edit: (note: Note) => Effect.Effect<Note>) {
        const note = yield* find(id);
        const next = yield* edit(note);

        yield* write(next);
        yield* put([next]);

        return next;
      });

      const reply = (id: string, author: string, body: string) =>
        change(id, (note) =>
          Effect.map(Effect.all([newId, DateTime.now]), ([replyId, now]) => ({
            ...note,
            kind: 'comment' as const,
            replies: [...(note.replies ?? []), { id: replyId, author, body, createdAt: DateTime.formatIso(now) }],
          })),
        );

      const resolve = (id: string, resolved: boolean) => change(id, (note) => Effect.succeed({ ...note, resolved }));

      const toComment = (id: string) => change(id, (note) => Effect.succeed({ ...note, kind: 'comment' as const }));

      return Notes.of({
        list: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        add,
        remove,
        clear,
        reply,
        resolve,
        toComment,
      });
    }),
  );
}
