/**
 * Pure command reducer. applyCommand never mutates its input: it works on a deep copy and returns it.
 * Invalid commands throw an Error with a readable message; callers should catch and show it.
 */
import { Command } from './commands';
import { allCards, dealBoard, getStack, locateCard, locateStack, pileOf, cloneState } from './game';
import { shuffle } from './rng';
import { HIDDEN_CARD_ID } from './view';
import {
  CardRef,
  GameState,
  MEMORY_MAX,
  MEMORY_MIN,
  PHASES,
  PileZone,
  PlayerIndex,
  PlayerState,
  SecurityCard,
  Stack,
  StackZone,
  Zone,
} from './types';

const DEFAULT_PASS_MEMORY = 3;
const MULLIGAN_HAND_SIZE = 5;

export function clampMemory(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Memory must be a number');
  return Math.max(MEMORY_MIN, Math.min(MEMORY_MAX, Math.round(value)));
}

export function applyCommand(input: GameState, cmd: Command): GameState {
  if (cmd.player !== 0 && cmd.player !== 1) throw new Error(`Invalid player ${String(cmd.player)}`);
  const state = cloneState(input);
  const p = state.players[cmd.player];
  const who = p.name;
  if (cmd.reveals) applyReveals(p, cmd.reveals);

  const say = (text: string) => {
    state.log.push({ seq: state.log.length, turn: state.turn, player: cmd.player, text });
  };
  const mintStackId = (): string => `s${state.nextId++}`;

  switch (cmd.type) {
    // ---- setup / turn structure ---------------------------------------------------------
    case 'setup': {
      const dealt = dealBoard(p, state.rngState);
      state.players[cmd.player] = dealt.player;
      state.rngState = dealt.rngState;
      say(`${who} reset their board and drew a new opening hand.`);
      break;
    }

    case 'mulligan': {
      const shuffled = shuffle([...p.deck, ...p.hand], state.rngState);
      state.rngState = shuffled.rngState;
      p.deck = shuffled.value;
      p.hand = [];
      drawCards(p, MULLIGAN_HAND_SIZE);
      say(`${who} mulliganed to ${p.hand.length}.`);
      break;
    }

    case 'draw': {
      const count = cmd.count ?? 1;
      if (count < 1) throw new Error('Draw count must be at least 1');
      if (p.deck.length === 0) throw new Error(`${who}'s deck is empty`);
      drawCards(p, count);
      say(`${who} drew ${Math.min(count, p.hand.length)} card(s).`);
      break;
    }

    case 'shuffleDeck': {
      const zone = cmd.zone ?? 'deck';
      const pile = zone === 'eggDeck' ? p.eggDeck : p.deck;
      const shuffled = shuffle(pile, state.rngState);
      state.rngState = shuffled.rngState;
      if (zone === 'eggDeck') p.eggDeck = shuffled.value;
      else p.deck = shuffled.value;
      say(`${who} shuffled their ${zone === 'eggDeck' ? 'egg deck' : 'deck'}.`);
      break;
    }

    case 'nextPhase': {
      const idx = PHASES.indexOf(state.phase);
      if (idx === PHASES.length - 1) throw new Error('Already at the end phase. End the turn to continue.');
      state.phase = PHASES[idx + 1];
      say(`Phase: ${state.phase}.`);
      break;
    }

    case 'passTurn': {
      const next: PlayerIndex = state.activePlayer === 0 ? 1 : 0;
      const memory = clampMemory(cmd.memory ?? DEFAULT_PASS_MEMORY);
      state.activePlayer = next;
      state.turn += 1;
      state.phase = 'unsuspend';
      state.memory = memory;
      say(`${who} ended the turn. ${state.players[next].name} is active with memory ${memory >= 0 ? '+' : ''}${memory}.`);
      break;
    }

    case 'setMemory': {
      state.memory = clampMemory(cmd.value);
      say(`Memory set to ${state.memory >= 0 ? '+' : ''}${state.memory}.`);
      break;
    }

    case 'changeMemoryBy': {
      state.memory = clampMemory(state.memory + cmd.delta);
      say(`Memory is now ${state.memory >= 0 ? '+' : ''}${state.memory}.`);
      break;
    }

    // ---- card movement -----------------------------------------------------------------
    case 'hatch': {
      if (p.breeding) throw new Error('Breeding area is occupied');
      const egg = p.eggDeck.pop();
      if (!egg) throw new Error(`${who}'s egg deck is empty`);
      p.breeding = { stackId: mintStackId(), cards: [egg], suspended: false, dpMod: 0 };
      say(`${who} hatched an egg (${egg.cardId}).`);
      break;
    }

    case 'moveBreedingToBattle': {
      if (!p.breeding) throw new Error('Breeding area is empty');
      p.battle.push(p.breeding);
      const top = p.breeding.cards[p.breeding.cards.length - 1];
      p.breeding = null;
      say(`${who} moved ${top?.cardId ?? 'a digimon'} from breeding to battle.`);
      break;
    }

    case 'playFromHand': {
      const card = takeFromHand(p, cmd.uid);
      const stack = newStack(mintStackId(), [card]);
      (cmd.to === 'battle' ? p.battle : cmd.to === 'tamer' ? p.tamer : p.option).push(stack);
      say(`${who} played ${card.cardId} to the ${cmd.to} area.`);
      break;
    }

    case 'digivolve': {
      const card = takeFromHand(p, cmd.handUid);
      const stack = p.battle.find((s) => s.stackId === cmd.onto);
      if (!stack) {
        // Put the card back so a failed command leaves no trace (the clone is discarded anyway).
        throw new Error('Digivolution target is not in the battle area');
      }
      stack.cards.push(card);
      say(`${who} digivolved into ${card.cardId}.`);
      break;
    }

    case 'moveCard': {
      const to = cmd.to as Zone;
      // A card moved from a hidden place to another hidden place is logged without its identity,
      // so the opponent's log cannot leak it.
      const hiddenSource = isHiddenCard(p, cmd.uid);
      const hiddenTarget = isHiddenZone(to, cmd.faceUp);
      const card = removeCard(p, cmd.uid);
      const ref: CardRef = { uid: card.uid, cardId: card.cardId };
      const label = hiddenSource && hiddenTarget ? 'a card' : ref.cardId;
      if (isStackZone(to)) {
        const stack = newStack(mintStackId(), [ref]);
        if (to === 'breeding') {
          if (p.breeding) throw new Error('Breeding area is occupied');
          p.breeding = stack;
        } else {
          stackArray(p, to).push(stack);
        }
        say(`${who} moved ${label} to the ${to} area.`);
        break;
      }
      const pile = pileOf(p, to as PileZone);
      if (to === 'security') {
        const sec: SecurityCard = { ...ref, faceUp: !!cmd.faceUp };
        if (cmd.position === 'bottom') p.security.unshift(sec);
        else p.security.push(sec);
      } else if (cmd.position === 'bottom') {
        pile.unshift(ref);
      } else {
        pile.push(ref);
      }
      say(`${who} moved ${label} to ${to} (${cmd.position ?? 'top'}).`);
      break;
    }

    case 'revealSecurity': {
      const sec = cmd.position === 'bottom' ? p.security.shift() : p.security.pop();
      if (!sec) throw new Error(`${who} has no security cards`);
      p.reveal.push({ uid: sec.uid, cardId: sec.cardId });
      say(`${who} revealed security ${sec.cardId}.`);
      break;
    }

    case 'setFaceUp': {
      const sec = p.security.find((c) => c.uid === cmd.uid);
      if (!sec) throw new Error('Only security cards can be turned face-up or face-down here');
      sec.faceUp = cmd.faceUp;
      say(`${who} turned security ${sec.faceUp ? 'face-up' : 'face-down'}.`);
      break;
    }

    // ---- stack operations --------------------------------------------------------------
    case 'suspend':
    case 'unsuspend': {
      const stack = requireStack(p, cmd.stackId);
      stack.suspended = cmd.type === 'suspend';
      say(`${who} ${cmd.type === 'suspend' ? 'suspended' : 'unsuspended'} ${topName(stack)}.`);
      break;
    }

    case 'unsuspendAll': {
      for (const s of [...p.battle, ...p.tamer, ...p.option, ...(p.breeding ? [p.breeding] : [])]) s.suspended = false;
      say(`${who} unsuspended all.`);
      break;
    }

    case 'setStackFaceDown': {
      const stack = requireStack(p, cmd.stackId);
      stack.faceDown = cmd.faceDown;
      say(`${who} turned ${topName(stack)} ${cmd.faceDown ? 'face-down' : 'face-up'}.`);
      break;
    }

    case 'adjustDp': {
      const stack = requireStack(p, cmd.stackId);
      stack.dpMod += cmd.delta;
      say(
        `${who} ${cmd.delta >= 0 ? '+' : ''}${cmd.delta} DP on ${topName(stack)} (modifier ${stack.dpMod >= 0 ? '+' : ''}${stack.dpMod}).`,
      );
      break;
    }

    case 'addMarker': {
      const stack = requireStack(p, cmd.stackId);
      stack.markers = [...(stack.markers ?? []), cmd.marker];
      say(`${who} added marker "${cmd.marker}" to ${topName(stack)}.`);
      break;
    }

    case 'removeMarker': {
      const stack = requireStack(p, cmd.stackId);
      const idx = (stack.markers ?? []).indexOf(cmd.marker);
      if (idx === -1) throw new Error(`Marker "${cmd.marker}" not found`);
      stack.markers!.splice(idx, 1);
      say(`${who} removed marker "${cmd.marker}" from ${topName(stack)}.`);
      break;
    }

    case 'trashStack': {
      const stack = takeStack(p, cmd.stackId);
      p.trash.push(...stack.cards);
      say(`${who} trashed ${topName(stack)}${stack.cards.length > 1 ? ` with ${stack.cards.length - 1} digivolution card(s)` : ''}.`);
      break;
    }

    case 'returnToHand': {
      const stack = takeStack(p, cmd.stackId);
      p.hand.push(...stack.cards);
      say(`${who} returned ${topName(stack)} to hand.`);
      break;
    }

    case 'stackToDeck': {
      const stack = takeStack(p, cmd.stackId);
      if (cmd.position === 'bottom') p.deck.unshift(...stack.cards);
      else p.deck.push(...stack.cards);
      say(`${who} put ${topName(stack)} on the ${cmd.position} of their deck.`);
      break;
    }

    default: {
      const never: never = cmd;
      throw new Error(`Unknown command ${JSON.stringify(never)}`);
    }
  }

  if (cmd.board) state.players[cmd.player] = JSON.parse(JSON.stringify(cmd.board)) as PlayerState;
  return state;
}

// ---------------------------------------------------------------------------------------------
// Helpers (operate on the cloned player, so mutation is safe)
// ---------------------------------------------------------------------------------------------

/** Fills placeholder ('?') cards on the owner's board with the cardIds the sender revealed. */
function applyReveals(p: PlayerState, reveals: Record<string, string>): void {
  for (const card of allCards(p)) {
    if (card.cardId === HIDDEN_CARD_ID && Object.prototype.hasOwnProperty.call(reveals, card.uid)) {
      card.cardId = reveals[card.uid];
    }
  }
}

function drawCards(p: PlayerState, count: number): void {
  for (let i = 0; i < count && p.deck.length > 0; i++) {
    p.hand.push(p.deck.pop()!);
  }
}

function takeFromHand(p: PlayerState, uid: string): CardRef {
  const idx = p.hand.findIndex((c) => c.uid === uid);
  if (idx === -1) throw new Error('Card is not in hand');
  return p.hand.splice(idx, 1)[0];
}

/** Removes a card from wherever it is on the board. Empty stacks disappear. */
function removeCard(p: PlayerState, uid: string): CardRef {
  const loc = locateCard(p, uid);
  if (!loc) throw new Error('Card not found on this board');
  if (loc.kind === 'pile') {
    const pile = pileOf(p, loc.zone);
    return pile.splice(loc.index, 1)[0];
  }
  const stack = loc.zone === 'breeding' ? p.breeding! : stackArray(p, loc.zone).find((s) => s.stackId === loc.stackId)!;
  const [card] = stack.cards.splice(loc.index, 1);
  if (stack.cards.length === 0) {
    if (loc.zone === 'breeding') p.breeding = null;
    else stackArray(p, loc.zone).splice(stackArray(p, loc.zone).indexOf(stack), 1);
  }
  return card;
}

/** True when the card currently sits somewhere its owner's opponent may not see. */
function isHiddenCard(p: PlayerState, uid: string): boolean {
  const loc = locateCard(p, uid);
  if (!loc) return false;
  if (loc.kind === 'stack') return !!getStack(p, loc.stackId)?.faceDown;
  if (loc.zone === 'security') return !p.security[loc.index].faceUp;
  return loc.zone === 'deck' || loc.zone === 'eggDeck' || loc.zone === 'hand';
}

function isHiddenZone(zone: Zone, faceUp?: boolean): boolean {
  if (zone === 'security') return !faceUp;
  return zone === 'deck' || zone === 'eggDeck' || zone === 'hand';
}

function requireStack(p: PlayerState, stackId: string): Stack {
  const stack = getStack(p, stackId);
  if (!stack) throw new Error('Stack not found');
  return stack;
}

/** Removes a stack from its zone and returns it. */
function takeStack(p: PlayerState, stackId: string): Stack {
  const loc = locateStack(p, stackId);
  if (!loc) throw new Error('Stack not found');
  if (loc.zone === 'breeding') {
    const stack = p.breeding!;
    p.breeding = null;
    return stack;
  }
  return stackArray(p, loc.zone).splice(loc.index, 1)[0];
}

function stackArray(p: PlayerState, zone: StackZone): Stack[] {
  switch (zone) {
    case 'battle':
      return p.battle;
    case 'tamer':
      return p.tamer;
    case 'option':
      return p.option;
    case 'breeding':
      throw new Error('Breeding is a single slot, not an array');
  }
}

function isStackZone(zone: Zone): zone is StackZone {
  return zone === 'breeding' || zone === 'battle' || zone === 'tamer' || zone === 'option';
}

function newStack(stackId: string, cards: CardRef[]): Stack {
  return { stackId, cards, suspended: false, dpMod: 0 };
}

function topName(stack: Stack): string {
  const top = stack.cards[stack.cards.length - 1];
  return top ? top.cardId : 'a stack';
}
