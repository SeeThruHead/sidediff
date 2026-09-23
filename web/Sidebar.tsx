import { useState } from 'react';

import type { FilePatch, Note } from './patch';
import type { TreeNode } from './tree';

const statusGlyph: Record<FilePatch['status'], string> = {
  added: '+',
  deleted: '−',
  renamed: '→',
  modified: '•',
};

const Node = ({
  node,
  depth,
  notesByFile,
  isViewed,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  notesByFile: Record<string, readonly Note[]>;
  isViewed: (file: FilePatch) => boolean;
  onSelect: (path: string) => void;
}) => {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: 8 + depth * 14 };

  if (node.kind === 'file') {
    const notes = notesByFile[node.file.path]?.length ?? 0;

    return (
      <button
        className={isViewed(node.file) ? 'tree-file viewed' : 'tree-file'}
        style={indent}
        title={node.file.path}
        onClick={() => onSelect(node.file.path)}
      >
        <span className={`glyph status-${node.file.status}`}>{statusGlyph[node.file.status]}</span>
        <span className="tree-name">{node.name}</span>
        {notes > 0 && <span className="note-count">{notes}</span>}
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
  onSelect,
}: {
  tree: readonly TreeNode[];
  filter: string;
  onFilter: (value: string) => void;
  notesByFile: Record<string, readonly Note[]>;
  isViewed: (file: FilePatch) => boolean;
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
          onSelect={onSelect}
        />
      ))}
    </nav>
  </aside>
);
