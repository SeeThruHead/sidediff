import type { Side } from './model';

export type Motion =
  | 'down'
  | 'up'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'halfDown'
  | 'halfUp'
  | 'pageDown'
  | 'pageUp'
  | 'nextHunk'
  | 'prevHunk'
  | 'nextFile'
  | 'prevFile'
  | 'nextUnread'
  | 'prevUnread';

export type OverlayKind = 'finder' | 'grep' | 'command' | 'search' | 'help';

export type Toggle = 'style' | 'notes' | 'comments' | 'explainer' | 'voice';

export type Target = { readonly path: string; readonly line: number | null };

export type Point = { readonly side: Side; readonly line: number };

export type DiffCursor = { readonly path: string; readonly at: Point | null };

export type Action =
  | { readonly type: 'key'; readonly token: string }
  | { readonly type: 'move'; readonly motion: Motion }
  | { readonly type: 'fold'; readonly how: 'open' | 'close' | 'toggle' }
  | { readonly type: 'toggleViewed' }
  | { readonly type: 'openOverlay'; readonly overlay: OverlayKind; readonly text?: string }
  | { readonly type: 'closeOverlay' }
  | { readonly type: 'overlayInput'; readonly text: string }
  | { readonly type: 'overlaySelect'; readonly delta: number }
  | { readonly type: 'submit' }
  | { readonly type: 'open'; readonly target: Target }
  | { readonly type: 'openCurrentFile' }
  | { readonly type: 'gotoLine'; readonly line: number }
  | { readonly type: 'searchNext'; readonly direction: 1 | -1 }
  | { readonly type: 'jumpBack' }
  | { readonly type: 'jumpForward' }
  | { readonly type: 'toggle'; readonly what: Toggle }
  | { readonly type: 'setStyle'; readonly style: 'split' | 'unified' }
  | { readonly type: 'stepNote'; readonly direction: 1 | -1 }
  | { readonly type: 'comment' }
  | { readonly type: 'copyLocation' }
  | { readonly type: 'markViewed'; readonly viewed: boolean }
  | { readonly type: 'theme'; readonly name: string }
  | { readonly type: 'escape' }
  | { readonly type: 'closeFile' }
  | { readonly type: 'select'; readonly cursor: DiffCursor }
  | { readonly type: 'message'; readonly text: string };
