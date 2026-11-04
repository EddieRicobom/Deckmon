/**
 * Undo / redo history. `present` is the live state. Every accepted command is one step, even when it auto-advanced
 * phases or ended the turn, so undoing a step returns to before the action that triggered those automatic changes.
 *
 * `commands` is the full command list (replay from `initial` always works). `past`, `learned` are the undo snapshots,
 * capped at MAX_HISTORY, aligned with the END of `commands`: past[k] is the state before the command at
 * commands[commands.length - past.length + k]. `learned` says the step revealed hidden information to the local
 * viewer (a draw into their hand, an opponent's card turned visible); such steps can never be undone.
 * `future` holds undone steps for redo, cleared by the next accepted command.
 */
import { applyCommand } from './reducer';
import { Command } from './commands';
import { allCards } from './game';
import { redactFor, HIDDEN_CARD_ID } from './view';
import { GameState, MAX_HISTORY, PlayerIndex } from './types';

export interface RedoStep {
  command: Command;
  state: GameState;
  learned: boolean;
}

export interface GameHistory {
  initial: GameState;
  commands: Command[];
  past: GameState[];
  learned: boolean[];
  present: GameState;
  /** Undone steps, most recently undone last. */
  future: RedoStep[];
}

export function createHistory(initial: GameState): GameHistory {
  return { initial, commands: [], past: [], learned: [], present: initial, future: [] };
}

/**
 * True when applying a step gave `viewer` hidden information: a card joined their hand, or a card the viewer
 * could not see before is now visible on the opponent's board. `null` viewer (solo) never learns anything.
 */
export function learnedInStep(prev: GameState, next: GameState, viewer: PlayerIndex | null): boolean {
  if (viewer === null) return false;
  const beforeHand = new Set(prev.players[viewer].hand.map((c) => c.uid));
  if (next.players[viewer].hand.some((c) => !beforeHand.has(c.uid))) return true;
  const opp: PlayerIndex = viewer === 0 ? 1 : 0;
  const pv = new Map(allCards(redactFor(prev, viewer).players[opp]).map((c) => [c.uid, c.cardId] as const));
  return allCards(redactFor(next, viewer).players[opp]).some(
    (c) => pv.get(c.uid) === HIDDEN_CARD_ID && c.cardId !== HIDDEN_CARD_ID,
  );
}

/** Appends one undo snapshot, dropping the oldest once the cap is reached. */
function withSnapshot(past: GameState[], learned: boolean[], state: GameState, flag: boolean): [GameState[], boolean[]] {
  const p = [...past, state];
  const l = [...learned, flag];
  if (p.length > MAX_HISTORY) return [p.slice(1), l.slice(1)];
  return [p, l];
}

/**
 * Applies a command. Throws (leaving the history untouched) if the command is invalid.
 * `viewer` is the seat of this device online, or null in solo mode.
 */
export function dispatch(history: GameHistory, cmd: Command, viewer: PlayerIndex | null = null): GameHistory {
  const next = applyCommand(history.present, cmd);
  const flag = learnedInStep(history.present, next, viewer);
  const [past, learned] = withSnapshot(history.past, history.learned, history.present, flag);
  return { initial: history.initial, commands: [...history.commands, cmd], past, learned, present: next, future: [] };
}

export function canUndo(history: GameHistory): boolean {
  return history.past.length > 0;
}

/**
 * How many steps the viewer may undo right now, counting back from the newest step. Stops at the first step that
 * belongs to another seat, revealed hidden information to the viewer, or has no snapshot left (past the cap, or
 * after a resync). `viewer` null means solo: no owner check.
 */
export function undoableSteps(history: GameHistory, viewer: PlayerIndex | null): number {
  let n = 0;
  while (n < history.past.length) {
    const k = history.past.length - 1 - n;
    if (history.learned[k]) break;
    if (viewer !== null && history.commands[history.commands.length - 1 - n]?.player !== viewer) break;
    n++;
  }
  return n;
}

/** Steps back `steps` commands (default 1). Undone steps move to `future` so they can be redone. */
export function undo(history: GameHistory, steps = 1): GameHistory {
  let h = history;
  for (let i = 0; i < steps && canUndo(h); i++) {
    const last = h.past.length - 1;
    const cmdIdx = h.commands.length - 1;
    h = {
      initial: h.initial,
      commands: h.commands.slice(0, cmdIdx),
      past: h.past.slice(0, last),
      learned: h.learned.slice(0, last),
      present: h.past[last],
      future: [...h.future, { command: h.commands[cmdIdx], state: h.present, learned: h.learned[last] }],
    };
  }
  return h;
}

/** Rewinds until exactly `length` commands remain. Used by "rewind to here" in the log. */
export function rewindTo(history: GameHistory, length: number): GameHistory {
  if (length < 0 || length >= history.commands.length) return history;
  return undo(history, history.commands.length - length);
}

export function canRedo(history: GameHistory): boolean {
  return history.future.length > 0;
}

/** Re-applies the most recently undone step. Returns the same history when there is nothing to redo. */
export function redo(history: GameHistory): GameHistory {
  const step = history.future[history.future.length - 1];
  if (!step) return history;
  const [past, learned] = withSnapshot(history.past, history.learned, history.present, step.learned);
  return {
    initial: history.initial,
    commands: [...history.commands, step.command],
    past,
    learned,
    present: step.state,
    future: history.future.slice(0, -1),
  };
}

/** Rebuilds a state from the initial state and a command list. */
export function replay(initial: GameState, commands: readonly Command[]): GameState {
  return commands.reduce((state, cmd) => applyCommand(state, cmd), initial);
}
