/**
 * Resolves the effect queue. Runs at the end of every command (reducer.ts), so one undo step covers a trigger and
 * everything it resolved. It stops whenever a choice is needed (state.pending kind 'effect') and continues after the
 * owner answers through the `resolveEffect` command.
 *
 * Determinism. Every peer runs the same queue on the same public information, so the same command produces the same
 * state everywhere. Choices are the controller's. Options name uids or stack ids, never hidden card ids.
 */
import type { GameState, PlayerIndex, PlayerState, Stack } from '../types';
import type { Action, Cmp, Condition, Duration, EffectOption, Filter, QueueItem, Target } from './ast';
import { beginResolution, endResolution, enqueue, triggerTiming } from './queue';
import { parsedCard } from './parser';
import { CardInfo, cardInfo } from '../rules/card-data';
import { allStacks, deleteOwnStack, drawOne, findStack, log, other, stackDp, stackName, takeStack, topInfo } from '../rules/helpers';
import { resumeAttack } from '../rules/combat';
import { cardLabel } from '../labels';
import { stackDpMod } from '../game';

type Exec = 'performed' | 'nothing' | 'wait';

const MEMORY_RANGE = 10;
const clamp = (v: number): number => Math.max(-MEMORY_RANGE, Math.min(MEMORY_RANGE, Math.round(v)));

/** Display tag for the log, in the card's own spelling. */
const TAG_OF: Record<string, string> = {
  onPlay: 'On Play',
  whenDigivolving: 'When Digivolving',
  whenAttacking: 'When Attacking',
  onDeletion: 'On Deletion',
  security: 'Security',
  main: 'Main',
  startOfYourTurn: 'Start of Your Turn',
  startOfYourMainPhase: 'Start of Your Main Phase',
  endOfYourTurn: 'End of Your Turn',
};

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

/** Resolves as much of the queue as possible. Stops at a pending decision, a block or security check, or the end. */
export function runEffects(state: GameState): void {
  if (!state.effectQueue || state.effectQueue.length === 0) return;
  beginResolution();
  try {
    for (let guard = 0; guard < 2000; guard++) {
      if (state.winner !== null && state.winner !== undefined) {
        state.effectQueue = [];
        if (state.pending?.kind === 'effect') state.pending = null;
        return;
      }
      if (state.pending) return;
      const head = state.effectQueue?.[0];
      if (!head) return;
      if (head.kind === 'attack') {
        state.effectQueue = state.effectQueue!.slice(1);
        resumeAttack(state, head.attacker, head.attackerStackId, head.target);
        continue;
      }
      if (head.actions.length === 0) {
        state.effectQueue = state.effectQueue!.slice(1);
        continue;
      }
      if (head.optional && !head.asked) {
        head.asked = true;
        state.pending = {
          kind: 'effect',
          owner: head.owner,
          mode: 'confirm',
          cardName: head.cardName,
          prompt: `${head.cardName}: use this effect? ${head.text}`,
          options: [],
          min: 0,
          max: 0,
        };
        return;
      }
      if (!head.started) {
        head.started = true;
        log(state, head.owner, `${head.cardName} [${TAG_OF[head.timing] ?? head.timing}]: ${head.text}`);
      }
      const action = head.actions[0];
      if (action.when && !conditionHolds(state, head, action.when)) {
        head.actions.shift();
        head.lastPerformed = false;
        continue;
      }
      const r = execute(state, head, action);
      if (r === 'wait') return;
      head.actions.shift();
      head.stage = undefined;
      head.lastPerformed = r === 'performed';
    }
  } finally {
    endResolution();
  }
}

/**
 * Applies the controller's answer to the pending effect choice. The head of the queue is the item waiting on it.
 * Throws for an invalid answer. Afterwards the caller runs `runEffects` again.
 */
export function resolveEffectChoice(state: GameState, picks: string[] | undefined, yes: boolean | undefined): void {
  const pend = state.pending;
  if (!pend || pend.kind !== 'effect') throw new Error('No effect choice is pending.');
  const head = state.effectQueue?.[0];
  if (!head || head.kind !== 'effect') throw new Error('No effect is waiting for a choice.');
  if (pend.mode === 'confirm') {
    state.pending = null;
    if (!yes) {
      state.effectQueue = state.effectQueue!.slice(1);
      log(state, head.owner, `${head.cardName}: effect not used.`);
    }
    return;
  }
  const chosen = picks ?? [];
  if (new Set(chosen).size !== chosen.length) throw new Error('Choose each card once.');
  if (chosen.length < pend.min || chosen.length > pend.max) {
    throw new Error(pend.min === pend.max ? `Choose exactly ${pend.min}.` : `Choose ${pend.min} to ${pend.max}.`);
  }
  const valid = new Set(pend.options.map((o) => o.id));
  if (chosen.some((id) => !valid.has(id))) throw new Error('That choice is not available.');
  state.pending = null;
  beginResolution();
  try {
    const action = head.actions[0];
    const r = execute(state, head, action, chosen);
    if (r === 'wait') return;
    head.actions.shift();
    head.stage = undefined;
    head.lastPerformed = r === 'performed';
  } finally {
    endResolution();
  }
}

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

function cmpOk(v: number | null | undefined, c: Cmp): boolean {
  if (v === null || v === undefined) return false;
  if (c.op === 'eq') return v === c.n;
  if (c.op === 'le') return v <= c.n;
  return v >= c.n;
}

/** Whether a card's printed data matches a filter. Unknown cards match only the empty filter. */
export function matchCard(info: CardInfo | undefined, f: Filter): boolean {
  if (!f.cardType && !f.color && !f.level && !f.dp && !f.cost && !f.nameContains) return true;
  if (!info) return false;
  if (f.cardType && info.kind !== f.cardType) return false;
  if (f.color && !info.colors.map((c) => c.toLowerCase()).includes(f.color)) return false;
  if (f.level && !cmpOk(info.level, f.level)) return false;
  if (f.dp && !cmpOk(info.dp, f.dp)) return false;
  if (f.cost && !cmpOk(info.playCost, f.cost)) return false;
  if (f.nameContains && !info.name.toLowerCase().includes(f.nameContains)) return false;
  return true;
}

/** Whether a battle stack matches a filter. DP is the stack's current DP, modifiers included. */
export function matchStack(s: Stack, f: Filter): boolean {
  const info = topInfo(s);
  if (!info) return false;
  if (f.cardType && info.kind !== f.cardType) return false;
  if (f.color && !info.colors.map((c) => c.toLowerCase()).includes(f.color)) return false;
  if (f.level && !cmpOk(info.level, f.level)) return false;
  if (f.dp && !cmpOk(stackDp(s), f.dp)) return false;
  if (f.cost && !cmpOk(info.playCost, f.cost)) return false;
  if (f.nameContains && !info.name.toLowerCase().includes(f.nameContains)) return false;
  if (f.suspended && !s.suspended) return false;
  if (f.noDigivolution && s.cards.length !== 1) return false;
  return true;
}

/** The controller's side of the gauge: positive when they are the active player and hold memory. */
function ownMemory(state: GameState, owner: PlayerIndex): number {
  return state.activePlayer === owner ? state.memory : -state.memory;
}

/**
 * The turn an until-turn effect ends on. The current turn belongs to `state.activePlayer`, so the next turn of the
 * other player is one later, and the next turn of the active player is two later.
 */
function untilTurnFor(state: GameState, owner: PlayerIndex, d: 'opponentNextTurn' | 'yourNextTurn'): number {
  const whoseTurn = d === 'opponentNextTurn' ? other(owner) : owner;
  return state.activePlayer === whoseTurn ? state.turn + 2 : state.turn + 1;
}

const isUntilTurn = (d: Duration): d is 'opponentNextTurn' | 'yourNextTurn' => d === 'opponentNextTurn' || d === 'yourNextTurn';

function conditionHolds(state: GameState, q: Extract<QueueItem, { kind: 'effect' }>, c: Condition): boolean {
  const p = state.players[q.owner];
  const opp = state.players[other(q.owner)];
  switch (c.kind) {
    case 'handAtLeast':
      return p.hand.length >= c.n;
    case 'handAtMost':
      return p.hand.length <= c.n;
    case 'securityAtLeast':
      return p.security.length >= c.n;
    case 'securityAtMost':
      return p.security.length <= c.n;
    case 'colorInPlay':
      return p.battle.some((s) => (topInfo(s)?.colors ?? []).map((x) => x.toLowerCase()).includes(c.color));
    case 'opponentHasNoDigivolutionDigimon':
      return opp.battle.some((s) => s.cards.length === 1 && topInfo(s)?.kind === 'digimon');
    case 'opponentHasDigimon':
      return opp.battle.some((s) => topInfo(s)?.kind === 'digimon');
    case 'memoryAtMost':
      return ownMemory(state, q.owner) <= c.n;
    case 'ifDone':
      return q.lastPerformed === true;
  }
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

type SelectTarget = Extract<Target, { kind: 'select' }>;

function sideOf(controller: PlayerIndex, t: SelectTarget): PlayerIndex {
  return t.side === 'own' ? controller : other(controller);
}

/** Every legal choice for a select target, in board order. */
export function candidates(state: GameState, controller: PlayerIndex, t: SelectTarget): EffectOption[] {
  const side = sideOf(controller, t);
  const p: PlayerState = state.players[side];
  if (t.zone === 'battle') {
    return p.battle
      .filter((s) => matchStack(s, t.filter))
      .map((s) => ({ id: s.stackId, side, zone: 'battle' as const, label: stackName(s) }));
  }
  const pile = t.zone === 'trash' ? p.trash : t.zone === 'hand' ? p.hand : p.reveal;
  return pile
    .filter((c) => matchCard(cardInfo(c.cardId), t.filter))
    .map((c) => ({
      id: c.uid,
      side,
      zone: t.zone,
      // Trash is public, so its names may show. Hand and reveal labels stay empty so both peers hold the same pending state.
      label: t.zone === 'trash' ? cardLabel(c.cardId) : '',
    }));
}

/** The stack this effect's card sits on, on its controller's board. */
function selfStackId(state: GameState, q: { owner: PlayerIndex; sourceUid: string }): string | null {
  const s = allStacks(state.players[q.owner]).find((x) => x.cards.some((c) => c.uid === q.sourceUid));
  return s ? s.stackId : null;
}

/**
 * Runs a targeted action. Without `picks`, it either applies to every candidate (no choice needed) or asks for a
 * pick. With `picks`, it applies the owner's answer.
 */
function targeted(
  state: GameState,
  q: Extract<QueueItem, { kind: 'effect' }>,
  target: Target,
  picks: string[] | undefined,
  apply: (owner: PlayerIndex, ids: string[]) => void,
): Exec {
  if (target.kind === 'self') {
    const id = selfStackId(state, q);
    if (!id) return 'nothing';
    apply(q.owner, [id]);
    return 'performed';
  }
  const owner = sideOf(q.owner, target);
  if (picks !== undefined) {
    if (picks.length === 0) return 'nothing';
    apply(owner, picks);
    return 'performed';
  }
  const options = candidates(state, q.owner, target);
  if (options.length === 0) return 'nothing';
  if (target.mode === 'all' || options.length <= target.n) {
    apply(
      owner,
      options.map((o) => o.id),
    );
    return 'performed';
  }
  const min = target.mode === 'upTo' ? 0 : target.n;
  state.pending = {
    kind: 'effect',
    owner: q.owner,
    mode: 'pick',
    cardName: q.cardName,
    prompt: `${q.cardName}: choose ${min === target.n ? target.n : `up to ${target.n}`}.`,
    options,
    min,
    max: target.n,
  };
  return 'wait';
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

function execute(state: GameState, q: Extract<QueueItem, { kind: 'effect' }>, action: Action, picks?: string[]): Exec {
  const me = state.players[q.owner];
  switch (action.type) {
    case 'draw': {
      let any = false;
      for (let i = 0; i < action.n; i++) {
        if (!drawOne(state, q.owner)) break;
        any = true;
      }
      return any ? 'performed' : 'nothing';
    }

    case 'memory': {
      // Positive is the active player's side of the gauge. A controller who is not active moves it the other way.
      const sign = state.activePlayer === q.owner ? 1 : -1;
      state.memory = clamp(state.memory + sign * action.delta);
      log(state, q.owner, `Memory ${action.delta >= 0 ? 'gained' : 'lost'} ${Math.abs(action.delta)} (gauge ${state.memory >= 0 ? '+' : ''}${state.memory}).`);
      return 'performed';
    }

    case 'dp':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        for (const id of ids) {
          const s = findStack(state.players[owner], id);
          if (!s) continue;
          if (isUntilTurn(action.duration)) {
            s.timedMods = [...(s.timedMods ?? []), { until: untilTurnFor(state, q.owner, action.duration), dp: action.delta }];
            log(state, q.owner, `${stackName(s)} ${action.delta >= 0 ? '+' : ''}${action.delta} DP until the end of turn ${untilTurnFor(state, q.owner, action.duration)}.`);
            continue;
          }
          s.tempDpMod = (s.tempDpMod ?? 0) + action.delta;
          log(state, q.owner, `${stackName(s)} ${action.delta >= 0 ? '+' : ''}${action.delta} DP for the turn (modifier ${stackDpMod(s) >= 0 ? '+' : ''}${stackDpMod(s)}).`);
        }
      });

    case 'keyword':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        for (const id of ids) {
          const s = findStack(state.players[owner], id);
          if (!s) continue;
          addMarker(state, q, s, action.keyword, action.duration);
          log(state, q.owner, `${stackName(s)} gains ${action.keyword} ${durationWords(action.duration)}.`);
        }
      });

    case 'cant': {
      const marker = action.what === 'attack' ? "Can't attack" : "Can't block";
      return targeted(state, q, action.target, picks, (owner, ids) => {
        for (const id of ids) {
          const s = findStack(state.players[owner], id);
          if (!s) continue;
          addMarker(state, q, s, marker, action.duration);
          log(state, q.owner, `${stackName(s)} ${marker.toLowerCase()} ${durationWords(action.duration)}.`);
        }
      });
    }

    case 'memorySet': {
      // "Set it to N" moves the controller's side of the gauge to N.
      state.memory = clamp(action.n * (state.activePlayer === q.owner ? 1 : -1));
      log(state, q.owner, `${me.name} set memory to ${action.n} (gauge ${state.memory >= 0 ? '+' : ''}${state.memory}).`);
      return 'performed';
    }

    case 'suspend':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        for (const id of ids) {
          const s = findStack(state.players[owner], id);
          if (!s) continue;
          s.suspended = action.suspended;
          log(state, q.owner, `${action.suspended ? 'Suspended' : 'Unsuspended'} ${stackName(s)}.`);
        }
      });

    case 'delete':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        for (const id of ids) deleteOwnStack(state, owner, id);
      });

    case 'returnToHand': {
      const t = action.target;
      return targeted(state, q, t, picks, (owner, ids) => {
        const p = state.players[owner];
        if (t.kind === 'select' && t.zone === 'trash') {
          for (const uid of ids) {
            const idx = p.trash.findIndex((c) => c.uid === uid);
            if (idx >= 0) p.hand.push(...p.trash.splice(idx, 1));
          }
          log(state, owner, `${p.name} returned ${ids.length} card(s) from the trash to hand.`);
          return;
        }
        for (const id of ids) {
          const s = takeStack(p, id);
          if (!s) continue;
          p.hand.push(...s.cards);
          log(state, owner, `${p.name} returned ${stackName(s)} to hand.`);
        }
      });
    }

    case 'returnToDeckBottom':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        const p = state.players[owner];
        for (const id of ids) {
          const s = takeStack(p, id);
          if (!s) continue;
          p.deck.unshift(...s.cards);
          log(state, owner, `${p.name} put ${stackName(s)} at the bottom of their deck.`);
        }
      });

    case 'deDigivolve':
      return targeted(state, q, action.target, picks, (owner, ids) => {
        const p = state.players[owner];
        for (const id of ids) {
          const s = findStack(p, id);
          if (!s) continue;
          const k = Math.min(action.n, s.cards.length - 1);
          if (k <= 0) continue;
          const removed = s.cards.splice(s.cards.length - 1 - k, k);
          p.trash.push(...removed.map((c) => ({ uid: c.uid, cardId: c.cardId })));
          log(state, owner, `${stackName(s)} de-digivolved by ${k}.`);
        }
      });

    case 'trashFromHand': {
      const ids = picks ?? [];
      if (picks === undefined) {
        // Hand choices always need the owner's pick (the hand is private), unless there is nothing to trash.
        const n = action.target.kind === 'select' ? action.target.n : 0;
        const opts = me.hand.map((c) => ({ id: c.uid, side: q.owner, zone: 'hand' as const, label: '' }));
        if (opts.length === 0) return 'nothing';
        if (opts.length <= n) {
          moveHandToTrash(state, q.owner, opts.map((o) => o.id));
          return 'performed';
        }
        state.pending = { kind: 'effect', owner: q.owner, mode: 'pick', cardName: q.cardName, prompt: `${q.cardName}: trash ${n} card(s) from your hand.`, options: opts, min: n, max: n };
        return 'wait';
      }
      if (ids.length === 0) return 'nothing';
      moveHandToTrash(state, q.owner, ids);
      return 'performed';
    }

    case 'trashDeckTop': {
      let moved = 0;
      for (let i = 0; i < action.n; i++) {
        const c = me.deck.pop();
        if (!c) break;
        me.trash.push(c);
        moved++;
      }
      log(state, q.owner, `${me.name} trashed ${moved} card(s) from the top of their deck.`);
      return moved > 0 ? 'performed' : 'nothing';
    }

    case 'recovery': {
      let moved = 0;
      for (let i = 0; i < action.n; i++) {
        const c = me.deck.pop();
        if (!c) break;
        me.security.push({ uid: c.uid, cardId: c.cardId, faceUp: false });
        moved++;
      }
      log(state, q.owner, `${me.name} recovered ${moved} card(s) to security.`);
      return moved > 0 ? 'performed' : 'nothing';
    }

    case 'revealTop':
      return revealTop(state, q, action, picks);

    case 'addSourceToHand': {
      const idx = me.trash.findIndex((c) => c.uid === q.sourceUid);
      if (idx < 0) return 'nothing';
      me.hand.push(...me.trash.splice(idx, 1));
      log(state, q.owner, `${me.name} added ${q.cardName} to hand.`);
      return 'performed';
    }

    case 'playSource': {
      const idx = me.trash.findIndex((c) => c.uid === q.sourceUid);
      if (idx < 0) return 'nothing';
      const info = cardInfo(q.cardId);
      if (!info || (info.kind !== 'tamer' && info.kind !== 'digimon')) return 'nothing';
      const [card] = me.trash.splice(idx, 1);
      const stack = { stackId: `s${state.nextId++}`, cards: [card], suspended: false, dpMod: 0, enteredTurn: state.turn };
      (info.kind === 'tamer' ? me.tamer : me.battle).push(stack);
      log(state, q.owner, `${me.name} played ${info.name} without paying the cost.`);
      triggerTiming(state, q.owner, [{ uid: card.uid, cardId: card.cardId, field: 'effect' }], 'On Play');
      return 'performed';
    }

    case 'activateMain': {
      const info = cardInfo(q.cardId);
      if (!info) return 'nothing';
      const items: QueueItem[] = [];
      for (const b of parsedCard(info.id, { effect: info.effect, digivolveEffect: info.digivolveEffect, securityEffect: info.securityEffect }).blocks) {
        if (b.field !== 'effect' || !b.actions || !b.timings.includes('main')) continue;
        items.push({
          kind: 'effect',
          owner: q.owner,
          cardName: info.name,
          cardId: info.id,
          sourceUid: q.sourceUid,
          timing: 'main',
          optional: b.optional,
          actions: b.actions.slice(),
          text: b.lines.join(' '),
        });
      }
      if (items.length === 0) return 'nothing';
      enqueue(state, items);
      return 'performed';
    }
  }
}

/** Adds a marker for a duration: until the end of this turn (cleared with the other temporary effects) or a later one. */
function addMarker(state: GameState, q: Extract<QueueItem, { kind: 'effect' }>, s: Stack, marker: string, d: Duration): void {
  if (isUntilTurn(d)) {
    s.timedMods = [...(s.timedMods ?? []), { until: untilTurnFor(state, q.owner, d), marker }];
    return;
  }
  s.tempMarkers = [...(s.tempMarkers ?? []), marker];
}

function durationWords(d: Duration): string {
  if (d === 'opponentNextTurn') return "until the end of your opponent's next turn";
  if (d === 'yourNextTurn') return 'until the end of your next turn';
  return 'for the turn';
}

function moveHandToTrash(state: GameState, owner: PlayerIndex, uids: string[]): void {
  const p = state.players[owner];
  for (const uid of uids) {
    const idx = p.hand.findIndex((c) => c.uid === uid);
    if (idx >= 0) p.trash.push(...p.hand.splice(idx, 1));
  }
  log(state, owner, `${p.name} trashed ${uids.length} card(s) from hand.`);
}

/**
 * Reveal the top n cards, then each pick takes matching cards to hand (asking when there are too many). The rest go to
 * the bottom of the deck. Re-entrant: `stage` remembers which pick is next, and `picks` answers the pick at that stage.
 */
function revealTop(
  state: GameState,
  q: Extract<QueueItem, { kind: 'effect' }>,
  action: Extract<Action, { type: 'revealTop' }>,
  picks: string[] | undefined,
): Exec {
  const p = state.players[q.owner];
  if (q.stage === undefined) {
    let moved = 0;
    for (let i = 0; i < action.n; i++) {
      const c = p.deck.pop();
      if (!c) break;
      p.reveal.push(c);
      moved++;
    }
    log(state, q.owner, `${p.name} revealed ${moved} card(s) from the top of the deck.`);
    q.stage = 0;
  }
  if (picks !== undefined && q.stage < action.picks.length) {
    const chosen = picks;
    for (const uid of chosen) {
      const idx = p.reveal.findIndex((c) => c.uid === uid);
      if (idx >= 0) p.hand.push(...p.reveal.splice(idx, 1));
    }
    q.stage++;
  }
  while (q.stage < action.picks.length) {
    const pick = action.picks[q.stage];
    const options: EffectOption[] = p.reveal
      .filter((c) => matchCard(cardInfo(c.cardId), pick.filter))
      .map((c) => ({ id: c.uid, side: q.owner, zone: 'reveal' as const, label: '' }));
    if (options.length === 0) {
      q.stage++;
      continue;
    }
    if (options.length <= pick.n) {
      for (const o of options) {
        const idx = p.reveal.findIndex((c) => c.uid === o.id);
        if (idx >= 0) p.hand.push(...p.reveal.splice(idx, 1));
      }
      q.stage++;
      continue;
    }
    state.pending = {
      kind: 'effect',
      owner: q.owner,
      mode: 'pick',
      cardName: q.cardName,
      prompt: `${q.cardName}: choose ${pick.n} card(s) from the revealed cards.`,
      options,
      min: pick.n,
      max: pick.n,
    };
    return 'wait';
  }
  const rest = p.reveal.splice(0);
  p.deck.unshift(...rest);
  q.stage = undefined;
  return 'performed';
}

