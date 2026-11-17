import type { Action } from './actions';

const LOCATION = /^(.+?)(?::(\d+))?$/;

const openTarget = (argument: string): Action => {
  const match = LOCATION.exec(argument.trim());
  const path = match?.[1];
  if (path === undefined) return { type: 'message', text: 'Usage: :e path[:line]' };

  return { type: 'open', target: { path, line: match?.[2] === undefined ? null : Number(match[2]) } };
};

const simple: Record<string, Action> = {
  split: { type: 'setStyle', style: 'split' },
  unified: { type: 'setStyle', style: 'unified' },
  notes: { type: 'toggle', what: 'notes' },
  comments: { type: 'toggle', what: 'comments' },
  explainer: { type: 'toggle', what: 'explainer' },
  viewed: { type: 'markViewed', viewed: true },
  unviewed: { type: 'markViewed', viewed: false },
  help: { type: 'openOverlay', overlay: 'help' },
  h: { type: 'openOverlay', overlay: 'help' },
  keys: { type: 'openOverlay', overlay: 'help' },
  q: { type: 'closeFile' },
  close: { type: 'closeFile' },
  comment: { type: 'comment' },
};

export const parseCommand = (input: string): Action | null => {
  const text = input.trim().replace(/^:/, '');
  if (text === '') return null;
  if (/^\d+$/.test(text)) return { type: 'gotoLine', line: Number(text) };

  const [name = '', ...rest] = text.split(/\s+/);
  const argument = text.slice(name.length).trim();
  const known = simple[name];

  if (known !== undefined && rest.length === 0) return known;
  if (name === 'e' || name === 'edit' || name === 'open') return argument === '' ? { type: 'openOverlay', overlay: 'finder' } : openTarget(argument);
  if (name === 'rg' || name === 'grep') return { type: 'openOverlay', overlay: 'grep', text: argument };
  if (name === 'find' || name === 'files') return { type: 'openOverlay', overlay: 'finder', text: argument };
  if (name === 'theme' && argument !== '') return { type: 'theme', name: argument };
  if (name === 's' || name === 'search') return { type: 'openOverlay', overlay: 'search', text: argument };

  return { type: 'message', text: `Not a command: ${text}` };
};

export const commandNames = ['N', 'e path[:line]', 'rg text', 'find text', 'split', 'unified', 'notes', 'comments', 'explainer', 'viewed', 'unviewed', 'theme name', 'comment', 'q', 'help'];
