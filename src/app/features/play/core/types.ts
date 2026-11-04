/**
 * Core state types for the playmat simulator.
 * Pure TypeScript: no Angular, no DOM. Everything here must stay JSON-serializable.
 */

import type { EffectOption, QueueItem } from './effects/ast';

export type PlayerIndex = 0 | 1;

/** A single physical card instance. `uid` is unique per game, `cardId` is the printed card id. */
export interface CardRef {
  uid: string;
  cardId: string;
}

/** Security cards carry their own face-up flag. */
export interface SecurityCard extends CardRef {
  faceUp: boolean;
}

/**
 * A column of cards on the battle / breeding / tamer / option areas.
 * `cards` is ordered bottom..top; the last entry is the current (top) card.
 */
export interface Stack {
  stackId: string;
  cards: CardRef[];
  suspended: boolean;
  dpMod: number;
  faceDown?: boolean;
  /** Permanent markers (status chips such as "Rush" or custom text). */
  markers?: string[];
  /** Markers and DP that only last until the next passTurn ("until end of turn"). */
  tempMarkers?: string[];
  tempDpMod?: number;
  /**
   * Effects that last until the end of a later turn (`until` is that turn number). Each entry is a DP modifier or a
   * marker. Removed by clearTemporary once that turn ends.
   */
  timedMods?: Array<{ until: number; dp?: number; marker?: string }>;
  /** Generic numeric counter for effects that count things. Never negative. */
  counter?: number;
  /** Turn number the stack entered the battle area. Digivolving does not reset it. Undefined = long ago. */
  enteredTurn?: number;
}

/** Zones holding loose cards. Piles are ordered bottom..top (top = last element) except hand/trash/reveal. */
export type PileZone = 'deck' | 'eggDeck' | 'hand' | 'security' | 'trash' | 'reveal';

/** Zones holding stacks. Breeding holds at most one stack. */
export type StackZone = 'breeding' | 'battle' | 'tamer' | 'option';

export type Zone = PileZone | StackZone;

export const PILE_ZONES: readonly PileZone[] = ['deck', 'eggDeck', 'hand', 'security', 'trash', 'reveal'];
export const STACK_ZONES: readonly StackZone[] = ['breeding', 'battle', 'tamer', 'option'];

export type Phase = 'unsuspend' | 'draw' | 'breeding' | 'main' | 'end';
export const PHASES: readonly Phase[] = ['unsuspend', 'draw', 'breeding', 'main', 'end'];

export interface PlayerState {
  id: PlayerIndex;
  name: string;
  deck: CardRef[];
  eggDeck: CardRef[];
  hand: CardRef[];
  security: SecurityCard[];
  breeding: Stack | null;
  battle: Stack[];
  tamer: Stack[];
  option: Stack[];
  trash: CardRef[];
  reveal: CardRef[];
  /** uids of Digi-Eggs. Needed so setup/reset can rebuild the egg deck from any zone. */
  eggUids: string[];
}

export interface LogEntry {
  seq: number;
  turn: number;
  player: PlayerIndex;
  text: string;
}

/** `assisted` enforces the base rules (see core/rules/RULES.md). `manual` is the free sandbox. Absent = manual. */
export type RulesMode = 'assisted' | 'manual';

/**
 * A decision that belongs to one player. While set, only `owner` may act (except to force).
 * - block: the defender chooses a Blocker (or none) for an attack on the player.
 * - security: the defender's client reveals and resolves the next security check.
 */
export type Pending =
  | { kind: 'block'; owner: PlayerIndex; attacker: PlayerIndex; attackerStackId: string; blockers: string[]; checks: number }
  | { kind: 'security'; owner: PlayerIndex; attacker: PlayerIndex; attackerStackId: string; remaining: number }
  | EffectPending;

/**
 * An effect choice for the effect's controller. `pick`: choose between min and max of `options`. `confirm`: "you may",
 * answered with yes or no.
 */
export interface EffectPending {
  kind: 'effect';
  owner: PlayerIndex;
  mode: 'pick' | 'confirm';
  cardName: string;
  prompt: string;
  options: EffectOption[];
  min: number;
  max: number;
}

/** A non-blocking effect reminder. The player applies the effect with the manual tools. */
export interface Reminder {
  id: number;
  turn: number;
  player: PlayerIndex;
  cardName: string;
  timing: string;
  text: string;
}

export const MAX_REMINDERS = 40;

/**
 * The latest battle or security check, for the table to show. `seq` is the log length when it happened, so a new
 * result always has a larger seq. Both peers compute the same record from the same command.
 */
export interface CombatResult {
  seq: number;
  kind: 'battle' | 'security';
  attacker: PlayerIndex;
  attackerName: string;
  attackerDp: number;
  /** Battle: the defending Digimon. Security: the revealed security card (cardId may be hidden). */
  defenderName: string;
  defenderDp: number | null;
  /** Card id of the revealed security card, when the record is a security check. */
  revealedCardId?: string;
  attackerDeleted: boolean;
  defenderDeleted: boolean;
}

export interface GameState {
  /** Rules mode. Absent on states created before the rules layer existed, which means manual. */
  mode?: RulesMode;
  /** Open decision (assisted mode only). */
  pending?: Pending | null;
  /** Winner once the game ends (assisted mode). Null or absent while the game runs. */
  winner?: PlayerIndex | null;
  winReason?: string | null;
  /** Effect reminders, newest last, capped at MAX_REMINDERS. */
  reminders?: Reminder[];
  /** Automatic card effects (assisted only). Absent or true = on; false = reminders only. */
  autoEffects?: boolean;
  /** Triggered effects waiting to resolve, head first. Empty when nothing is queued. */
  effectQueue?: QueueItem[];
  /** [Once Per Turn] uses this turn, keyed by source uid and line. Reset when the turn number changes. */
  oncePerTurn?: { turn: number; keys: string[] };
  /** Set on online games. Effects that would need the owner's hidden cards then resolve only on the owner's turn. */
  online?: boolean;
  /** The latest battle or security check (assisted mode). */
  lastCombat?: CombatResult | null;
  /** Original seed, kept for replay / debugging. Redacted for opponents by view.ts. */
  seed: number;
  /** Current PRNG state. Redacted for opponents by view.ts. */
  rngState: number;
  /** Monotonic counter used to mint unique stack ids. */
  nextId: number;
  turn: number;
  activePlayer: PlayerIndex;
  phase: Phase;
  /** -10..10. Positive = the active player's side of the gauge. */
  memory: number;
  players: [PlayerState, PlayerState];
  log: LogEntry[];
  version: number;
}

export const STATE_VERSION = 1;
export const MEMORY_MIN = -10;
export const MEMORY_MAX = 10;
export const MAX_HISTORY = 100;
