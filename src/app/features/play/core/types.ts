/**
 * Core state types for the playmat simulator.
 * Pure TypeScript: no Angular, no DOM. Everything here must stay JSON-serializable.
 */

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
  /** Generic numeric counter for effects that count things. Never negative. */
  counter?: number;
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

export interface GameState {
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
