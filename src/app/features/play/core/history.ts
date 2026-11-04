/**
 * Immutable undo history. `present` is the live state, `past` holds earlier states (capped),
 * and `commands` is the full command list so the game can be rebuilt with `replay`.
 */
import { applyCommand } from './reducer';
import { Command } from './commands';
import { GameState, MAX_HISTORY } from './types';

export interface GameHistory {
  initial: GameState;
  commands: Command[];
  past: GameState[];
  present: GameState;
}

export function createHistory(initial: GameState): GameHistory {
  return { initial, commands: [], past: [], present: initial };
}

/** Applies a command. Throws (leaving the history untouched) if the command is invalid. */
export function dispatch(history: GameHistory, cmd: Command): GameHistory {
  const next = applyCommand(history.present, cmd);
  return {
    initial: history.initial,
    commands: [...history.commands, cmd],
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
  };
}

export function canUndo(history: GameHistory): boolean {
  return history.past.length > 0;
}

/** Steps back one command. Returns the same history when there is nothing to undo. */
export function undo(history: GameHistory): GameHistory {
  if (!canUndo(history)) return history;
  return {
    initial: history.initial,
    commands: history.commands.slice(0, -1),
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
  };
}

/** Rebuilds a state from the initial state and a command list. */
export function replay(initial: GameState, commands: readonly Command[]): GameState {
  return commands.reduce((state, cmd) => applyCommand(state, cmd), initial);
}
