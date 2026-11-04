/**
 * Every state change goes through a Command. Commands are plain serializable data so they can be
 * logged, undone (history), replayed, and later sent over the network unchanged.
 *
 * `player` is always the BOARD OWNER whose cards / stacks are affected. In solo mode the same
 * person may issue commands for either board.
 */
import type { PlayerIndex, PlayerState, Zone } from './types';

export type Destination = Zone;

interface Base {
  player: PlayerIndex;
  /**
   * Assisted mode only: the player turned on Force, so the rules are not enforced for this command and it is logged
   * as an override. Ignored in manual mode.
   */
  force?: boolean;
  /**
   * Wire only (never set locally). uid -> real cardId for cards this command makes public. The receiving
   * peer fills them into its placeholder ('?') cards before applying the command.
   */
  reveals?: Record<string, string>;
  /**
   * Wire only. The owner's redacted board after a command the receiver cannot replay (it depends on the owner's
   * PRNG: setup, mulligan, shuffleDeck). Replaces the receiver's placeholder board after the command is applied.
   */
  board?: PlayerState;
  /**
   * Wire only. PRNG state the owner had BEFORE this command. The receiver adopts it before applying, so commands
   * that consume randomness (setup, mulligan, shuffle, coin, dice) produce the same result on both peers.
   */
  rng?: number;
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
  /** Flips a coin and logs Heads or Tails. Uses the synced PRNG. */
  | (Base & { type: 'flipCoin' })
  /** Rolls a die with `sides` faces (2..100, default 6) and logs the result. */
  | (Base & { type: 'rollDice'; sides?: number })
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
  /** `temporary` modifiers are cleared by the next passTurn. */
  | (Base & { type: 'adjustDp'; stackId: string; delta: number; temporary?: boolean })
  | (Base & { type: 'addMarker'; stackId: string; marker: string; temporary?: boolean })
  | (Base & { type: 'adjustCounter'; stackId: string; delta: number })
  | (Base & { type: 'removeMarker'; stackId: string; marker: string; temporary?: boolean })
  | (Base & { type: 'trashStack'; stackId: string })
  | (Base & { type: 'returnToHand'; stackId: string })
  | (Base & { type: 'stackToDeck'; stackId: string; position: 'top' | 'bottom' })

  // ---- combat (assisted mode; attacker is `player`) -----------------------------------------
  /** Declares an attack with an unsuspended battle Digimon. Suspends it, then runs blocks and battles. */
  | (Base & { type: 'attack'; attackerStackId: string; target: { kind: 'player' } | { kind: 'stack'; stackId: string } })
  /** Defender's answer to a pending block: a Blocker's stack id, or null for no block. */
  | (Base & { type: 'resolveBlock'; blockerStackId: string | null })
  /** Owner (defender) resolves the next security check of the pending attack. */
  | (Base & { type: 'securityCheck' });

export type CommandType = Command['type'];
