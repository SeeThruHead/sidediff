import { createHash } from 'node:crypto';

import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect';

import { Explainer } from './explainer.js';
import { Git } from './git.js';
import { Notes } from './notes.js';
import {
  type Command,
  FileMissing,
  type Note,
  NoteUnsaved,
  type NoteMissing,
  type Side,
  type Snapshot,
  type ThreadEvent,
  type Utterance,
  type View,
  type Working,
} from './protocol.js';
import { Repo } from './repo.js';

export class ServeOptions extends Context.Service<
  ServeOptions,
  {
    readonly range: readonly string[];
    readonly port: number;
    readonly host: string;
    readonly watch: boolean;
    readonly explainer: string | null;
  }
>()('sidediff/ServeOptions') {}

const ignoredSegments = new Set(['node_modules', 'dist', '.next', '.turbo', '.cache', 'coverage']);

const isRelevant = (file: string) => {
  const parts = file.split('/');
  if (parts.some((part) => ignoredSegments.has(part))) return false;
  if (parts[0] !== '.git') return true;

  return isGitStateChange(file);
};

const isGitStateChange = (file: string) =>
  file.includes('HEAD') || file.includes('refs') || file.endsWith('index');

const AGENT = 'agent';

const WORKING_LIMIT = Duration.minutes(15);

const awaitsAgent = (event: ThreadEvent) =>
  event.author !== AGENT && event.kind !== 'resolved' && event.kind !== 'reopened';

const versionOf = (patch: string, notes: unknown) =>
  createHash('sha1').update(patch).update(JSON.stringify(notes)).digest('hex').slice(0, 12);

export class Review extends Context.Service<
  Review,
  {
    readonly snapshots: Stream.Stream<Snapshot>;
    readonly file: (side: 'old' | 'new', path: string) => Effect.Effect<string, FileMissing>;
    readonly source: (path: string) => Effect.Effect<string, FileMissing>;
    readonly send: (command: Command) => Effect.Effect<number>;
    readonly commands: Stream.Stream<Command>;
    readonly reportView: (view: View) => Effect.Effect<void>;
    readonly view: Effect.Effect<View | null>;
    readonly utter: (text: string, handled: boolean) => Effect.Effect<Utterance>;
    readonly listen: (after: number | undefined) => Stream.Stream<readonly Utterance[]>;
    readonly startThread: (input: {
      readonly filePath: string;
      readonly side: Side;
      readonly line: number;
      readonly body: string;
    }) => Effect.Effect<Note, NoteUnsaved>;
    readonly reply: (id: string, body: string, author: string | undefined) => Effect.Effect<Note, NoteMissing | NoteUnsaved>;
    readonly resolve: (id: string, resolved: boolean, author: string | undefined) => Effect.Effect<Note, NoteMissing | NoteUnsaved>;
    readonly threads: (after: number | undefined) => Stream.Stream<readonly ThreadEvent[]>;
    readonly toComment: (id: string) => Effect.Effect<Note, NoteMissing | NoteUnsaved>;
    readonly refresh: Effect.Effect<void>;
    readonly setWorking: (noteId: string, status: string | undefined, done: boolean) => Effect.Effect<void>;
  }
>()('sidediff/Review') {
  static readonly layer = Layer.effect(
    Review,
    Effect.gen(function* () {
      const git = yield* Git;
      const notes = yield* Notes;
      const repo = yield* Repo;
      const options = yield* ServeOptions;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const explainer = yield* Explainer;

      if (options.explainer !== null) {
        yield* explainer
          .set(options.explainer)
          .pipe(Effect.catch((error) => Effect.logWarning('[explainer] not loaded', error.message)));
      }

      yield* explainer.poll.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1))), Effect.forkScoped);

      const readPatch = Effect.map(
        Effect.all([git.diff(repo.root, options.range), git.branch(repo.root)], { concurrency: 'unbounded' }),
        ([patch, branch]) => ({ patch, branch }),
      );

      const diff = yield* SubscriptionRef.make(yield* readPatch);

      const refresh = readPatch.pipe(
        Effect.flatMap((next) =>
          SubscriptionRef.update(diff, (current) => (current.patch === next.patch ? current : next)),
        ),
        Effect.catch((error) => Effect.logWarning('[refresh] diff failed', error)),
      );

      const working = yield* SubscriptionRef.make<readonly Working[]>([]);

      const startWorking = (noteId: string, status: string | undefined) =>
        Effect.flatMap(DateTime.now, (now) =>
          SubscriptionRef.update(working, (current) => {
            const existing = current.find((entry) => entry.noteId === noteId);
            const since = existing?.since ?? DateTime.formatIso(now);
            const entry: Working = status === undefined ? { noteId, since } : { noteId, since, status };

            return [...current.filter((other) => other.noteId !== noteId), entry];
          }),
        );

      const stopWorking = (noteId: string) =>
        SubscriptionRef.update(working, (current) =>
          current.some((entry) => entry.noteId === noteId) ? current.filter((entry) => entry.noteId !== noteId) : current,
        );

      const setWorking = (noteId: string, status: string | undefined, done: boolean) =>
        done ? stopWorking(noteId) : startWorking(noteId, status);

      const isFresh = (now: DateTime.Utc) => (entry: Working) =>
        DateTime.toEpochMillis(now) - Date.parse(entry.since) < Duration.toMillis(WORKING_LIMIT);

      yield* DateTime.now.pipe(
        Effect.flatMap((now) =>
          SubscriptionRef.update(working, (current) =>
            current.every(isFresh(now)) ? current : current.filter(isFresh(now)),
          ),
        ),
        Effect.repeat(Schedule.spaced(Duration.seconds(30))),
        Effect.forkScoped,
      );

      const snapshots = Stream.zipLatestAll(
        SubscriptionRef.changes(diff),
        notes.changes,
        explainer.changes,
        SubscriptionRef.changes(working),
      ).pipe(
        Stream.mapEffect(([{ patch, branch }, current, explaining, busy]) =>
          Effect.map(
            DateTime.now,
            (now): Snapshot => ({
              repo: repo.root,
              branch,
              range: options.range,
              patch,
              notes: current,
              version: versionOf(patch, [current, explaining, busy]),
              diffVersion: versionOf(patch, []),
              watching: options.watch,
              updatedAt: DateTime.formatIso(now),
              explainer: explaining,
              working: busy,
            }),
          ),
        ),
      );

      if (options.watch) {
        const gitDir = yield* git.gitDir(repo.root).pipe(Effect.option);
        const gitDirOutsideWorktree = Option.filter(gitDir, (dir) =>
          path.relative(repo.root, dir).startsWith('..'),
        );

        const worktreeChanges = fs.watch(repo.root, { recursive: true }).pipe(
          Stream.filter((event) => isRelevant(event.path)),
        );
        const linkedWorktreeCommits = Option.match(gitDirOutsideWorktree, {
          onNone: () => Stream.empty,
          onSome: (dir) =>
            fs.watch(dir, { recursive: true }).pipe(Stream.filter((event) => isGitStateChange(event.path))),
        });

        yield* Stream.merge(worktreeChanges, linkedWorktreeCommits).pipe(
          Stream.debounce(Duration.millis(250)),
          Stream.runForEach(() => refresh),
          Effect.catch((error) => Effect.logWarning('[watch] stopped', error)),
          Effect.forkScoped,
        );
      }

      const commands = yield* PubSub.unbounded<Command>();
      const watchers = yield* Ref.make(0);
      const views = yield* Ref.make<View | null>(null);
      const heard = yield* Ref.make<readonly Utterance[]>([]);
      const spoken = yield* PubSub.unbounded<Utterance>();

      const file = (side: 'old' | 'new', relative: string) =>
        Effect.gen(function* () {
          const missing = new FileMissing({ side, path: relative });
          const inside = path.join(repo.root, relative);
          if (path.relative(repo.root, inside).startsWith('..')) return yield* missing;

          const sides = yield* git.sides(repo.root, options.range).pipe(Effect.mapError(() => missing));

          return side === 'new' && sides.new === null
            ? yield* fs.readFileString(inside).pipe(Effect.mapError(() => missing))
            : yield* git
                .show(repo.root, side === 'new' ? (sides.new ?? 'HEAD') : sides.old, relative)
                .pipe(Effect.mapError(() => missing));
        });

      const onDisk = (relative: string) => {
        const missing = new FileMissing({ side: 'new', path: relative });
        const inside = path.join(repo.root, relative);
        if (path.relative(repo.root, inside).startsWith('..')) return Effect.fail(missing);

        return fs.readFileString(inside).pipe(Effect.mapError(() => missing));
      };

      const source = (relative: string) => file('new', relative).pipe(Effect.catch(() => onDisk(relative)));

      const utter = (text: string, handled: boolean) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;

          const utterance = yield* Ref.modify(heard, (all) => {
            const next = { id: all.length + 1, text: text.trim(), at: DateTime.formatIso(now), handled };
            return [next, [...all, next]];
          });

          if (!handled) yield* PubSub.publish(spoken, utterance);

          return utterance;
        });

      const listen = (after: number | undefined) =>
        Stream.unwrap(
          Effect.map(Ref.get(heard), (all) => {
            const since = after ?? all.length;
            const pending = all.filter((utterance) => utterance.id > since && !utterance.handled);
            const live = Stream.fromPubSub(spoken).pipe(
              Stream.filter((utterance) => utterance.id > since),
              Stream.map((utterance) => [utterance]),
            );

            return pending.length > 0 ? Stream.concat(Stream.make(pending), live) : live;
          }),
        );

      const reviewer = yield* git.run(repo.root, ['config', 'user.name']).pipe(
        Effect.map((name) => name.trim()),
        Effect.map((name) => (name === '' ? 'reviewer' : name)),
        Effect.orElseSucceed(() => 'reviewer'),
      );

      const events = yield* Ref.make<readonly ThreadEvent[]>([]);
      const threadEvents = yield* PubSub.unbounded<ThreadEvent>();

      const unsaved = (error: { readonly message: string }) => new NoteUnsaved({ reason: error.message });

      const record = Effect.fnUntraced(function* (
        kind: ThreadEvent['kind'],
        note: Note,
        author: string,
        body: string,
      ) {
        const now = yield* DateTime.now;
        const event = yield* Ref.modify(events, (all) => {
          const next: ThreadEvent = {
            seq: all.length + 1,
            kind,
            noteId: note.id,
            filePath: note.filePath,
            side: note.side,
            line: note.line,
            author,
            body,
            at: DateTime.formatIso(now),
          };
          return [next, [...all, next]];
        });

        yield* PubSub.publish(threadEvents, event);

        return note;
      });

      const startThread = Effect.fn('Review.startThread')(function* (input: {
        readonly filePath: string;
        readonly side: Side;
        readonly line: number;
        readonly body: string;
      }) {
        const lineKey = input.side === 'deletions' ? { oldLine: input.line } : { newLine: input.line };
        const [note] = yield* notes
          .add([{ filePath: input.filePath, ...lineKey, summary: input.body, author: reviewer, kind: 'comment' }])
          .pipe(Effect.mapError(unsaved));

        if (note === undefined) return yield* new NoteUnsaved({ reason: 'the thread was not created' });

        return yield* record('thread', note, reviewer, input.body);
      });

      const reply = Effect.fn('Review.reply')(function* (id: string, body: string, author: string | undefined) {
        const who = author ?? reviewer;
        const note = yield* notes.reply(id, who, body).pipe(Effect.catchTag('NotesUnwritable', (error) => Effect.fail(unsaved(error))));
        if (who === AGENT) yield* stopWorking(id);

        return yield* record('reply', note, who, body);
      });

      const resolve = Effect.fn('Review.resolve')(function* (id: string, resolved: boolean, author: string | undefined) {
        const who = author ?? reviewer;
        const note = yield* notes.resolve(id, resolved).pipe(Effect.catchTag('NotesUnwritable', (error) => Effect.fail(unsaved(error))));
        yield* stopWorking(id);

        return yield* record(resolved ? 'resolved' : 'reopened', note, who, '');
      });

      const toComment = Effect.fn('Review.toComment')(function* (id: string) {
        const note = yield* notes
          .toComment(id)
          .pipe(Effect.catchTag('NotesUnwritable', (error) => Effect.fail(unsaved(error))));

        return yield* record('converted', note, reviewer, note.summary);
      });

      const threads = (after: number | undefined) =>
        Stream.unwrap(
          Effect.map(Ref.get(events), (all) => {
            const since = after ?? all.length;
            const pending = all.filter((event) => event.seq > since);
            const live = Stream.fromPubSub(threadEvents).pipe(
              Stream.filter((event) => event.seq > since),
              Stream.map((event) => [event]),
            );

            const delivered = pending.length > 0 ? Stream.concat(Stream.make(pending), live) : live;

            return delivered.pipe(
              Stream.tap((batch) =>
                Effect.forEach(batch.filter(awaitsAgent), (event) => startWorking(event.noteId, undefined), {
                  discard: true,
                }),
              ),
            );
          }),
        );

      return {
        setWorking,
        toComment,
        refresh,
        startThread,
        reply,
        resolve,
        threads,
        snapshots,
        file,
        source,
        send: (command) => Effect.andThen(PubSub.publish(commands, command), Ref.get(watchers)),

        commands: Stream.unwrap(
          Effect.as(
            Ref.update(watchers, (count) => count + 1),
            Stream.fromPubSub(commands).pipe(Stream.ensuring(Ref.update(watchers, (count) => count - 1))),
          ),
        ),

        reportView: (view) => Ref.set(views, view),
        view: Ref.get(views),
        utter,
        listen,
      };
    }),
  );
}
