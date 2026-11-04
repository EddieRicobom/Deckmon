/**
 * Every state change goes through a Command. Commands are plain serializable data so they can be
 * logged, undone (history), replayed, and later sent over the network unchanged.
 *
 * `player` is always the BOARD OWNER whose cards / stacks are affected. In solo mode the same
 * person may issue commands for either board.
 */
import type { PlayerIndex, Zone } from './types';

export type Destination = Zone;

interface Base {
  player: PlayerIndex;
}

export type Command =
  // ---- setup / turn structure -------------------------------------------------------------
  /** Returns all of the owner's cards to deck / egg deck, shuffles, 5 security, 5 hand. */
  | (Base & { type: 'setup' })
  /** Hand back into deck, shuffle, draw 5. */
  | (Base & { type: 'mulligan' })
  | (Base & { type: 'draw'; count?: number })
  | (Base & { type: 'shuffleDeck'; zone?: 'deck' | 'eggDeck' })
  | (Base & { type: 'nextPhase' })
  /**
   * End the turn. `memory` is expressed from the NEW active player's perspective
   * (positive = new active player's side). Defaults to 3.
   */
  | (Base & { type: 'passTurn'; memory?: number })
  | (Base & { type: 'setMemory'; value: number })
  | (Base & { type: 'changeMemoryBy'; delta: number })

  // ---- card movement ----------------------------------------------------------------------
  /** Egg deck top to a new breeding stack. */
  | (Base & { type: 'hatch' })
  | (Base & { type: 'moveBreedingToBattle' })
  /** Hand card onto a new stack in battle / tamer / option. */
  | (Base & { type: 'playFromHand'; uid: string; to: 'battle' | 'tamer' | 'option' })
  /** Hand card placed on top of an existing battle stack. The former top becomes a digivolution source. */
  | (Base & { type: 'digivolve'; handUid: string; onto: string })
  /**
   * Moves a single card from wherever it is to `to`. Pile destinations honour `position`
   * (top = end of array, bottom = start). Stack destinations create a new stack.
   */
  | (Base & { type: 'moveCard'; uid: string; to: Destination; position?: 'top' | 'bottom'; faceUp?: boolean })
  | (Base & { type: 'revealSecurity'; position?: 'top' | 'bottom' })
  | (Base & { type: 'setFaceUp'; uid: string; faceUp: boolean })

  // ---- stack operations (stackId lives on the owner's board) ------------------------------
  | (Base & { type: 'suspend'; stackId: string })
  | (Base & { type: 'unsuspend'; stackId: string })
  | (Base & { type: 'unsuspendAll' })
  | (Base & { type: 'setStackFaceDown'; stackId: string; faceDown: boolean })
  | (Base & { type: 'adjustDp'; stackId: string; delta: number })
  | (Base & { type: 'addMarker'; stackId: string; marker: string })
  | (Base & { type: 'removeMarker'; stackId: string; marker: string })
  | (Base & { type: 'trashStack'; stackId: string })
  | (Base & { type: 'returnToHand'; stackId: string })
  | (Base & { type: 'stackToDeck'; stackId: string; position: 'top' | 'bottom' });

export type CommandType = Command['type'];
