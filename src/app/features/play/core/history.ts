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
  /** marks[k] = the log length before commands[k], so the log panel can rewind to a log entry. */
  marks: number[];
}

export function createHistory(initial: GameState): GameHistory {
  return { initial, commands: [], past: [], learned: [], present: initial, future: [], marks: [] };
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
  return {
    initial: history.initial,
    commands: [...history.commands, cmd],
    past,
    learned,
    present: next,
    future: [],
    marks: [...history.marks, history.present.log.length],
  };
}

export function canUndo(history: GameHistory): boolean {
  return history.past.length > 0;
}

/**
 * A command that continues the step of the command before it. The automatic battle, block and security decisions
 * that an attack causes are part of that attack, so one undo takes back the attack and everything it resolved.
 * (Solo: the auto security checks; online: the defender's answer to a block or a security check.)
 */
export function continuesStep(cmd: Command): boolean {
  return cmd.type === 'securityCheck' || cmd.type === 'resolveBlock';
}

/** Index of the first command of the undo step that contains command `index`. */
export function stepStartIndex(history: GameHistory, index: number): number {
  let k = index;
  while (k > 0 && continuesStep(history.commands[k])) k--;
  return k;
}

/** Number of commands in the newest undo step (0 when there is no command). */
function commandsInNewestStep(history: GameHistory): number {
  if (history.commands.length === 0) return 0;
  return history.commands.length - stepStartIndex(history, history.commands.length - 1);
}

/**
 * How many undo steps the viewer may undo right now, counting back from the newest step. Stops at the first step that
 * belongs to another seat, revealed hidden information to the viewer, or has no snapshot left (past the cap, or
 * after a resync). `viewer` null means solo: no owner check.
 */
export function undoableSteps(history: GameHistory, viewer: PlayerIndex | null): number {
  const firstSnapshot = history.commands.length - history.past.length;
  let steps = 0;
  let end = history.commands.length;
  while (end > 0) {
    const start = stepStartIndex(history, end - 1);
    if (start < firstSnapshot) break;
    for (let k = start; k < end; k++) {
      if (history.learned[k - firstSnapshot]) return steps;
      if (viewer !== null && history.commands[k].player !== viewer) return steps;
    }
    steps++;
    end = start;
  }
  return steps;
}

/** Undoes `steps` whole undo steps (default 1). Undone commands move to `future` so they can be redone. */
export function undo(history: GameHistory, steps = 1): GameHistory {
  let h = history;
  for (let i = 0; i < steps; i++) {
    const count = commandsInNewestStep(h);
    if (count === 0 || count > h.past.length) break;
    h = undoCommands(h, count);
  }
  return h;
}

/**
 * Undoes exactly `count` commands, counted from the newest. Internal to undo and to the peer sync, which counts
 * commands, not steps. Undone steps move to `future` so they can be redone.
 */
export function undoCommands(history: GameHistory, count: number): GameHistory {
  let h = history;
  for (let i = 0; i < count && canUndo(h); i++) {
    const last = h.past.length - 1;
    const cmdIdx = h.commands.length - 1;
    h = {
      initial: h.initial,
      commands: h.commands.slice(0, cmdIdx),
      past: h.past.slice(0, last),
      learned: h.learned.slice(0, last),
      present: h.past[last],
      future: [...h.future, { command: h.commands[cmdIdx], state: h.present, learned: h.learned[last] }],
      marks: h.marks.slice(0, cmdIdx),
    };
  }
  return h;
}

/**
 * Rewinds until `length` commands remain, never inside a step: a length that falls in the middle of an attack's
 * resolution rewinds to before the whole attack. Used by "rewind to here" in the log.
 */
export function rewindTo(history: GameHistory, length: number): GameHistory {
  if (length < 0 || length >= history.commands.length) return history;
  const target = stepStartIndex(history, length);
  return undoCommands(history, history.commands.length - target);
}

export function canRedo(history: GameHistory): boolean {
  return history.future.length > 0;
}

/**
 * Re-applies the most recently undone step: its first command and the continuation commands beneath it in `future`.
 * Returns the same history when there is nothing to redo.
 */
export function redo(history: GameHistory): GameHistory {
  let h = history;
  let first = true;
  while (h.future.length > 0 && (first || continuesStep(h.future[h.future.length - 1].command))) {
    first = false;
    const step = h.future[h.future.length - 1];
    const [past, learned] = withSnapshot(h.past, h.learned, h.present, step.learned);
    h = {
      initial: h.initial,
      commands: [...h.commands, step.command],
      past,
      learned,
      present: step.state,
      future: h.future.slice(0, -1),
      marks: [...h.marks, h.present.log.length],
    };
  }
  return h;
}

/** Rebuilds a state from the initial state and a command list. */
export function replay(initial: GameState, commands: readonly Command[]): GameState {
  return commands.reduce((state, cmd) => applyCommand(state, cmd), initial);
}
