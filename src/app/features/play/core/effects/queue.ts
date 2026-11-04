/**
 * Trigger collection. A game event (play, digivolve, attack, deletion, security, turn start/end) calls `triggerTiming`
 * with the cards it concerns. Matching triggered effects go on `state.effectQueue`; everything else that carries the
 * tag becomes a reminder. The engine (engine.ts) resolves the queue after each command.
 *
 * No imports from rules/ here, so rules/helpers.ts can depend on this module without a cycle.
 */
import type { GameState, PlayerIndex, Reminder } from '../types';
import { MAX_REMINDERS } from '../types';
import type { EffectField, QueueItem } from './ast';
import { isTriggerTiming } from './ast';
import { parsedCard, timingOfTag } from './parser';
import { cardInfo } from '../rules/card-data';

/** A card whose text may fire: the uid is the card's, the field picks which text (digivolution text is inherited). */
export interface TriggerSource {
  uid: string;
  cardId: string;
  field: EffectField;
}

/** The seat whose command is being applied. Set by the reducer for the duration of one command. */
let actor: PlayerIndex | null = null;
/** > 0 while the engine is resolving the queue. Triggers raised then go to the front, in front of the rest. */
let depth = 0;

export function setActor(p: PlayerIndex | null): void {
  actor = p;
}

export function beginResolution(): void {
  depth++;
}

export function endResolution(): void {
  depth = Math.max(0, depth - 1);
}

/** True when the card's triggered effects run automatically on this state. */
export function effectsOn(state: GameState): boolean {
  return state.mode === 'assisted' && state.autoEffects !== false;
}

/** Actions that read or move the controller's hidden cards (deck, hand). See `triggerTiming`. */
const HIDDEN_ACTIONS = new Set(['revealTop', 'trashFromHand', 'trashDeckTop', 'recovery']);

function touchesHidden(actions: readonly { type: string }[]): boolean {
  return actions.some((a) => HIDDEN_ACTIONS.has(a.type));
}

/** Enqueues an item at the back, or at the front while the engine is resolving. */
export function enqueue(state: GameState, items: QueueItem[]): void {
  if (items.length === 0) return;
  const q = state.effectQueue ?? [];
  state.effectQueue = depth > 0 ? [...items, ...q] : [...q, ...items];
}

/** Queues an attack for resumption after its When Attacking effects. */
export function enqueueAttack(state: GameState, item: Extract<QueueItem, { kind: 'attack' }>): void {
  enqueue(state, [item]);
}

function usedThisTurn(state: GameState, key: string): boolean {
  const used = state.oncePerTurn;
  return !!used && used.turn === state.turn && used.keys.includes(key);
}

function markUsed(state: GameState, key: string): void {
  const used = state.oncePerTurn;
  if (!used || used.turn !== state.turn) state.oncePerTurn = { turn: state.turn, keys: [key] };
  else used.keys.push(key);
}

function remindBlock(state: GameState, owner: PlayerIndex, cardName: string, tag: string, text: string): void {
  state.nextId += 1;
  const list: Reminder[] = state.reminders ?? [];
  list.push({ id: state.nextId, turn: state.turn, player: owner, cardName, timing: tag, text });
  state.reminders = list.slice(-MAX_REMINDERS);
}

/**
 * Handles one timing tag (for example 'On Play') raised for `owner`. For each source, every block of that field
 * carrying the tag either queues its effect (auto on, fully parsed, not blocked by the hidden-information guard,
 * not used up by [Once Per Turn]) or becomes a reminder.
 */
export function triggerTiming(state: GameState, owner: PlayerIndex, sources: TriggerSource[], tag: string): void {
  const wanted = tag.trim().toLowerCase();
  const timing = timingOfTag(tag);
  const auto = effectsOn(state) && (state.winner === null || state.winner === undefined);
  const batch: QueueItem[] = [];
  for (const src of sources) {
    const info = cardInfo(src.cardId);
    if (!info) continue;
    const parsed = parsedCard(info.id, {
      effect: info.effect,
      digivolveEffect: info.digivolveEffect,
      securityEffect: info.securityEffect,
    });
    for (const block of parsed.blocks) {
      if (block.field !== src.field || !block.tags.includes(wanted)) continue;
      const trigger = timing !== undefined && isTriggerTiming(timing);
      if (auto && trigger && block.actions) {
        // Hidden-information guard: an effect that reads or moves the controller's hidden cards needs the controller's
        // own client to resolve it. Online, anyone else's such effect is left as a reminder.
        if (state.online && actor !== owner && touchesHidden(block.actions)) {
          remindBlock(state, owner, info.name, tag, block.lines.join('\n'));
          continue;
        }
        if (block.oncePerTurn) {
          const key = `${src.uid}#${block.index}`;
          if (usedThisTurn(state, key)) continue;
          markUsed(state, key);
        }
        batch.push({
          kind: 'effect',
          owner,
          cardName: info.name,
          cardId: info.id,
          sourceUid: src.uid,
          timing: timing!,
          optional: block.optional,
          actions: block.actions.slice(),
          text: block.lines.map((l) => l.replace(/^(\[[^\]]+\]\s*)+/, '')).join(' '),
        });
        continue;
      }
      remindBlock(state, owner, info.name, tag, block.lines.join('\n'));
    }
  }
  // The active player's triggers resolve first.
  batch.sort((a, b) => (a.kind === 'effect' && a.owner === state.activePlayer ? 0 : 1) - (b.kind === 'effect' && b.owner === state.activePlayer ? 0 : 1));
  enqueue(state, batch);
}
