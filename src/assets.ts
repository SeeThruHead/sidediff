import { Effect, FileSystem, Path, Schema } from 'effect';
import { createHash } from 'node:crypto';

import { Repo } from './repo.js';

export const ASSET_ROUTE = '/attachments';

export class AssetUnreadable extends Schema.TaggedError<AssetUnreadable>()('AssetUnreadable', {
  file: Schema.String,
}) {
  override get message() {
    return `cannot attach ${this.file}: it could not be read or copied`;
  }
}

const imageExtensions: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export class AssetNotAnImage extends Schema.TaggedError<AssetNotAnImage>()('AssetNotAnImage', {
  file: Schema.String,
}) {
  override get message() {
    return `cannot attach ${this.file}: only ${[...imageExtensions].join(', ')} images can be attached`;
  }
}

const contentName = (bytes: Uint8Array, extension: string) =>
  `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${extension}`;

export const attachImage = Effect.fn('Assets.attachImage')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* Repo;

  const extension = path.extname(file).toLowerCase();
  if (!imageExtensions.has(extension)) return yield* new AssetNotAnImage({ file });

  const unreadable = () => new AssetUnreadable({ file });
  const bytes = yield* fs.readFile(path.resolve(file)).pipe(Effect.mapError(unreadable));
  const name = contentName(bytes, extension);

  yield* fs.makeDirectory(repo.assets, { recursive: true }).pipe(Effect.mapError(unreadable));
  yield* fs.writeFile(path.join(repo.assets, name), bytes).pipe(Effect.mapError(unreadable));

  return `![${path.basename(file)}](${ASSET_ROUTE}/${name})`;
});
