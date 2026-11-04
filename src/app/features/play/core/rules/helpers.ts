/**
 * Shared rules helpers. Every function here mutates the state it is given, so callers must pass a clone (the reducer
 * always works on one).
 */
import { cardInfo, CardInfo } from './card-data';
import { keywordsIn, linesWithTiming, securityAttackMod } from './text';
import { stackDpMod } from '../game';
import { cardLabel } from '../labels';
import { GameState, MAX_REMINDERS, MEMORY_MAX, MEMORY_MIN, PlayerIndex, PlayerState, Stack } from '../types';

const clampMemory = (v: number): number => Math.max(MEMORY_MIN, Math.min(MEMORY_MAX, Math.round(v)));

export const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** Every stack on one board, breeding included. */
export function allStacks(p: PlayerState): Stack[] {
  return [...(p.breeding ? [p.breeding] : []), ...p.battle, ...p.tamer, ...p.option];
}

export function topCard(stack: Stack): { cardId: string; uid: string } | undefined {
  return stack.cards[stack.cards.length - 1];
}

export function topInfo(stack: Stack): CardInfo | undefined {
  const top = topCard(stack);
  return top ? cardInfo(top.cardId) : undefined;
}

/**
 * Keywords on a stack: the top card's effect keywords, the inherited digivolveEffect keywords of every card under it,
 * and any marker whose name is a keyword (manual markers, e.g. "Rush").
 */
export function stackKeywords(stack: Stack): Set<string> {
  const out = new Set<string>();
  const cards = stack.cards;
  cards.forEach((c, i) => {
    const info = cardInfo(c.cardId);
    if (!info) return;
    const isTop = i === cards.length - 1;
    for (const k of keywordsIn(isTop ? info.effect : info.digivolveEffect)) out.add(k);
  });
  for (const m of [...(stack.markers ?? []), ...(stack.tempMarkers ?? [])]) out.add(m);
  return out;
}

export function hasKeyword(stack: Stack, keyword: string): boolean {
  return stackKeywords(stack).has(keyword);
}

/** Battle DP of a stack: the top card's DP plus its modifiers. Unknown cards count as 0. */
export function stackDp(stack: Stack): number {
  return (topInfo(stack)?.dp ?? 0) + stackDpMod(stack);
}

/** Checks a security attack makes: 1 plus the Security Attack modifiers, never below 0. */
export function securityChecks(stack: Stack): number {
  return Math.max(0, 1 + securityAttackMod(stackKeywords(stack)));
}

/** Removes a stack from any of the owner's stack zones and returns it, or null. */
export function takeStack(p: PlayerState, stackId: string): Stack | null {
  if (p.breeding?.stackId === stackId) {
    const s = p.breeding;
    p.breeding = null;
    return s;
  }
  for (const zone of ['battle', 'tamer', 'option'] as const) {
    const idx = p[zone].findIndex((s) => s.stackId === stackId);
    if (idx !== -1) return p[zone].splice(idx, 1)[0];
  }
  return null;
}

export function findStack(p: PlayerState, stackId: string): Stack | null {
  return allStacks(p).find((s) => s.stackId === stackId) ?? null;
}

/** Display name of a stack's top card (log text). */
export function stackName(stack: Stack): string {
  return cardLabel(topCard(stack)?.cardId ?? '');
}

/** Deletes a stack: every card goes to the owner's trash, then its On Deletion reminder fires. */
export function deleteOwnStack(state: GameState, owner: PlayerIndex, stackId: string): void {
  const p = state.players[owner];
  const stack = takeStack(p, stackId);
  if (!stack) return;
  log(state, owner, `${stackName(stack)} is deleted${stack.cards.length > 1 ? ` with ${stack.cards.length - 1} digivolution card(s)` : ''}.`);
  p.trash.push(...stack.cards.map((c) => ({ uid: c.uid, cardId: c.cardId })));
  remindStack(state, owner, stack, 'On Deletion');
}

export function log(state: GameState, player: PlayerIndex, text: string): void {
  state.log.push({ seq: state.log.length, turn: state.turn, player, text });
}

export function setWinner(state: GameState, winner: PlayerIndex, reason: string): void {
  state.winner = winner;
  state.winReason = reason;
  state.pending = null;
  log(state, winner, `${state.players[winner].name} wins: ${reason}`);
}

/** Pushes one reminder per timing tag found on the matching lines of the card's text. */
export function remind(state: GameState, owner: PlayerIndex, cardId: string, timing: string): void {
  const info = cardInfo(cardId);
  if (!info) return;
  const body = timing === 'Security' ? info.securityEffect : info.effect;
  const lines = linesWithTiming(body, timing);
  if (lines.length === 0) return;
  const list = state.reminders ?? [];
  for (const line of lines) {
    state.nextId += 1;
    list.push({ id: state.nextId, turn: state.turn, player: owner, cardName: info.name, timing, text: line });
  }
  state.reminders = list.slice(-MAX_REMINDERS);
}

/** Reminders for every timing tag on a stack's top card, for the given timing. */
export function remindStack(state: GameState, owner: PlayerIndex, stack: Stack, timing: string): void {
  const top = topCard(stack);
  if (top) remind(state, owner, top.cardId, timing);
}

/**
 * Official rule: during your turn (memory 0 or on your side) you may pay any cost, even more
 * than you have; the gauge moves to the opponent's side (capped at 10) and your turn ends after
 * the action. So a cost is payable whenever it is still your turn.
 */
export function canPay(state: GameState, cost: number): boolean {
  return cost <= 0 || state.memory >= 0;
}

/** Spends memory toward the opponent. The gauge may cross to their side; the turn then ends after the action. */
export function payCost(state: GameState, cost: number): void {
  if (cost <= 0) return;
  state.memory = clampMemory(state.memory - cost);
  log(state, state.activePlayer, `Paid ${cost} memory (gauge ${state.memory >= 0 ? '+' : ''}${state.memory}).`);
}

/** Draws one card. An empty deck loses the game for the drawer. Returns false when that happened. */
export function drawOne(state: GameState, owner: PlayerIndex): boolean {
  const p = state.players[owner];
  const card = p.deck.pop();
  if (!card) {
    setWinner(state, other(owner), `${p.name} had to draw from an empty deck`);
    return false;
  }
  p.hand.push(card);
  log(state, owner, `${p.name} drew a card.`);
  return true;
}

/**
 * Digivolution cost of putting `source` onto `target`, or null when no digivolveCondition matches the target's top
 * card (level and colour). Digi-Eggs and unknown cards never match.
 */
export function digivolveCost(target: Stack, source: CardInfo): number | null {
  const top = topInfo(target);
  if (!top || top.kind === 'egg' || top.level === null) return null;
  const rule = source.digivolve.find((d) => d.level === top.level && top.colors.includes(d.color));
  return rule ? rule.cost : null;
}

/** Colours a player's side provides: top cards of the battle, breeding and tamer areas. */
export function sideColors(p: PlayerState): Set<string> {
  const out = new Set<string>();
  for (const s of [...(p.breeding ? [p.breeding] : []), ...p.battle, ...p.tamer]) {
    for (const c of topInfo(s)?.colors ?? []) out.add(c);
  }
  return out;
}
