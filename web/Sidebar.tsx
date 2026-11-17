import { useEffect, useRef, useState } from 'react';

import type { FilePatch, Note } from './patch';
import type { TreeNode } from './tree';
import { type Progress, percent } from './vim/read';

const statusGlyph: Record<FilePatch['status'], string> = {
  added: '+',
  deleted: '−',
  renamed: '→',
  modified: '•',
};

const ReadMeter = ({ progress }: { progress: Progress | undefined }) => {
  if (progress === undefined) return null;
  if (progress.total === 0) return null;

  const shown = percent(progress);
  return (
    <span className={shown === 100 ? 'read-meter done' : 'read-meter'} title={`Read ${progress.read} of ${progress.total} changed lines`}>
      {shown}%
    </span>
  );
};

const Node = ({
  node,
  depth,
  notesByFile,
  isViewed,
  currentFile,
  progressByFile,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  notesByFile: Record<string, readonly Note[]>;
  isViewed: (file: FilePatch) => boolean;
  currentFile: string | null;
  progressByFile: ReadonlyMap<string, Progress>;
  onSelect: (path: string) => void;
}) => {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLButtonElement | null>(null);
  const isCurrent = node.kind === 'file' && node.file.path === currentFile;

  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isCurrent]);
  const indent = { paddingLeft: 8 + depth * 14 };

  if (node.kind === 'file') {
    const notes = notesByFile[node.file.path]?.length ?? 0;

    return (
      <button
        ref={ref}
        aria-current={isCurrent ? 'true' : undefined}
        className={['tree-file', isViewed(node.file) ? 'viewed' : '', isCurrent ? 'current' : ''].join(' ').trim()}
        style={indent}
        title={node.file.path}
        onClick={() => onSelect(node.file.path)}
      >
        <span className={`glyph status-${node.file.status}`}>{statusGlyph[node.file.status]}</span>
        <span className="tree-name">{node.name}</span>
        {notes > 0 && <span className="note-count">{notes}</span>}
        <ReadMeter progress={progressByFile.get(node.file.path)} />
        {isViewed(node.file) && <span className="tick">✓</span>}
      </button>
    );
  }

  return (
    <div>
      <button className="tree-dir" style={indent} onClick={() => setOpen(!open)}>
        <span className="chevron-small">{open ? '▾' : '▸'}</span>
        <span className="folder">▭</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <Node
            key={child.kind === 'file' ? child.file.path : child.path}
            node={child}
            depth={depth + 1}
            notesByFile={notesByFile}
            isViewed={isViewed}
            currentFile={currentFile}
            progressByFile={progressByFile}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
};

export const Sidebar = ({
  tree,
  filter,
  onFilter,
  notesByFile,
  isViewed,
  currentFile,
  progressByFile,
  onSelect,
}: {
  tree: readonly TreeNode[];
  filter: string;
  onFilter: (value: string) => void;
  notesByFile: Record<string, readonly Note[]>;
  isViewed: (file: FilePatch) => boolean;
  currentFile: string | null;
  progressByFile: ReadonlyMap<string, Progress>;
  onSelect: (path: string) => void;
}) => (
  <aside className="sidebar">
    <input
      className="filter"
      placeholder="Filter changed files"
      value={filter}
      onChange={(event) => onFilter(event.target.value)}
    />
    <nav className="tree">
      {tree.map((node) => (
        <Node
          key={node.kind === 'file' ? node.file.path : node.path}
          node={node}
          depth={0}
          notesByFile={notesByFile}
          isViewed={isViewed}
          currentFile={currentFile}
          progressByFile={progressByFile}
          onSelect={onSelect}
        />
      ))}
    </nav>
  </aside>
);
