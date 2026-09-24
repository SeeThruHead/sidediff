import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { branchName, diff, resolveSides, showFile } from './git.js';
import { type Note, readNotes } from './notes.js';

export interface ServeOptions {
  readonly root: string;
  readonly notes: string;
  readonly state: string;
  readonly range: readonly string[];
  readonly port: number;
  readonly host: string;
  readonly watch: boolean;
}

interface Snapshot {
  readonly repo: string;
  readonly branch: string;
  readonly range: readonly string[];
  readonly patch: string;
  readonly notes: readonly Note[];
  readonly version: string;
  readonly watching: boolean;
  readonly updatedAt: string;
}

const webRoot = join(fileURLToPath(new URL('.', import.meta.url)), 'web');

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const ignoredSegments = ['node_modules', 'dist', '.next', '.turbo', '.cache', 'coverage'];

const isRelevantChange = (root: string, file: string | null): boolean => {
  if (file === null) return true;

  const parts = normalize(file).split(sep);
  if (parts.some((part) => ignoredSegments.includes(part))) return false;
  if (parts[0] !== '.git') return true;

  return file.includes('HEAD') || file.includes('refs') || file.endsWith('index');
};

const debounce = (wait: number, fn: () => void) => {
  const timers = new Map<'t', NodeJS.Timeout>();

  return () => {
    const existing = timers.get('t');
    if (existing) clearTimeout(existing);

    timers.set('t', setTimeout(fn, wait));
  };
};

interface Utterance {
  readonly id: number;
  readonly text: string;
  readonly at: string;
  readonly handled: boolean;
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks = await Array.fromAsync(req);
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return text.length === 0 ? {} : (JSON.parse(text) as unknown);
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export const serve = async (options: ServeOptions) => {
  const cells = new Map<'snapshot', Snapshot>();
  const clients = new Set<ServerResponse>();
  const views = new Map<'view', unknown>();
  const utterances: Utterance[] = [];
  const listeners = new Set<(utterance: Utterance) => void>();

  const broadcast = (event: string, data: unknown) =>
    clients.forEach((client) => client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const build = async (): Promise<Snapshot> => {
    const [patch, notes, branch] = await Promise.all([
      diff(options.root, options.range),
      readNotes(options.notes),
      branchName(options.root),
    ]);
    const version = createHash('sha1')
      .update(patch)
      .update(JSON.stringify(notes))
      .digest('hex')
      .slice(0, 12);

    return {
      repo: options.root,
      branch,
      range: options.range,
      patch,
      notes,
      version,
      watching: options.watch,
      updatedAt: new Date().toISOString(),
    };
  };

  const refresh = async () => {
    const next = await build().catch((error: unknown) => {
      process.stderr.write(`sidediff: refresh failed: ${String(error)}\n`);
      return null;
    });
    if (next === null || next.version === cells.get('snapshot')?.version) return;

    cells.set('snapshot', next);

    clients.forEach((client) => client.write(`event: change\ndata: ${next.version}\n\n`));
  };

  cells.set('snapshot', await build());

  const sendFile = async (res: ServerResponse, path: string) => {
    const resolved = normalize(join(webRoot, path));
    if (relative(webRoot, resolved).startsWith('..')) return res.writeHead(404).end();

    const body = await readFile(resolved).catch(() => null);
    if (body === null) return res.writeHead(404).end();

    res.writeHead(200, { 'content-type': contentTypes[extname(resolved)] ?? 'application/octet-stream' });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(cells.get('snapshot')));
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${cells.get('snapshot')?.version ?? ''}\n\n`);

      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/command' && req.method === 'POST') {
      const command = await readBody(req);
      broadcast('command', command);
      return json(res, 200, { delivered: clients.size });
    }

    if (url.pathname === '/api/view') {
      if (req.method === 'POST') {
        views.set('view', await readBody(req));
        return json(res, 200, { ok: true });
      }
      return json(res, 200, views.get('view') ?? null);
    }

    if (url.pathname === '/api/utterance' && req.method === 'POST') {
      const body = (await readBody(req)) as { text?: unknown; handled?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length === 0) return json(res, 400, { error: 'text required' });

      const utterance = {
        id: utterances.length + 1,
        text,
        at: new Date().toISOString(),
        handled: body.handled === true,
      };
      utterances.push(utterance);
      if (!utterance.handled) listeners.forEach((listener) => listener(utterance));
      broadcast('utterance', utterance);
      return json(res, 200, utterance);
    }

    if (url.pathname === '/api/listen') {
      const after = Number(url.searchParams.get('after') ?? utterances.length);
      const waitMs = Math.min(Number(url.searchParams.get('wait') ?? 600) * 1000, 3_600_000);
      const pending = utterances.filter((utterance) => utterance.id > after && !utterance.handled);
      if (pending.length > 0) return json(res, 200, pending);

      const timer = setTimeout(() => {
        listeners.delete(onUtterance);
        json(res, 200, []);
      }, waitMs);
      const onUtterance = (utterance: Utterance) => {
        clearTimeout(timer);
        listeners.delete(onUtterance);
        json(res, 200, [utterance]);
      };
      listeners.add(onUtterance);
      req.on('close', () => {
        clearTimeout(timer);
        listeners.delete(onUtterance);
      });
      return;
    }

    if (url.pathname === '/api/file') {
      const side = url.searchParams.get('side');
      const path = url.searchParams.get('path') ?? '';
      const sides = await resolveSides(options.root, options.range);
      const inside = normalize(join(options.root, path));

      if (path === '' || relative(options.root, inside).startsWith('..')) return res.writeHead(400).end();

      const contents =
        side === 'new' && sides.new === null
          ? await readFile(inside, 'utf8').catch(() => null)
          : await showFile(options.root, side === 'new' ? (sides.new ?? 'HEAD') : sides.old, path).catch(
              () => null,
            );

      if (contents === null) return res.writeHead(404).end();

      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(contents);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('cache-control', 'no-store');
      return sendFile(res, 'index.html');
    }

    return sendFile(res, url.pathname.slice(1));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(`sidediff: ${String(error)}\n`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const scheduleRefresh = debounce(250, () => void refresh());

  await mkdir(options.notes, { recursive: true });

  const watchers: FSWatcher[] = [
    watch(options.notes, () => scheduleRefresh()),
    ...(options.watch
      ? [
          watch(options.root, { recursive: true }, (_event, file) => {
            if (isRelevantChange(options.root, file === null ? null : String(file))) scheduleRefresh();
          }),
        ]
      : []),
  ];

  const heartbeat = setInterval(() => clients.forEach((client) => client.write(': ping\n\n')), 20000);

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve(listen(port + 1)) : reject(error),
      );
      server.listen(port, options.host, () => resolve(port));
    });

  const port = await listen(options.port);
  const stateFile = join(options.state, 'server.json');

  await writeFile(stateFile, JSON.stringify({ port, host: options.host, pid: process.pid }));

  const close = () => {
    void rm(stateFile, { force: true });
    clearInterval(heartbeat);
    watchers.forEach((watcher) => watcher.close());
    clients.forEach((client) => client.end());
    server.close();
  };

  return { port, close };
};
