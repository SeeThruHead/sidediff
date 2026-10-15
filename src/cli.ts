#!/usr/bin/env node
import { NodeRuntime, NodeServices, NodeSocket } from '@effect/platform-node';
import { Console, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema, Stdio, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from 'effect/rpc';
import { createRequire } from 'node:module';

import { Explainer } from './explainer.js';
import { agentIds, initSkill } from './init.js';
import { Git } from './git.js';
import { Notes } from './notes.js';
import {
  type CodeLocation,
  type CodePosition,
  type Diagnostic,
  type HoverInfo,
  type Command as ViewCommand,
  NoteBatch,
  SidediffRpcs,
  Steps,
} from './protocol.js';
import { Repo } from './repo.js';
import { ServerInfo, freePort, serverLayer } from './server.js';

class NoServer extends Schema.TaggedError<NoServer>()('NoServer', { serverFile: Schema.String }) {
  override get message() {
    return 'no sidediff server is running for this repository; start one with `sidediff <range>`';
  }
}

class NotARepository extends Schema.TaggedError<NotARepository>()('NotARepository', { cwd: Schema.String }) {
  override get message() {
    return `${this.cwd} is not inside a git repository; sidediff reviews a git diff, so run it from the repository you want to review`;
  }
}

class BadLocation extends Schema.TaggedError<BadLocation>()('BadLocation', { value: Schema.String }) {
  override get message() {
    return `cannot read location ${this.value}, expected <file>[:line[-end]]`;
  }
}

class BadPosition extends Schema.TaggedError<BadPosition>()('BadPosition', { value: Schema.String }) {
  override get message() {
    return `cannot read position ${this.value}, expected <file>:<line>:<column>`;
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

const section = Command.make('section', { anchor: Argument.String('anchor') }, ({ anchor }) =>
  send({ type: 'section', anchor }),
).pipe(Command.withDescription('open the explainer panel at the element with this id'));

const explainer = Command.make(
  'explainer',
  {
    file: Argument.String('file').pipe(Argument.optional),
    clear: Flag.Boolean('clear').pipe(Flag.withDefault(false)),
  },
  ({ file, clear }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const chosen = Option.map(file, (value) => path.resolve(value));

      if (Option.isNone(chosen) && !clear) return yield* Console.error('pass an HTML file, or --clear to remove it');

      const target = clear ? null : Option.getOrNull(chosen);
      const info = yield* serverOr(
        (client) => client.SetExplainer({ path: target }),
        Explainer.use((current) => current.set(target)).pipe(Effect.provide(Explainer.layer)),
      );

      yield* Console.log(info === null ? 'explainer removed' : `explainer: ${info.title}`);
    }),
).pipe(Command.withDescription('show an HTML explainer beside the diff, or remove it with --clear'));

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

const position = Argument.String('position').pipe(Argument.withDescription('<file>:<line>:<column>'));

const parsePosition = Effect.fnUntraced(function* (value: string): Effect.fn.Return<CodePosition, BadPosition> {
  const match = /^(.+):(\d+):(\d+)$/.exec(value);
  if (match?.[1] === undefined) return yield* new BadPosition({ value });

  return { path: match[1], line: Number(match[2]), offset: Number(match[3]) };
});

const formatLocation = (found: CodeLocation) =>
  `${found.path}:${found.line}:${found.offset}${found.isDefinition ? '  (definition)' : ''}  ${found.preview}`;

const formatHover = (info: HoverInfo) => info.markdown;

const formatDiagnostic = (path: string, found: Diagnostic) =>
  `${path}:${found.line}:${found.column}  ${found.severity}  ${found.source}${found.code === undefined ? '' : `(${found.code})`}  ${found.message}`;

const diagnostics = Command.make(
  'diagnostics',
  {
    path: Argument.String('file'),
    wait: Flag.Int('wait').pipe(Flag.withDefault(20), Flag.withDescription('seconds to let language servers report')),
  },
  ({ path, wait }) =>
    Client.use((client) =>
      client.Diagnostics({ path }).pipe(Stream.interruptWhen(Effect.sleep(Duration.seconds(wait))), Stream.runLast),
    ).pipe(
      Effect.flatMap((last) => {
        const found = Option.getOrElse(last, (): readonly Diagnostic[] => []);
        if (found.length === 0) return Console.log('no problems reported');

        return Effect.forEach(found, (entry) => Console.log(formatDiagnostic(path, entry)), { discard: true });
      }),
      withClient,
    ),
).pipe(Command.withDescription('type errors and lint findings for <file> from every language server that applies'));

const printLocations = (found: readonly CodeLocation[]) =>
  found.length === 0
    ? Console.log('nothing found')
    : Effect.forEach(found, (entry) => Console.log(formatLocation(entry)), { discard: true });

const hover = Command.make('hover', { position }, ({ position }) =>
  parsePosition(position).pipe(
    Effect.flatMap((at) => Client.use((client) => client.Hover(at))),
    Effect.flatMap((info) => Console.log(info === null ? 'no type information here' : formatHover(info))),
    withClient,
  ),
).pipe(Command.withDescription("type information at <file>:<line>:<column>, from the repository's TypeScript"));

const definition = Command.make('definition', { position }, ({ position }) =>
  parsePosition(position).pipe(
    Effect.flatMap((at) => Client.use((client) => client.Definition(at))),
    Effect.flatMap(printLocations),
    withClient,
  ),
).pipe(Command.withDescription('where the symbol at <file>:<line>:<column> is defined'));

const references = Command.make('references', { position }, ({ position }) =>
  parsePosition(position).pipe(
    Effect.flatMap((at) => Client.use((client) => client.References(at))),
    Effect.flatMap(printLocations),
    withClient,
  ),
).pipe(Command.withDescription('every use of the symbol at <file>:<line>:<column>'));

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

const serverOr = <A, E1, E2, R>(
  remote: (client: Context.Service.Shape<typeof Client>) => Effect.Effect<A, E1 | RpcClientError.RpcClientError>,
  local: Effect.Effect<A, E2, R>,
) => Client.use(remote).pipe(withClient, Effect.catchTag(['NoServer', 'RpcClientError'], () => local));

const noteAdd = Command.make(
  'add',
  {
    file: Flag.String('file'),
    newLine: Flag.Int('new-line').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    oldLine: Flag.Int('old-line').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    summary: Flag.String('summary'),
    rationale: optionalText('rationale'),
    author: optionalText('author'),
    explainer: optionalText('explainer'),
  },
  ({ file, newLine, oldLine, summary, rationale, author, explainer }) =>
    Effect.gen(function* () {
      const input = { filePath: file, summary, ...defined({ newLine, oldLine, rationale, author, explainer }) };
      const [note] = yield* serverOr(
        (client) => client.AddNotes({ notes: [input] }),
        Notes.use((notes) => notes.add([input])),
      );

      yield* Console.log(`added ${note?.id} on ${note?.filePath}:${note?.line}`);
    }),
).pipe(Command.withDescription('add one note'));

const noteApply = Command.make('apply', {}, () =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const batch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NoteBatch))(text);
    const inputs = 'comments' in batch ? batch.comments : batch;
    const added = yield* serverOr(
      (client) => client.AddNotes({ notes: inputs }),
      Notes.use((notes) => notes.add(inputs)),
    );

    yield* Console.log(`added ${added.length} notes`);
  }),
).pipe(
  Command.withDescription(
    'add a batch from stdin: {"comments":[{filePath,newLine|oldLine,summary,rationale?,explainer?}]}; explainer is an element id in the explainer page',
  ),
);

const noteList = Command.make(
  'list',
  { json: Flag.Boolean('json').pipe(Flag.withDefault(false)), file: optionalText('file') },
  ({ json, file }) =>
    Effect.gen(function* () {
      const all = yield* serverOr((client) => client.ListNotes(), Notes.use((notes) => notes.list));
      const shown = all.filter((note) => file === undefined || note.filePath === file);

      if (json) return yield* Console.log(JSON.stringify(shown, null, 2));

      yield* Effect.forEach(shown, (note) =>
        Console.log(
          `${note.id}  ${note.filePath}:${note.line}  ${note.summary}${note.explainer === undefined ? '' : `  §${note.explainer}`}`,
        ),
      );
    }),
).pipe(Command.withDescription('list notes'));

const eventLine = (event: {
  readonly seq: number;
  readonly kind: string;
  readonly noteId: string;
  readonly filePath: string;
  readonly line: number;
  readonly author: string;
  readonly body: string;
}) => `${event.seq}\t${event.kind}\t${event.noteId}\t${event.filePath}:${event.line}\t${event.author}: ${event.body}`;

const threads = Command.make(
  'threads',
  {
    after: Flag.Int('after').pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
    wait: Flag.Int('wait').pipe(Flag.withDefault(600)),
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
  },
  ({ after, wait, all }) =>
    Effect.gen(function* () {
      const client = yield* Client;

      const next = yield* client.Threads(after === undefined ? {} : { after }).pipe(
        Stream.map((batch) => batch.filter((event) => all || event.author !== 'agent')),
        Stream.filter((batch) => batch.length > 0),
        Stream.take(1),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(wait)),
        Effect.map(Option.flatten),
      );

      yield* Effect.forEach(Option.getOrElse(next, () => []), (event) => Console.log(eventLine(event)), {
        discard: true,
      });
    }).pipe(withClient),
).pipe(
  Command.withDescription(
    'wait for the next review thread, reply or resolve from the reviewer; prints seq, kind, note id, file:line and text',
  ),
);

const thread = Command.make('thread', { id: Argument.String('id') }, ({ id }) =>
  Effect.gen(function* () {
    const all = yield* serverOr((client) => client.ListNotes(), Notes.use((notes) => notes.list));
    const found = all.find((note) => note.id === id);

    if (found === undefined) return yield* Console.error(`no note ${id}`);

    yield* Console.log(`${found.filePath}:${found.line}${found.resolved === true ? '  (resolved)' : ''}`);
    yield* Console.log(`${found.author}: ${found.summary}`);
    yield* Effect.forEach(found.replies ?? [], (entry) => Console.log(`${entry.author}: ${entry.body}`), {
      discard: true,
    });
  }),
).pipe(Command.withDescription('print a thread: the first comment and every reply'));

const reply = Command.make(
  'reply',
  {
    id: Argument.String('id'),
    text: Argument.String('text').pipe(Argument.variadic({ min: 1 })),
    author: Flag.String('author').pipe(Flag.withDefault('agent')),
  },
  ({ id, text, author }) =>
    Client.use((client) => client.Reply({ noteId: id, body: text.join(' '), author })).pipe(
      Effect.flatMap((note) => Console.log(`replied on ${note.id} (${note.replies?.length ?? 0} replies)`)),
      withClient,
    ),
).pipe(Command.withDescription('reply to a review thread; it appears in the browser immediately'));

const resolve = Command.make(
  'resolve',
  { id: Argument.String('id'), reopen: Flag.Boolean('reopen').pipe(Flag.withDefault(false)) },
  ({ id, reopen }) =>
    Client.use((client) => client.Resolve({ noteId: id, resolved: !reopen, author: 'agent' })).pipe(
      Effect.flatMap((note) => Console.log(`${note.id} ${note.resolved === true ? 'resolved' : 'reopened'}`)),
      withClient,
    ),
).pipe(Command.withDescription('resolve a review thread, or reopen it with --reopen'));

const noteRemove = Command.make('rm', { id: Argument.String('id') }, ({ id }) =>
  Effect.gen(function* () {
    yield* serverOr((client) => client.RemoveNote({ id }), Notes.use((notes) => notes.remove(id)));
    yield* Console.log(`removed ${id}`);
  }),
).pipe(Command.withDescription('remove a note'));

const noteClear = Command.make('clear', { file: optionalText('file') }, ({ file }) =>
  Effect.gen(function* () {
    const count = yield* serverOr(
      (client) => client.ClearNotes(file === undefined ? {} : { filePath: file }),
      Notes.use((notes) => notes.clear(file)),
    );
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

const init = Command.make(
  'init',
  {
    agent: Flag.Literals('agent', agentIds).pipe(
      Flag.atLeast(0),
      Flag.withDescription(`install for this agent; repeatable (${agentIds.join(', ')})`),
    ),
    dir: Flag.String('dir').pipe(Flag.atLeast(0), Flag.withDescription('install into this skills folder; repeatable')),
  },
  ({ agent, dir }) => initSkill(agent, dir),
).pipe(Command.withDescription("install the sidediff skill into your coding agents' skills folders"));

const sidediff = Command.make(
  'sidediff',
  {
    range: Argument.String('range').pipe(Argument.variadic()),
    port: Flag.Int('port').pipe(Flag.withDefault(4977)),
    host: Flag.String('host').pipe(Flag.withDefault('127.0.0.1')),
    open: Flag.Boolean('open').pipe(Flag.withDefault(true)),
    watch: Flag.Boolean('watch').pipe(Flag.withDefault(true)),
    explainer: optionalText('explainer'),
  },
  ({ range, port, host, open, watch, explainer }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repo = yield* Repo;
      if (!repo.inRepo) return yield* new NotARepository({ cwd: repo.root });

      const chosen = yield* freePort(port, host);
      const url = `http://${host}:${chosen}`;
      const page = explainer === undefined ? null : path.resolve(explainer);

      yield* Layer.launch(
        serverLayer({ range, port: chosen, host, watch, explainer: page }).pipe(
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
  Command.withSubcommands([
    init,
    note,
    show,
    highlight,
    explain,
    say,
    clear,
    explainer,
    section,
    tour,
    next,
    back,
    goto,
    where,
    hover,
    definition,
    references,
    diagnostics,
    listen,
    threads,
    thread,
    reply,
    resolve,
  ]),
);

const AppLayer = Notes.layer.pipe(
  Layer.provideMerge(Repo.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

Command.run(sidediff, { version }).pipe(Effect.provide(AppLayer), NodeRuntime.runMain);
