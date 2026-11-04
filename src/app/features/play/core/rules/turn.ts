/**
 * Assisted turn flow. The unsuspend and draw phases run automatically inside the command that ends the turn, so
 * one command (and one undo step) covers the whole handoff. The breeding phase waits for the player.
 */
import { clearTemporary } from '../game';
import { allStacks, drawOne, hasKeyword, log, other, remindStack } from './helpers';
import { GameState, MEMORY_MAX, MEMORY_MIN } from '../types';

const clamp = (v: number): number => Math.max(MEMORY_MIN, Math.min(MEMORY_MAX, Math.round(v)));

/**
 * Ends the active player's turn. `memory` is the new active player's gauge value (positive = their side).
 * Runs: end-of-turn reminders, handover, automatic unsuspend (own stacks, plus Reboot stacks of the player whose
 * turn it was), automatic draw (skipped on turn 1), then stops at breeding. The draw can end the game.
 */
export function passTurnRuled(state: GameState, memory: number): void {
  const outgoing = state.activePlayer;
  const next = other(outgoing);
  for (const s of allStacks(state.players[outgoing])) remindStack(state, outgoing, s, 'End of Your Turn');
  const cleared = clearTemporary(state);

  state.activePlayer = next;
  state.turn += 1;
  state.memory = clamp(memory);
  state.phase = 'unsuspend';
  const note = cleared > 0 ? ` ${cleared} until-end-of-turn effect(s) cleared.` : '';
  const gauge = state.memory >= 0 ? `+${state.memory}` : `${state.memory}`;
  log(state, outgoing, `${state.players[outgoing].name} ended the turn. ${state.players[next].name} is active with memory ${gauge}.${note}`);

  // Unsuspend phase (automatic).
  for (const s of allStacks(state.players[next])) s.suspended = false;
  for (const s of allStacks(state.players[outgoing])) {
    if (hasKeyword(s, 'Reboot')) s.suspended = false;
  }
  log(state, next, 'Unsuspend phase: your Digimon and Tamers are active again.');

  // Draw phase (automatic). The first player skips the draw on turn 1.
  state.phase = 'draw';
  if (state.turn === 1) {
    log(state, next, 'Draw phase skipped on the first turn.');
  } else if (!drawOne(state, next)) {
    return;
  }

  state.phase = 'breeding';
  for (const s of allStacks(state.players[next])) remindStack(state, next, s, 'Start of Your Turn');
  log(state, next, 'Breeding phase.');
}

/** Ends the turn automatically when memory is on the opponent's side after an action in the main phase. */
export function autoEndTurnIfNeeded(state: GameState): void {
  if (state.mode !== 'assisted') return;
  const over = state.winner !== null && state.winner !== undefined;
  if (state.phase !== 'main' || state.pending || over) return;
  if (state.memory >= 0) return;
  log(state, state.activePlayer, 'Memory moved to the opponent side, so the turn ends.');
  passTurnRuled(state, -state.memory);
}
