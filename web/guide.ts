import { useCallback, useEffect, useRef, useState } from 'react';

export type Side = 'additions' | 'deletions';

export interface Target {
  readonly file: string;
  readonly start?: number;
  readonly end?: number;
  readonly side: Side;
  readonly text?: string;
}

export interface Explanation extends Target {
  readonly title?: string;
  readonly body?: string;
}

export type Step =
  | ({ readonly type: 'show' } & Target)
  | ({ readonly type: 'highlight' } & Target)
  | ({ readonly type: 'explain'; readonly speak?: boolean } & Explanation)
  | { readonly type: 'say'; readonly text: string; readonly speak?: boolean }
  | { readonly type: 'clear' };

export type Command = Step | { readonly type: 'tour'; readonly steps: readonly Step[] };

export interface GuideState {
  readonly highlight: Target | null;
  readonly explanation: Explanation | null;
  readonly caption: string | null;
  readonly tour: { readonly steps: readonly Step[]; readonly index: number } | null;
}

const initial: GuideState = { highlight: null, explanation: null, caption: null, tour: null };

const speak = (text: string) => {
  if (!('speechSynthesis' in window) || text.trim().length === 0) return;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
};

const shadowRootOf = (file: string): ShadowRoot | null =>
  document.getElementById(`file-${file}`)?.querySelector('diffs-container')?.shadowRoot ?? null;

export const lineRows = (target: Target): HTMLElement[] => {
  const root = shadowRootOf(target.file);
  if (root === null || target.start === undefined) return [];

  const end = target.end ?? target.start;
  const code =
    root.querySelector(`code[data-${target.side}]`) ?? root.querySelector('code[data-unified]') ?? root;

  return Array.from({ length: end - target.start + 1 }, (_, offset) => target.start! + offset).flatMap(
    (line) => {
      const row = code.querySelector<HTMLElement>(`[data-line="${line}"]`);
      return row === null ? [] : [row];
    },
  );
};

const textRanges = (rows: readonly HTMLElement[], needle: string): Range[] =>
  rows.flatMap((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const nodes = Array.from({ length: 10_000 }, () => walker.nextNode()).filter(
      (node): node is Text => node instanceof Text,
    );

    return nodes.flatMap((node) => {
      const text = node.data;
      const starts = Array.from(text.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')));

      return starts.map((match) => {
        const range = new Range();
        range.setStart(node, match.index ?? 0);
        range.setEnd(node, (match.index ?? 0) + needle.length);
        return range;
      });
    });
  });

export const applyTextHighlight = (target: Target | null) => {
  if (!('highlights' in CSS)) return;

  if (target === null || target.text === undefined || target.text.length === 0) {
    CSS.highlights.delete('sidediff-text');
    return;
  }

  const ranges = textRanges(lineRows(target), target.text);
  CSS.highlights.set('sidediff-text', new Highlight(...ranges));
};

const flash = (rows: readonly HTMLElement[]) => {
  rows.forEach((row) => row.removeAttribute('data-sidediff-flash'));
  requestAnimationFrame(() => rows.forEach((row) => row.setAttribute('data-sidediff-flash', '')));
};

export const scrollToTarget = (target: Target) => {
  const rows = lineRows(target);
  const first = rows[0];

  if (first !== undefined) {
    first.scrollIntoView({ behavior: 'instant', block: 'center' });
    flash(rows);
    return true;
  }

  document.getElementById(`file-${target.file}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
  return false;
};

const contents = new Map<string, Promise<string | null>>();

export const fileContents = (file: string, side: Side): Promise<string | null> => {
  const key = `${side}:${file}`;
  const cached = contents.get(key);
  if (cached !== undefined) return cached;

  const request = fetch(`/api/file?side=${side === 'deletions' ? 'old' : 'new'}&path=${encodeURIComponent(file)}`)
    .then((response) => (response.ok ? response.text() : null))
    .catch(() => null);
  contents.set(key, request);
  return request;
};

export const clearFileCache = () => contents.clear();

export const useGuide = (openFile: (path: string) => void) => {
  const [state, setState] = useState<GuideState>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  const focus = useCallback(
    (target: Target) => {
      openFile(target.file);
      const attempt = (tries: number) =>
        requestAnimationFrame(() => {
          const found = scrollToTarget(target);
          applyTextHighlight(stateRef.current.highlight);
          if (!found && tries > 0) setTimeout(() => attempt(tries - 1), 150);
        });
      attempt(20);
    },
    [openFile],
  );

  const runStep = useCallback(
    (step: Step) => {
      if (step.type === 'clear') {
        applyTextHighlight(null);
        window.speechSynthesis?.cancel();
        return setState((current) => ({ ...initial, tour: current.tour }));
      }

      if (step.type === 'say') {
        if (step.speak) speak(step.text);
        return setState((current) => ({ ...current, caption: step.text }));
      }

      if (step.type === 'show') {
        setState((current) => ({ ...current, explanation: null }));
        return focus(step);
      }

      if (step.type === 'highlight') {
        setState((current) => ({ ...current, highlight: step, explanation: null }));
        return focus(step);
      }

      setState((current) => ({
        ...current,
        highlight: step,
        explanation: step,
        caption: step.speak ? (step.body ?? null) : current.caption,
      }));
      if (step.speak) speak([step.title, step.body].filter(Boolean).join('. '));
      return focus(step);
    },
    [focus],
  );

  const goTo = useCallback(
    (index: number) => {
      const tour = stateRef.current.tour;
      const step = tour?.steps[index];
      if (tour === null || step === undefined) return;

      setState((current) => ({ ...current, tour: { ...tour, index } }));
      runStep(step);
    },
    [runStep],
  );

  const run = useCallback(
    (command: Command) => {
      if (command.type !== 'tour') return runStep(command);

      command.steps.forEach((step) => {
        if (step.type === 'explain') void fileContents(step.file, step.side);
      });
      setState((current) => ({ ...current, tour: { steps: command.steps, index: 0 } }));
      const first = command.steps[0];
      if (first !== undefined) runStep(first);
    },
    [runStep],
  );

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('command', (event) => run(JSON.parse((event as MessageEvent<string>).data) as Command));
    return () => events.close();
  }, [run]);

  useEffect(() => {
    const id = setTimeout(() => applyTextHighlight(state.highlight), 300);
    return () => clearTimeout(id);
  }, [state.highlight]);

  const dismiss = useCallback(() => setState((current) => ({ ...current, explanation: null })), []);
  const endTour = useCallback(() => setState(() => initial), []);

  return { state, run, goTo, dismiss, endTour };
};
