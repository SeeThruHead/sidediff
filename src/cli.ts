#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { gitDir, repoRoot } from './git.js';
import { type NoteInput, addNotes, clearNotes, notesDir, readNotes, removeNote } from './notes.js';
import { serve } from './server.js';

const usage = `sidediff: GitHub-style diff review in the browser, with a live notes column

Usage
  sidediff [git diff args...] [--port 4977] [--host 127.0.0.1] [--no-open] [--no-watch]
  sidediff note add --file <path> (--new-line <n> | --old-line <n>) --summary <text> [--rationale <text>] [--author <name>]
  sidediff note apply --stdin          JSON {"comments":[{filePath,newLine|oldLine,summary,rationale?,author?}]}
  sidediff note list [--json] [--file <path>]
  sidediff note rm <id>
  sidediff note clear [--file <path>]

Drive the open view (needs a running server)
  sidediff show <file>[:line[-end]] [--side old]            scroll there
  sidediff highlight <file>:<a>-<b> [--text <substring>]    select lines, optionally mark text
  sidediff explain <file>:<a>-<b> --title <t> --body <b> [--speak]   zoomed popover with an explanation
  sidediff say <text>                                       show a caption (--speak to also read it aloud)
  sidediff clear                                            remove highlights and popovers
  sidediff tour <steps.json>                                load a guided tour (next/previous in the page)
  sidediff next | back | goto <step>                        move through the loaded tour
  sidediff where                                            what the reader is looking at
  sidediff listen [--after <id>] [--wait <seconds>]         wait for the next thing said into the mic

Examples
  sidediff                        working tree against HEAD
  sidediff origin/main...HEAD     a branch against its base
  sidediff HEAD~1                 the last commit and anything since

Notes live in <git dir>/sidediff/notes, one file per note, and appear in the browser as they are written.
`;

const readStdin = async (): Promise<string> => {
  const chunks = await Array.fromAsync(process.stdin);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
};

const locate = async () => {
  const root = await repoRoot(process.cwd());
  const directory = await gitDir(root);
  return { root, notes: notesDir(directory), state: join(directory, 'sidediff') };
};

const serverUrl = async () => {
  const { state } = await locate();
  const raw = await readFile(join(state, 'server.json'), 'utf8').catch(() => null);
  if (raw === null) throw new Error('no sidediff server is running for this repository; start one with `sidediff <range>`');

  const { port, host } = JSON.parse(raw) as { port: number; host: string };
  return `http://${host}:${port}`;
};

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${await serverUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);

  return response.json() as Promise<unknown>;
};

const parseLocation = (value: string | undefined) => {
  if (value === undefined) throw new Error('expected <file>[:line[-end]]');

  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(value);
  if (match === null) throw new Error(`cannot read location ${value}`);

  const start = match[2] === undefined ? undefined : Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return { file: match[1] ?? value, start, end };
};

const controlOptions = {
  side: { type: 'string' },
  text: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  speak: { type: 'boolean' },
  wait: { type: 'string' },
  after: { type: 'string' },
} as const;

const controlCommand = async (action: string, args: readonly string[]) => {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: controlOptions });
  const side = values.side === 'old' ? 'deletions' : 'additions';

  if (action === 'show' || action === 'highlight' || action === 'explain') {
    const location = parseLocation(positionals[0]);
    const result = await post('/api/command', {
      type: action,
      ...location,
      side,
      text: values.text,
      title: values.title,
      body: values.body ?? positionals.slice(1).join(' '),
      speak: values.speak === true,
    });
    return console.log(JSON.stringify(result));
  }

  if (action === 'say') {
    const text = positionals.join(' ');
    return console.log(JSON.stringify(await post('/api/command', { type: 'say', text, speak: values.speak === true })));
  }

  if (action === 'next' || action === 'back')
    return console.log(JSON.stringify(await post('/api/command', { type: action })));

  if (action === 'goto')
    return console.log(JSON.stringify(await post('/api/command', { type: 'goto', index: Number(positionals[0] ?? 1) - 1 })));

  if (action === 'clear') return console.log(JSON.stringify(await post('/api/command', { type: 'clear' })));

  if (action === 'tour') {
    const path = positionals[0];
    if (path === undefined) throw new Error('tour needs a JSON file of steps');

    const steps = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return console.log(JSON.stringify(await post('/api/command', { type: 'tour', steps })));
  }

  if (action === 'where') {
    const response = await fetch(`${await serverUrl()}/api/view`);
    return console.log(JSON.stringify(await response.json(), null, 2));
  }

  if (action === 'listen') {
    const base = await serverUrl();
    const deadline = Date.now() + Number(values.wait ?? '600') * 1000;
    const poll = async (): Promise<{ id: number; text: string }[]> => {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) return [];

      const response = await fetch(
        `${base}/api/listen?after=${values.after ?? ''}&wait=${Math.min(remaining, 240)}`,
      );
      const heard = (await response.json()) as { id: number; text: string }[];
      return heard.length > 0 ? heard : poll();
    };

    return (await poll()).forEach((utterance) => console.log(`${utterance.id}\t${utterance.text}`));
  }

  throw new Error(`unknown command ${action}`);
};

const noteCommand = async (args: readonly string[]) => {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      'new-line': { type: 'string' },
      'old-line': { type: 'string' },
      summary: { type: 'string' },
      rationale: { type: 'string' },
      author: { type: 'string' },
      stdin: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const { notes } = await locate();

  if (action === 'add') {
    const input: NoteInput = {
      filePath: values.file ?? '',
      newLine: values['new-line'] === undefined ? undefined : Number(values['new-line']),
      oldLine: values['old-line'] === undefined ? undefined : Number(values['old-line']),
      summary: values.summary ?? '',
      rationale: values.rationale,
      author: values.author,
    };
    const [note] = await addNotes(notes, [input]);

    return console.log(`added ${note?.id} on ${note?.filePath}:${note?.line}`);
  }

  if (action === 'apply') {
    if (!values.stdin) throw new Error('note apply reads its batch from --stdin');

    const payload = JSON.parse(await readStdin()) as { comments?: NoteInput[] } | NoteInput[];
    const inputs = Array.isArray(payload) ? payload : (payload.comments ?? []);
    const added = await addNotes(notes, inputs);

    return console.log(`added ${added.length} notes`);
  }

  if (action === 'list') {
    const all = await readNotes(notes);
    const shown = all.filter((note) => values.file === undefined || note.filePath === values.file);

    if (values.json) return console.log(JSON.stringify(shown, null, 2));

    return shown.forEach((note) =>
      console.log(`${note.id}  ${note.filePath}:${note.line}  ${note.summary}`),
    );
  }

  if (action === 'rm') {
    const id = positionals[0];
    if (id === undefined) throw new Error('note rm needs a note id');

    await removeNote(notes, id);
    return console.log(`removed ${id}`);
  }

  if (action === 'clear') {
    const count = await clearNotes(notes, values.file);
    return console.log(`cleared ${count} notes`);
  }

  throw new Error(`unknown note command: ${action ?? '(none)'}\n\n${usage}`);
};

const serveCommand = async (args: readonly string[]) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: 'string', default: '4977' },
      host: { type: 'string', default: '127.0.0.1' },
      'no-open': { type: 'boolean' },
      'no-watch': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) return console.log(usage);

  const { root, notes, state } = await locate();
  const watchMode = values['no-watch'] !== true;
  const server = await serve({
    root,
    notes,
    state,
    range: positionals.map(String),
    port: Number(values.port),
    host: String(values.host),
    watch: watchMode,
  });
  const url = `http://${String(values.host)}:${server.port}`;

  console.log(`sidediff: ${url}  (${watchMode ? 'watching for changes' : 'watch off'})`);

  if (values['no-open'] !== true) {
    const { default: open } = await import('open');
    await open(url);
  }

  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
};

const main = async () => {
  const [first, ...rest] = process.argv.slice(2);

  if (first === 'note') return noteCommand(rest);
  if (first !== undefined && ['show', 'highlight', 'explain', 'say', 'clear', 'tour', 'next', 'back', 'goto', 'where', 'listen'].includes(first))
    return controlCommand(first, rest);

  return serveCommand(first === undefined ? [] : [first, ...rest]);
};

main().catch((error: unknown) => {
  process.stderr.write(`sidediff: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
