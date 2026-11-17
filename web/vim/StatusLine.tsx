import type { DiffCursor } from './actions';
import { type Pending, describePending } from './keys';
import { type Progress, percent } from './read';
import type { View } from './state';

const where = (view: View, cursor: DiffCursor | null) => {
  if (view.kind === 'file') return `${view.path}:${view.line}`;
  if (cursor === null) return '';
  if (cursor.at === null) return cursor.path;

  return `${cursor.path}:${cursor.at.side === 'deletions' ? 'L' : 'R'}${cursor.at.line}`;
};

export const StatusLine = ({
  view,
  cursor,
  pending,
  message,
  read,
}: {
  view: View;
  cursor: DiffCursor | null;
  pending: Pending;
  message: string | null;
  read: Progress;
}) => (
  <footer className="statusline">
    <span className="status-mode">{view.kind === 'file' ? 'FILE' : 'DIFF'}</span>
    <span className="status-where">{where(view, cursor)}</span>
    <span className="status-message">{message}</span>
    <span className="status-pending">{describePending(pending)}</span>
    <span className="status-read" title="Changed lines that were on screen long enough to read">
      read {percent(read)}% of changed lines ({read.read}/{read.total})
    </span>
    <span className="status-help">
      <kbd>?</kbd> keys
    </span>
  </footer>
);
