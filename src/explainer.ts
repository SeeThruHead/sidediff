import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream, SubscriptionRef } from 'effect';

import { ExplainerMissing, type ExplainerInfo, NoteUnsaved } from './protocol.js';
import { Repo } from './repo.js';

const Saved = Schema.Struct({ path: Schema.String });

const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(Saved));

type Current = { readonly path: string; readonly info: ExplainerInfo };

const titleOf = (html: string, fallback: string) => {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  return title === '' ? fallback : title;
};

export class Explainer extends Context.Service<
  Explainer,
  {
    readonly path: Effect.Effect<Option.Option<string>>;
    readonly changes: Stream.Stream<ExplainerInfo | null>;
    readonly set: (path: string | null) => Effect.Effect<ExplainerInfo | null, ExplainerMissing | NoteUnsaved>;
    readonly poll: Effect.Effect<void>;
  }
>()('sidediff/Explainer') {
  static readonly layer = Layer.effect(
    Explainer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { state: directory, explainerFile } = yield* Repo;

      const stamp = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => `${Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })}-${String(info.size)}`),
          Effect.mapError(() => new ExplainerMissing({ path: file })),
        );

      const inspect = (file: string) =>
        Effect.all([stamp(file), fs.readFileString(file)]).pipe(
          Effect.map(([version, html]): Current => ({
            path: file,
            info: { title: titleOf(html, path.basename(file)), version },
          })),
          Effect.mapError(() => new ExplainerMissing({ path: file })),
        );

      const saved = yield* fs.readFileString(explainerFile).pipe(
        Effect.flatMap(decodeSaved),
        Effect.flatMap(({ path: file }) => inspect(file)),
        Effect.option,
      );

      const state = yield* SubscriptionRef.make<Option.Option<Current>>(saved);

      const unsaved = () => new NoteUnsaved({ reason: `cannot save the explainer choice in ${directory}` });

      const persist = (file: string | null) =>
        file === null
          ? fs.remove(explainerFile, { force: true }).pipe(Effect.mapError(unsaved))
          : fs.makeDirectory(directory, { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(explainerFile, JSON.stringify(Schema.encodeSync(Saved)({ path: file })))),
              Effect.mapError(unsaved),
            );

      const set = Effect.fn('Explainer.set')(function* (file: string | null) {
        const next = file === null ? Option.none<Current>() : Option.some(yield* inspect(path.resolve(file)));

        yield* persist(Option.getOrNull(Option.map(next, (current) => current.path)));
        yield* SubscriptionRef.set(state, next);

        return Option.getOrNull(Option.map(next, (current) => current.info));
      });

      const refreshIfChanged = (current: Current) =>
        stamp(current.path).pipe(
          Effect.flatMap((version) =>
            version === current.info.version
              ? Effect.void
              : Effect.flatMap(inspect(current.path), (next) => SubscriptionRef.set(state, Option.some(next))),
          ),
          Effect.ignore,
        );

      const poll = Effect.flatMap(SubscriptionRef.get(state), (current) =>
        Option.match(current, { onNone: () => Effect.void, onSome: refreshIfChanged }),
      );

      return Explainer.of({
        path: Effect.map(SubscriptionRef.get(state), Option.map((current) => current.path)),
        changes: SubscriptionRef.changes(state).pipe(
          Stream.map((current) => Option.getOrNull(Option.map(current, (value) => value.info))),
        ),
        set,
        poll,
      });
    }),
  );
}
