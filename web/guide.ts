import { useAtomMount, useAtomSubscribe } from '@effect/atom-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Command, Guide, Side, Step, Target } from '../src/protocol';
import type { Atom } from 'effect/reactivity';

import { commandAtom } from './client';

export type { Side, Target };

export type GuideState = {
  readonly highlight: Target | null;
  readonly caption: string | null;
};

const initial: GuideState = { highlight: null, caption: null };

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

export type GuideActions = {
  readonly openFile: (path: string) => void;
  readonly openSection: (anchor: string) => void;
  readonly revealNote: (id: string) => void;
};

export const useGuide = ({ openFile, openSection, revealNote }: GuideActions) => {
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

  const guideTo = useCallback(
    (command: Guide) => {
      const { type: _type, note, anchor, ...target } = command;
      setState(() => ({ highlight: target, caption: null }));
      revealNote(note);
      focus(target);
      if (anchor !== undefined) openSection(anchor);
    },
    [focus, openSection, revealNote],
  );

  const runStep = useCallback(
    (step: Step) => {
      if (step.type === 'clear') {
        applyTextHighlight(null);
        window.speechSynthesis?.cancel();
        return setState(() => initial);
      }

      if (step.type === 'say') {
        if (step.speak) speak(step.text);
        return setState((current) => ({ ...current, caption: step.text }));
      }

      if (step.type === 'section') return openSection(step.anchor);

      if (step.type === 'show') return focus(step);

      setState((current) => ({ ...current, highlight: step }));
      return focus(step);
    },
    [focus, openSection],
  );

  const run = useCallback(
    (command: Command) => (command.type === 'guide' ? guideTo(command) : runStep(command)),
    [guideTo, runStep],
  );

  const runRef = useRef(run);
  runRef.current = run;

  const onDelivered = useCallback((delivered: Atom.Type<typeof commandAtom>) => {
    if (delivered._tag === 'Success') runRef.current(delivered.value.command);
  }, []);

  useAtomMount(commandAtom);
  useAtomSubscribe(commandAtom, onDelivered);

  useEffect(() => {
    const id = setTimeout(() => applyTextHighlight(state.highlight), 300);
    return () => clearTimeout(id);
  }, [state.highlight]);

  const dismiss = useCallback(() => {
    applyTextHighlight(null);
    setState(() => initial);
  }, []);

  return { state, run, dismiss };
};
