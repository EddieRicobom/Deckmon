/**
 * Game construction and state helpers shared by the reducer and the views.
 */
import { shuffle, normaliseSeed } from './rng';
import { CardRef, GameState, PlayerIndex, PlayerState, PileZone, STATE_VERSION, Stack, StackZone, Zone, SecurityCard } from './types';

/** One line of a deck list. `cardType` decides whether the card goes to the egg deck. */
export interface DeckListEntry {
  id: string;
  count: number;
  cardType?: string;
}

export const EGG_CARD_TYPE = 'Digi-Egg';
export const SECURITY_SIZE = 5;
export const OPENING_HAND_SIZE = 5;

export function emptyPlayer(id: PlayerIndex, name: string): PlayerState {
  return {
    id,
    name,
    deck: [],
    eggDeck: [],
    hand: [],
    security: [],
    breeding: null,
    battle: [],
    tamer: [],
    option: [],
    trash: [],
    reveal: [],
    eggUids: [],
  };
}

/** Expands a deck list into card instances. uids are deterministic: `<player>:<index>`. */
export function expandDeck(player: PlayerIndex, entries: readonly DeckListEntry[]): { main: CardRef[]; eggs: CardRef[] } {
  const main: CardRef[] = [];
  const eggs: CardRef[] = [];
  let n = 0;
  for (const entry of entries) {
    const count = Math.max(0, Math.floor(entry.count));
    for (let i = 0; i < count; i++) {
      const ref: CardRef = { uid: `${player}:${n++}`, cardId: entry.id };
      (entry.cardType === EGG_CARD_TYPE ? eggs : main).push(ref);
    }
  }
  return { main, eggs };
}

/** Every card on one board, whatever the zone. */
export function allCards(p: PlayerState): CardRef[] {
  return [
    ...p.deck,
    ...p.eggDeck,
    ...p.hand,
    ...p.security,
    ...p.trash,
    ...p.reveal,
    ...(p.breeding ? p.breeding.cards : []),
    ...p.battle.flatMap((s) => s.cards),
    ...p.tamer.flatMap((s) => s.cards),
    ...p.option.flatMap((s) => s.cards),
  ];
}

/** Collects every card the owner has on their board, face-up or not, back into deck / egg deck. */
function gatherAll(p: PlayerState): { main: CardRef[]; eggs: CardRef[] } {
  const all: CardRef[] = [
    ...p.deck,
    ...p.eggDeck,
    ...p.hand,
    ...p.security,
    ...p.trash,
    ...p.reveal,
    ...(p.breeding ? p.breeding.cards : []),
    ...p.battle.flatMap((s) => s.cards),
    ...p.tamer.flatMap((s) => s.cards),
    ...p.option.flatMap((s) => s.cards),
  ];
  const eggSet = new Set(p.eggUids);
  return {
    main: all.filter((c) => !eggSet.has(c.uid)).map((c) => ({ uid: c.uid, cardId: c.cardId })),
    eggs: all.filter((c) => eggSet.has(c.uid)).map((c) => ({ uid: c.uid, cardId: c.cardId })),
  };
}

/**
 * Resets a board: everything goes back into the piles, both piles are shuffled,
 * then 5 cards are set aside face-down as security and 5 are drawn to hand.
 * Returns the updated player and the advanced PRNG state.
 */
export function dealBoard(p: PlayerState, rngState: number): { player: PlayerState; rngState: number } {
  const { main, eggs } = gatherAll(p);
  const shuffledMain = shuffle(main, rngState);
  const shuffledEggs = shuffle(eggs, shuffledMain.rngState);
  const deck = shuffledMain.value;
  const security: SecurityCard[] = [];
  for (let i = 0; i < SECURITY_SIZE && deck.length > 0; i++) {
    const card = deck.pop()!;
    security.push({ ...card, faceUp: false });
  }
  const hand: CardRef[] = [];
  for (let i = 0; i < OPENING_HAND_SIZE && deck.length > 0; i++) {
    hand.push(deck.pop()!);
  }
  return {
    player: {
      ...p,
      deck,
      eggDeck: shuffledEggs.value,
      hand,
      security,
      breeding: null,
      battle: [],
      tamer: [],
      option: [],
      trash: [],
      reveal: [],
    },
    rngState: shuffledEggs.rngState,
  };
}

export function createGame(
  seed: number,
  deck0: readonly DeckListEntry[],
  deck1: readonly DeckListEntry[],
  names: [string, string] = ['Player 1', 'Player 2'],
): GameState {
  const s = normaliseSeed(seed);
  const build = (idx: PlayerIndex, entries: readonly DeckListEntry[], name: string): PlayerState => {
    const { main, eggs } = expandDeck(idx, entries);
    return { ...emptyPlayer(idx, name), deck: main, eggDeck: eggs, eggUids: eggs.map((c) => c.uid) };
  };
  let rngState = s;
  const dealt0 = dealBoard(build(0, deck0, names[0]), rngState);
  rngState = dealt0.rngState;
  const dealt1 = dealBoard(build(1, deck1, names[1]), rngState);
  rngState = dealt1.rngState;

  return {
    seed: s,
    rngState,
    nextId: 1,
    turn: 1,
    activePlayer: 0,
    phase: 'unsuspend',
    memory: 0,
    players: [dealt0.player, dealt1.player],
    log: [{ seq: 0, turn: 1, player: 0, text: `Game started. ${names[0]} vs ${names[1]}.` }],
    version: STATE_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Lookups. These never mutate.
// ---------------------------------------------------------------------------------------------

export type CardLocation =
  { kind: 'pile'; zone: PileZone; index: number } | { kind: 'stack'; zone: StackZone; stackId: string; index: number };

export function locateCard(p: PlayerState, uid: string): CardLocation | null {
  const piles: PileZone[] = ['deck', 'eggDeck', 'hand', 'security', 'trash', 'reveal'];
  for (const zone of piles) {
    const index = pileOf(p, zone).findIndex((c) => c.uid === uid);
    if (index !== -1) return { kind: 'pile', zone, index };
  }
  const stackZones: StackZone[] = ['breeding', 'battle', 'tamer', 'option'];
  for (const zone of stackZones) {
    for (const stack of stackListOf(p, zone)) {
      const index = stack.cards.findIndex((c) => c.uid === uid);
      if (index !== -1) return { kind: 'stack', zone, stackId: stack.stackId, index };
    }
  }
  return null;
}

export function locateStack(p: PlayerState, stackId: string): { zone: StackZone; index: number } | null {
  if (p.breeding && p.breeding.stackId === stackId) return { zone: 'breeding', index: 0 };
  const stackZones: StackZone[] = ['battle', 'tamer', 'option'];
  for (const zone of stackZones) {
    const index = stackListOf(p, zone).findIndex((s) => s.stackId === stackId);
    if (index !== -1) return { zone, index };
  }
  return null;
}

export function getStack(p: PlayerState, stackId: string): Stack | null {
  const loc = locateStack(p, stackId);
  if (!loc) return null;
  return stackListOf(p, loc.zone)[loc.index] ?? null;
}

/** The array behind a pile zone. Mutating the returned array mutates the player. */
export function pileOf(p: PlayerState, zone: PileZone): CardRef[] {
  switch (zone) {
    case 'deck':
      return p.deck;
    case 'eggDeck':
      return p.eggDeck;
    case 'hand':
      return p.hand;
    case 'security':
      return p.security;
    case 'trash':
      return p.trash;
    case 'reveal':
      return p.reveal;
  }
}

/** Stacks in a stack zone as an array. Breeding is wrapped; the array is a copy for breeding. */
export function stackListOf(p: PlayerState, zone: StackZone): Stack[] {
  switch (zone) {
    case 'breeding':
      return p.breeding ? [p.breeding] : [];
    case 'battle':
      return p.battle;
    case 'tamer':
      return p.tamer;
    case 'option':
      return p.option;
  }
}

/** Zone-independent copy helper: JSON round-trip is enough because state is plain data. */
export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

export function zoneLabel(zone: Zone): string {
  const labels: Record<Zone, string> = {
    deck: 'deck',
    eggDeck: 'egg deck',
    hand: 'hand',
    security: 'security',
    trash: 'trash',
    reveal: 'reveal',
    breeding: 'breeding area',
    battle: 'battle area',
    tamer: 'tamer area',
    option: 'option area',
  };
  return labels[zone];
}
