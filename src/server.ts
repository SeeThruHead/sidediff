import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { branchName, diff } from './git.js';
import { type Note, readNotes } from './notes.js';

export interface ServeOptions {
  readonly root: string;
  readonly notes: string;
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

export const serve = async (options: ServeOptions) => {
  const cells = new Map<'snapshot', Snapshot>();
  const clients = new Set<ServerResponse>();

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

    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(res, 'index.html');

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

  const close = () => {
    clearInterval(heartbeat);
    watchers.forEach((watcher) => watcher.close());
    clients.forEach((client) => client.end());
    server.close();
  };

  return { port, close };
};
