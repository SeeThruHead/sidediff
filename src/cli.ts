#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
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
  return { root, notes: notesDir(await gitDir(root)) };
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

  const { root, notes } = await locate();
  const watchMode = values['no-watch'] !== true;
  const server = await serve({
    root,
    notes,
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

  return serveCommand(first === undefined ? [] : [first, ...rest]);
};

main().catch((error: unknown) => {
  process.stderr.write(`sidediff: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
