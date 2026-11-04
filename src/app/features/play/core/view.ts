/**
 * Viewer-specific projections of the game state. Use these before sending state to a client
 * (hot-seat hiding today, the P2P layer later) so hidden information never leaves the server.
 */
import { CardRef, GameState, PlayerIndex, PlayerState, Stack } from './types';

export const HIDDEN_CARD_ID = '?';

function hide(cards: readonly CardRef[]): CardRef[] {
  return cards.map((c) => ({ uid: c.uid, cardId: HIDDEN_CARD_ID }));
}

function hideStack(stack: Stack): Stack {
  return stack.faceDown ? { ...stack, cards: hide(stack.cards) } : stack;
}

/** Hides everything the viewer is not allowed to see on one board. Counts and uids stay visible. */
export function redactPlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    deck: hide(p.deck),
    eggDeck: hide(p.eggDeck),
    hand: hide(p.hand),
    security: p.security.map((c) => (c.faceUp ? c : { ...c, cardId: HIDDEN_CARD_ID })),
    breeding: p.breeding ? hideStack(p.breeding) : null,
    battle: p.battle.map(hideStack),
    tamer: p.tamer.map(hideStack),
    option: p.option.map(hideStack),
    eggUids: [],
  };
}

/**
 * Returns the state as `viewerId` may see it. The viewer's own board is untouched.
 * The opponent's hand, decks, face-down security and face-down stacks are replaced with '?'.
 * The PRNG seed and state are zeroed for everyone, because they would reveal the deck order.
 */
export function redactFor(state: GameState, viewerId: PlayerIndex): GameState {
  const opponent: PlayerIndex = viewerId === 0 ? 1 : 0;
  const players: [PlayerState, PlayerState] = [state.players[0], state.players[1]];
  players[opponent] = redactPlayer(state.players[opponent]);
  return { ...state, seed: 0, rngState: 0, players };
}
