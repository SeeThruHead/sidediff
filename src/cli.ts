#!/usr/bin/env node
import { NodeRuntime, NodeServices, NodeSocket } from '@effect/platform-node';
import { Console, Context, Duration, Effect, FileSystem, Layer, Option, Schema, Stdio, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from 'effect/unstable/rpc';

import { Git } from './git.js';
import { Notes } from './notes.js';
import { type Command as ViewCommand, NoteBatch, SidediffRpcs, Steps } from './protocol.js';
import { Repo } from './repo.js';
import { ServerInfo, freePort, serverLayer } from './server.js';

class NoServer extends Schema.TaggedError<NoServer>()('NoServer', { serverFile: Schema.String }) {
  override get message() {
    return 'no sidediff server is running for this repository; start one with `sidediff <range>`';
  }
}

class BadLocation extends Schema.TaggedError<BadLocation>()('BadLocation', { value: Schema.String }) {
  override get message() {
    return `cannot read location ${this.value}, expected <file>[:line[-end]]`;
  }
}

class Client extends Context.Service<
  Client,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof SidediffRpcs>, RpcClientError.RpcClientError>
>()('sidediff/Client') {
  static readonly layer = Layer.effect(Client, RpcClient.make(SidediffRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { serverFile } = yield* Repo;

          const info = yield* fs.readFileString(serverFile).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerInfo))),
            Effect.mapError(() => new NoServer({ serverFile })),
          );

          return NodeSocket.layerWebSocket(`ws://${info.host}:${info.port}/rpc`);
        }),
      ),
    ),
    Layer.provide(RpcSerialization.layerNdjson),
  );
}

const print = (value: unknown) => Console.log(JSON.stringify(value));

const withClient = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, Client.layer);

const send = (command: ViewCommand) =>
  Client.use((client) => client.Send({ command })).pipe(Effect.flatMap(print), withClient);

const location = Argument.String('location').pipe(Argument.withDescription('<file>[:line[-end]]'));

const parseLocation = (value: string) => {
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(value);
  if (match === null || match[1] === undefined) return Effect.fail(new BadLocation({ value }));

  const start = match[2] === undefined ? undefined : Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);

  return Effect.succeed({
    file: match[1],
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  });
};

const side = Flag.Literals('side', ['old', 'new']).pipe(
  Flag.withDefault('new'),
  Flag.map((value) => (value === 'old' ? ('deletions' as const) : ('additions' as const))),
);

const optionalText = (name: string) => Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

const defined = <A extends Record<string, unknown>>(fields: A) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof A]: Exclude<A[K], undefined>;
  };

const speak = Flag.Boolean('speak').pipe(Flag.withDefault(false));

const show = Command.make('show', { location, side }, ({ location, side }) =>
  Effect.flatMap(parseLocation(location), (target) => send({ type: 'show', ...target, side })),
).pipe(Command.withDescription('scroll the open view to <file>[:line[-end]]'));

const highlight = Command.make(
  'highlight',
  { location, side, text: optionalText('text') },
  ({ location, side, text }) =>
    Effect.flatMap(parseLocation(location), (target) =>
      send({ type: 'highlight', ...target, side, ...defined({ text }) }),
    ),
).pipe(Command.withDescription('select lines, optionally marking a substring'));

const explain = Command.make(
  'explain',
  { location, side, title: optionalText('title'), body: optionalText('body'), speak },
  ({ location, side, title, body, speak }) =>
    Effect.flatMap(parseLocation(location), (target) =>
      send({ type: 'explain', ...target, side, speak, ...defined({ title, body }) }),
    ),
).pipe(Command.withDescription('open a zoomed popover with an explanation'));

const say = Command.make(
  'say',
  { text: Argument.String('text').pipe(Argument.variadic({ min: 1 })), speak },
  ({ text, speak }) => send({ type: 'say', text: text.join(' '), speak }),
).pipe(Command.withDescription('show a caption'));

const clear = Command.make('clear', {}, () => send({ type: 'clear' })).pipe(
  Command.withDescription('remove highlights and popovers'),
);

const tour = Command.make('tour', { steps: Argument.FileSchema('steps', Steps) }, ({ steps }) =>
  send({ type: 'tour', steps }),
).pipe(Command.withDescription('load a guided tour from a JSON file of steps'));

const next = Command.make('next', {}, () => send({ type: 'next' })).pipe(Command.withDescription('next tour step'));

const back = Command.make('back', {}, () => send({ type: 'back' })).pipe(
  Command.withDescription('previous tour step'),
);

const goto = Command.make('goto', { step: Argument.Int('step') }, ({ step }) =>
  send({ type: 'goto', index: step - 1 }),
).pipe(Command.withDescription('jump to tour step <n>'));

const where = Command.make('where', {}, () =>
  Client.use((client) => client.View()).pipe(
    Effect.flatMap((view) => Console.log(JSON.stringify(view, null, 2))),
    withClient,
  ),
).pipe(Command.withDescription('what the reader is looking at'));

const listen = Command.make(
  'listen',
  {
    after: Flag.Int('after').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    wait: Flag.Int('wait').pipe(Flag.withDefault(600)),
  },
  ({ after, wait }) =>
    Effect.gen(function* () {
      const client = yield* Client;

      const heard = yield* client.Listen(after === undefined ? {} : { after }).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(wait)),
        Effect.map(Option.flatten),
      );

      yield* Effect.forEach(Option.getOrElse(heard, () => []), (utterance) =>
        Console.log(`${utterance.id}\t${utterance.text}`),
      );
    }).pipe(withClient),
).pipe(Command.withDescription('wait for the next thing said into the mic'));

const noteAdd = Command.make(
  'add',
  {
    file: Flag.String('file'),
    newLine: Flag.Int('new-line').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    oldLine: Flag.Int('old-line').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    summary: Flag.String('summary'),
    rationale: optionalText('rationale'),
    author: optionalText('author'),
  },
  ({ file, newLine, oldLine, summary, rationale, author }) =>
    Effect.gen(function* () {
      const notes = yield* Notes;
      const [note] = yield* notes.add([
        { filePath: file, summary, ...defined({ newLine, oldLine, rationale, author }) },
      ]);

      yield* Console.log(`added ${note?.id} on ${note?.filePath}:${note?.line}`);
    }),
).pipe(Command.withDescription('add one note'));

const noteApply = Command.make('apply', {}, () =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const notes = yield* Notes;

    const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const batch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NoteBatch))(text);
    const added = yield* notes.add('comments' in batch ? batch.comments : batch);

    yield* Console.log(`added ${added.length} notes`);
  }),
).pipe(Command.withDescription('add a batch from stdin: {"comments":[{filePath,newLine|oldLine,summary,...}]}'));

const noteList = Command.make(
  'list',
  { json: Flag.Boolean('json').pipe(Flag.withDefault(false)), file: optionalText('file') },
  ({ json, file }) =>
    Effect.gen(function* () {
      const notes = yield* Notes;
      const shown = (yield* notes.list).filter((note) => file === undefined || note.filePath === file);

      if (json) return yield* Console.log(JSON.stringify(shown, null, 2));

      yield* Effect.forEach(shown, (note) => Console.log(`${note.id}  ${note.filePath}:${note.line}  ${note.summary}`));
    }),
).pipe(Command.withDescription('list notes'));

const noteRemove = Command.make('rm', { id: Argument.String('id') }, ({ id }) =>
  Effect.gen(function* () {
    const notes = yield* Notes;
    yield* notes.remove(id);
    yield* Console.log(`removed ${id}`);
  }),
).pipe(Command.withDescription('remove a note'));

const noteClear = Command.make('clear', { file: optionalText('file') }, ({ file }) =>
  Effect.gen(function* () {
    const notes = yield* Notes;
    const count = yield* notes.clear(file);
    yield* Console.log(`cleared ${count} notes`);
  }),
).pipe(Command.withDescription('remove every note, or every note on one file'));

const note = Command.make('note').pipe(
  Command.withDescription('notes live in <git dir>/sidediff/notes and appear in the browser as they are written'),
  Command.withSubcommands([noteAdd, noteApply, noteList, noteRemove, noteClear]),
);

const openBrowser = (url: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(
      process.platform === 'darwin'
        ? ChildProcess.make('open', [url])
        : process.platform === 'win32'
          ? ChildProcess.make('cmd', ['/c', 'start', '', url])
          : ChildProcess.make('xdg-open', [url]),
    ),
  ).pipe(Effect.ignore);

const sidediff = Command.make(
  'sidediff',
  {
    range: Argument.String('range').pipe(Argument.variadic()),
    port: Flag.Int('port').pipe(Flag.withDefault(4977)),
    host: Flag.String('host').pipe(Flag.withDefault('127.0.0.1')),
    open: Flag.Boolean('open').pipe(Flag.withDefault(true)),
    watch: Flag.Boolean('watch').pipe(Flag.withDefault(true)),
  },
  ({ range, port, host, open, watch }) =>
    Effect.gen(function* () {
      const chosen = yield* freePort(port, host);
      const url = `http://${host}:${chosen}`;

      yield* Layer.launch(
        serverLayer({ range, port: chosen, host, watch }).pipe(
          Layer.merge(
            Layer.effectDiscard(
              Effect.andThen(
                Console.log(`sidediff: ${url}  (${watch ? 'watching for changes' : 'watch off'})`),
                open ? openBrowser(url) : Effect.void,
              ),
            ),
          ),
        ),
      );
    }),
).pipe(
  Command.withDescription('GitHub-style diff review in the browser, with a live notes column'),
  Command.withSubcommands([note, show, highlight, explain, say, clear, tour, next, back, goto, where, listen]),
);

const AppLayer = Notes.layer.pipe(
  Layer.provideMerge(Repo.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

Command.run(sidediff, { version: '0.2.0' }).pipe(Effect.provide(AppLayer), NodeRuntime.runMain);
