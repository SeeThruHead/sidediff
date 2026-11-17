import { Option, Schema } from 'effect';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Action } from './actions';
import { visibleChangedLines } from './dom';
import { type FileLines, type ReadMarks, type Reading, keyLookup, prune, seenKey, tick } from './read';
import { type Context, type Effect, type NavState, initialNav, update } from './state';

type Outbox = { readonly seq: number; readonly effects: readonly Effect[] };

type Machine = { readonly nav: NavState; readonly outbox: Outbox };

type Message =
  | { readonly kind: 'action'; readonly action: Action; readonly ctx: Context }
  | { readonly kind: 'drained'; readonly count: number };

const machine = (state: Machine, message: Message): Machine => {
  if (message.kind === 'drained')
    return { ...state, outbox: { seq: state.outbox.seq, effects: state.outbox.effects.slice(message.count) } };

  const result = update(state.nav, message.action, message.ctx);
  if (result.effects.length === 0 && result.state === state.nav) return state;

  return {
    nav: result.state,
    outbox: { seq: state.outbox.seq + 1, effects: [...state.outbox.effects, ...result.effects] },
  };
};

const noContext: Context = { files: [], style: 'split', halfPage: 1, fileLines: null, results: [] };

export const useNav = () => {
  const [state, send] = useReducer(machine, { nav: initialNav, outbox: { seq: 0, effects: [] } });
  const latest = useRef<{ ctx: Context; perform: (effect: Effect) => void }>({ ctx: noContext, perform: () => undefined });
  const connect = useCallback((ctx: Context, perform: (effect: Effect) => void) => {
    latest.current = { ctx, perform };
  }, []);

  const dispatch = useCallback((action: Action) => send({ kind: 'action', action, ctx: latest.current.ctx }), []);

  useEffect(() => {
    if (state.outbox.effects.length === 0) return;

    state.outbox.effects.forEach((effect) => latest.current.perform(effect));
    send({ kind: 'drained', count: state.outbox.effects.length });
  }, [state.outbox]);

  return { nav: state.nav, dispatch, connect };
};

const storageKey = (repo: string) => `sidediff:read:${repo}`;

const decodeMarks = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.String))),
);

const loadMarks = (repo: string): ReadMarks =>
  Option.getOrElse(decodeMarks(localStorage.getItem(storageKey(repo)) ?? '{}'), () => ({}));

const TICK_MS = 250;
const IDLE_MS = 90_000;

const isAttending = (lastInput: number) => {
  if (document.visibilityState !== 'visible') return false;
  if (!document.hasFocus()) return false;

  return performance.now() - lastInput < IDLE_MS;
};

export const useReading = (repo: string, files: readonly FileLines[], paused: boolean) => {
  const [marks, setMarks] = useState<ReadMarks>(() => loadMarks(repo));
  const lookups = useMemo(() => new Map(files.map((file) => [file.path, keyLookup(file.changed)])), [files]);
  const live = useRef({ files, lookups, paused });
  live.current = { files, lookups, paused };
  const reading = useRef<Reading>({ dwell: new Map(), marks });
  const lastInput = useRef(performance.now());

  useEffect(() => {
    const main = document.querySelector('main.files');
    if (main === null) return;

    const noteInput = () => {
      lastInput.current = performance.now();
    };
    const events = ['keydown', 'pointermove', 'wheel', 'pointerdown'] as const;
    events.forEach((name) => window.addEventListener(name, noteInput, { passive: true }));

    const timer = window.setInterval(() => {
      if (live.current.paused) return;
      if (!isAttending(lastInput.current)) return;

      const seen = visibleChangedLines(main).flatMap((line) => {
        const key = seenKey(live.current.lookups.get(line.path) ?? new Map(), line.side, line.line);
        return key === undefined ? [] : [{ path: line.path, key }];
      });
      const before = reading.current;
      const after = tick(before, seen, TICK_MS);
      reading.current = after;

      if (after.marks !== before.marks) setMarks(after.marks);
    }, TICK_MS);

    return () => {
      window.clearInterval(timer);
      events.forEach((name) => window.removeEventListener(name, noteInput));
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKey(repo), JSON.stringify(prune(marks, live.current.files)));
  }, [repo, marks]);

  return marks;
};

export const useDebounced = <A>(value: A, ms: number): A => {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return settled;
};

export const useLastDefined = <A>(value: A | undefined): A | undefined => {
  const [kept, setKept] = useState(value);

  useEffect(() => {
    if (value !== undefined) setKept(value);
  }, [value]);

  return value ?? kept;
};
