import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...args], { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
};

export const repoRoot = async (cwd: string): Promise<string> =>
  (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();

export const gitDir = async (cwd: string): Promise<string> =>
  (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();

export const branchName = async (cwd: string): Promise<string> =>
  (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();

export const diff = (cwd: string, range: readonly string[]): Promise<string> =>
  git(cwd, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    ...range,
  ]);

export interface Sides {
  readonly old: string;
  readonly new: string | null;
}

export const resolveSides = async (cwd: string, range: readonly string[]): Promise<Sides> => {
  const refs = range.filter((arg) => !arg.startsWith('-'));
  const [first, second] = refs;

  if (first === undefined) return { old: '', new: null };

  if (first.includes('...')) {
    const [base = 'HEAD', head = 'HEAD'] = first.split('...');
    const mergeBase = (await git(cwd, ['merge-base', base || 'HEAD', head || 'HEAD'])).trim();
    return { old: mergeBase, new: head || 'HEAD' };
  }

  if (first.includes('..')) {
    const [base = 'HEAD', head = 'HEAD'] = first.split('..');
    return { old: base || 'HEAD', new: head || 'HEAD' };
  }

  return { old: first, new: second ?? null };
};

export const showFile = (cwd: string, rev: string, path: string): Promise<string> =>
  git(cwd, ['show', `${rev}:${path}`]);
