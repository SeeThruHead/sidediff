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
