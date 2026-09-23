import type { FilePatch } from './patch';

export interface TreeDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface TreeFile {
  readonly kind: 'file';
  readonly name: string;
  readonly file: FilePatch;
}

export type TreeNode = TreeDirectory | TreeFile;

interface Branch {
  readonly directories: ReadonlyMap<string, Branch>;
  readonly files: readonly FilePatch[];
}

const emptyBranch: Branch = { directories: new Map(), files: [] };

const insert = (branch: Branch, segments: readonly string[], file: FilePatch): Branch => {
  const [head, ...rest] = segments;
  if (head === undefined || rest.length === 0) return { ...branch, files: [...branch.files, file] };

  const child = branch.directories.get(head) ?? emptyBranch;

  return {
    ...branch,
    directories: new Map([...branch.directories, [head, insert(child, rest, file)]]),
  };
};

const toNodes = (branch: Branch, prefix: string): TreeNode[] => [
  ...[...branch.directories.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => compact(name, child, prefix === '' ? name : `${prefix}/${name}`)),
  ...branch.files
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .map((file): TreeFile => ({ kind: 'file', name: file.path.split('/').at(-1) ?? file.path, file })),
];

const compact = (name: string, branch: Branch, path: string): TreeDirectory => {
  const only = branch.files.length === 0 && branch.directories.size === 1 ? [...branch.directories][0] : undefined;
  if (only !== undefined) return compact(`${name}/${only[0]}`, only[1], `${path}/${only[0]}`);

  return { kind: 'directory', name, path, children: toNodes(branch, path) };
};

export const buildTree = (files: readonly FilePatch[]): TreeNode[] =>
  toNodes(
    files.reduce((branch, file) => insert(branch, file.path.split('/'), file), emptyBranch),
    '',
  );

export const filesInOrder = (nodes: readonly TreeNode[]): FilePatch[] =>
  nodes.flatMap((node) => (node.kind === 'file' ? [node.file] : filesInOrder(node.children)));
