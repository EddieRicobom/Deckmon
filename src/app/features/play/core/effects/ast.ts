/**
 * Effect AST. A card's effect text is parsed (parser.ts) into Effects: one per timing tag on a block of text, each
 * with a list of primitive Actions. The resolver (engine.ts) runs the actions in order, pausing for owner choices.
 * Everything here is plain JSON so queued effects survive undo, saves and the wire.
 */

/** Timings the engine can fire from game events. */
export type TriggerTiming = 'onPlay' | 'whenDigivolving' | 'whenAttacking' | 'onDeletion' | 'security' | 'main' | 'startOfYourTurn' | 'endOfYourTurn';

/** Continuous timings: parsed for coverage, not applied yet (see COVERAGE.md). */
export type ContinuousTiming = 'yourTurn' | 'allTurns' | 'opponentsTurn' | 'endOfOpponentsTurn';

export type EffectTiming = TriggerTiming | ContinuousTiming;

export const TRIGGER_TIMINGS: readonly TriggerTiming[] = [
  'onPlay',
  'whenDigivolving',
  'whenAttacking',
  'onDeletion',
  'security',
  'main',
  'startOfYourTurn',
  'endOfYourTurn',
];

export function isTriggerTiming(t: EffectTiming): t is TriggerTiming {
  return (TRIGGER_TIMINGS as readonly string[]).includes(t);
}

/** Where the effect text sits on the card. Digivolution text is inherited by the stack. */
export type EffectField = 'effect' | 'digivolveEffect' | 'securityEffect';

/** Numeric comparison used by level, DP and cost filters. */
export interface Cmp {
  op: 'eq' | 'le' | 'ge';
  n: number;
}

/** Card filter. Stacks are judged by their top card; `noDigivolution` means a bare Digimon. */
export interface Filter {
  cardType?: 'digimon' | 'tamer' | 'option';
  /** Lower-case colour name, e.g. 'yellow'. */
  color?: string;
  level?: Cmp;
  dp?: Cmp;
  cost?: Cmp;
  /** Lower-case substring of the card's English name. */
  nameContains?: string;
  suspended?: boolean;
  noDigivolution?: boolean;
}

export type Side = 'own' | 'opponent';

/** A choice among cards or stacks. `self` is the card whose text this is. */
export type Target =
  | { kind: 'self' }
  | {
      kind: 'select';
      side: Side;
      zone: 'battle' | 'trash' | 'hand' | 'reveal';
      filter: Filter;
      /** exactly n, up to n, or every match (no choice). */
      mode: 'exactly' | 'upTo' | 'all';
      n: number;
    };

export type Condition =
  | { kind: 'handAtLeast'; n: number }
  | { kind: 'handAtMost'; n: number }
  | { kind: 'securityAtLeast'; n: number }
  | { kind: 'securityAtMost'; n: number }
  | { kind: 'colorInPlay'; color: string }
  | { kind: 'opponentHasNoDigivolutionDigimon' }
  | { kind: 'opponentHasDigimon' }
  /** "If you do": the previous action in this effect did something. */
  | { kind: 'ifDone' };

interface ActionBase {
  /** Checked when the action is reached. A false condition skips the action. */
  when?: Condition;
}

export type Action =
  | (ActionBase & { type: 'draw'; n: number })
  /** Positive = gain (toward the controller's side of the gauge), negative = lose. */
  | (ActionBase & { type: 'memory'; delta: number })
  | (ActionBase & { type: 'dp'; target: Target; delta: number; duration: 'turn' | 'continuous' })
  /** Adds a keyword (or "Security A. +N") as a marker until the end of the turn. */
  | (ActionBase & { type: 'keyword'; target: Target; keyword: string; duration: 'turn' | 'continuous' })
  | (ActionBase & { type: 'cant'; target: Target; what: 'attack' | 'block'; duration: 'turn' })
  | (ActionBase & { type: 'suspend'; target: Target; suspended: boolean })
  | (ActionBase & { type: 'delete'; target: Target })
  /** Battle stack to hand, or a trash card to hand. */
  | (ActionBase & { type: 'returnToHand'; target: Target })
  | (ActionBase & { type: 'returnToDeckBottom'; target: Target })
  | (ActionBase & { type: 'deDigivolve'; target: Target; n: number })
  | (ActionBase & { type: 'trashFromHand'; target: Target })
  | (ActionBase & { type: 'trashDeckTop'; n: number })
  /** Top n of the owner's deck onto the top of their security stack, face-down. */
  | (ActionBase & { type: 'recovery'; n: number })
  /** Reveal the top n of the deck, pick cards for each pick (in order), the rest go to the bottom. */
  | (ActionBase & { type: 'revealTop'; n: number; picks: Array<{ filter: Filter; n: number }> })
  | (ActionBase & { type: 'addSourceToHand' })
  /** The source card is played from the trash without paying its cost (Tamer or Digimon: to its area, then On Play). */
  | (ActionBase & { type: 'playSource' })
  /** Queues the [Main] effects of the source card (Option security effects). */
  | (ActionBase & { type: 'activateMain' });

export type ActionType = Action['type'];

export interface Effect {
  timing: EffectTiming;
  field: EffectField;
  optional: boolean;
  oncePerTurn: boolean;
  actions: Action[];
  /** The source lines, joined. Used for the log and reminders. */
  text: string;
}

/** Owner's choice. `pick` lists cards or stacks, `confirm` is a yes/no for "you may". */
export interface EffectOption {
  id: string;
  side: 0 | 1;
  zone: 'battle' | 'trash' | 'hand' | 'reveal';
  /** Battle stacks show their card name. Hidden zones leave it empty so both peers see the same pending state. */
  label: string;
}

/** One queued unit of work: a triggered effect (its remaining actions), or a paused attack to resume. */
export type QueueItem =
  | {
      kind: 'effect';
      owner: 0 | 1;
      cardName: string;
      cardId: string;
      /** uid of the card the effect's text sits on (the top card for stacks). Used for self targets. */
      sourceUid: string;
      timing: EffectTiming;
      optional: boolean;
      /** Remaining actions. The head action is the one being resolved. */
      actions: Action[];
      text: string;
      started?: boolean;
      asked?: boolean;
      /** Index of the next pick within a multi-pick action (revealTop). */
      stage?: number;
      lastPerformed?: boolean;
    }
  | {
      kind: 'attack';
      attacker: 0 | 1;
      attackerStackId: string;
      target: { kind: 'player' } | { kind: 'stack'; stackId: string };
    };
