import { applyCommand } from './reducer';
import { createGame, DeckListEntry } from './game';
import { nextRandom, shuffle } from './rng';
import { createHistory, dispatch, replay, undo, canUndo } from './history';
import { redactFor, HIDDEN_CARD_ID } from './view';
import { GameState } from './types';
import { Command } from './commands';

const deckA: DeckListEntry[] = [
  { id: 'BT1-001', count: 4, cardType: 'Digimon' },
  { id: 'BT1-002', count: 4, cardType: 'Digimon' },
  { id: 'BT1-003', count: 4, cardType: 'Tamer' },
  { id: 'BT1-010', count: 4, cardType: 'Option' },
  { id: 'BT1-011', count: 4, cardType: 'Digimon' },
  { id: 'BT1-012', count: 4, cardType: 'Digimon' },
  { id: 'BT1-013', count: 4, cardType: 'Digimon' },
  { id: 'BT1-014', count: 4, cardType: 'Digimon' },
  { id: 'BT1-015', count: 4, cardType: 'Digimon' },
  { id: 'BT1-016', count: 4, cardType: 'Digimon' },
  { id: 'BT1-017', count: 4, cardType: 'Digimon' },
  { id: 'BT1-018', count: 4, cardType: 'Digimon' },
  { id: 'BT1-019', count: 2, cardType: 'Digimon' },
  { id: 'BT1-020', count: 2, cardType: 'Digi-Egg' },
  { id: 'BT1-021', count: 3, cardType: 'Digi-Egg' },
];

const deckB: DeckListEntry[] = [
  { id: 'BT2-001', count: 50, cardType: 'Digimon' },
  { id: 'BT2-002', count: 5, cardType: 'Digi-Egg' },
];

function newGame(seed = 42): GameState {
  return createGame(seed, deckA, deckB, ['Alice', 'Bob']);
}

function total(state: GameState, player: 0 | 1): number {
  const p = state.players[player];
  const stacks = [...p.battle, ...p.tamer, ...p.option, ...(p.breeding ? [p.breeding] : [])];
  return (
    p.deck.length +
    p.eggDeck.length +
    p.hand.length +
    p.security.length +
    p.trash.length +
    p.reveal.length +
    stacks.reduce((n, s) => n + s.cards.length, 0)
  );
}

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = nextRandom(123);
    const b = nextRandom(123);
    expect(a).toEqual(b);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
  });

  it('shuffles reproducibly and keeps every element', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const s1 = shuffle(items, 999);
    const s2 = shuffle(items, 999);
    const s3 = shuffle(items, 1000);
    expect(s1.value).toEqual(s2.value);
    expect(s1.value).not.toEqual(s3.value);
    expect([...s1.value].sort((x, y) => x - y)).toEqual(items);
  });
});

describe('createGame', () => {
  it('deals 5 face-down security and a 5-card hand', () => {
    const state = newGame();
    for (const p of state.players) {
      expect(p.security).toHaveLength(5);
      expect(p.security.every((c) => c.faceUp === false)).toBe(true);
      expect(p.hand).toHaveLength(5);
    }
  });

  it('separates Digi-Eggs into the egg deck and keeps every card', () => {
    const state = newGame();
    const p0 = state.players[0];
    expect(p0.eggDeck).toHaveLength(5);
    expect(p0.eggDeck.every((c) => c.cardId === 'BT1-020' || c.cardId === 'BT1-021')).toBe(true);
    expect(p0.deck.some((c) => c.cardId.startsWith('BT1-02'))).toBe(false);
    expect(total(state, 0)).toBe(55);
    expect(total(state, 1)).toBe(55);
  });

  it('is identical for the same seed and differs for another seed', () => {
    expect(newGame(7)).toEqual(newGame(7));
    expect(newGame(7).players[0].hand).not.toEqual(newGame(8).players[0].hand);
  });
});

describe('commands', () => {
  it('digivolves a hand card onto a battle stack', () => {
    let s = newGame();
    const p = s.players[0];
    const first = p.hand[0].uid;
    s = applyCommand(s, { type: 'playFromHand', player: 0, uid: first, to: 'battle' });
    const stackId = s.players[0].battle[0].stackId;
    const second = s.players[0].hand[0].uid;
    const handBefore = s.players[0].hand.length;
    s = applyCommand(s, { type: 'digivolve', player: 0, handUid: second, onto: stackId });
    const stack = s.players[0].battle[0];
    expect(stack.cards).toHaveLength(2);
    expect(stack.cards[1].uid).toBe(second);
    expect(s.players[0].hand).toHaveLength(handBefore - 1);
    expect(total(s, 0)).toBe(55);
  });

  it('rejects invalid commands without changing the input state', () => {
    const s = newGame();
    const snapshot = JSON.stringify(s);
    expect(() => applyCommand(s, { type: 'hatch', player: 0 })).not.toThrow();
    expect(() => applyCommand(s, { type: 'suspend', player: 0, stackId: 'nope' })).toThrow();
    expect(() => applyCommand(s, { type: 'moveBreedingToBattle', player: 0 })).toThrow();
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('passTurn flips the active player, defaults memory to 3 and clamps overrides', () => {
    let s = newGame();
    s = applyCommand(s, { type: 'passTurn', player: 0 });
    expect(s.activePlayer).toBe(1);
    expect(s.memory).toBe(3);
    expect(s.turn).toBe(2);
    expect(s.phase).toBe('unsuspend');
    s = applyCommand(s, { type: 'changeMemoryBy', player: 1, delta: 100 });
    expect(s.memory).toBe(10);
    s = applyCommand(s, { type: 'setMemory', player: 1, value: -50 });
    expect(s.memory).toBe(-10);
  });

  it('keeps the security card on top of the pile when revealing', () => {
    let s = newGame();
    const top = s.players[0].security[s.players[0].security.length - 1].uid;
    s = applyCommand(s, { type: 'revealSecurity', player: 0 });
    expect(s.players[0].reveal.map((c) => c.uid)).toEqual([top]);
    expect(s.players[0].security).toHaveLength(4);
  });
});

describe('history', () => {
  const sequence: Command[] = [
    { type: 'draw', player: 0 },
    { type: 'hatch', player: 0 },
    { type: 'nextPhase', player: 0 },
    { type: 'passTurn', player: 0 },
  ];

  it('undoes one command at a time back to the start', () => {
    let h = createHistory(newGame());
    for (const cmd of sequence) h = dispatch(h, cmd);
    expect(h.present.turn).toBe(2);
    h = undo(h);
    expect(h.present.turn).toBe(1);
    expect(h.present.phase).toBe('draw');
    h = undo(h);
    h = undo(h);
    h = undo(h);
    expect(h.present).toEqual(h.initial);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });

  it('caps the undo stack at 100 states', () => {
    let h = createHistory(newGame());
    for (let i = 0; i < 120; i++) {
      h = dispatch(h, { type: 'changeMemoryBy', player: 0, delta: i % 2 ? 1 : -1 });
    }
    expect(h.past).toHaveLength(100);
    expect(h.commands).toHaveLength(120);
  });

  it('replays the command list to the same state', () => {
    let h = createHistory(newGame());
    for (const cmd of sequence) h = dispatch(h, cmd);
    expect(replay(h.initial, h.commands)).toEqual(h.present);
  });
});

describe('redactFor', () => {
  it('hides opponent hand, decks, face-down security and the RNG but keeps the viewer intact', () => {
    const state = newGame();
    const view = redactFor(state, 0);
    expect(view.players[1].hand.every((c) => c.cardId === HIDDEN_CARD_ID)).toBe(true);
    expect(view.players[1].deck.every((c) => c.cardId === HIDDEN_CARD_ID)).toBe(true);
    expect(view.players[1].eggDeck.every((c) => c.cardId === HIDDEN_CARD_ID)).toBe(true);
    expect(view.players[1].security.every((c) => c.cardId === HIDDEN_CARD_ID)).toBe(true);
    expect(view.players[1].hand).toHaveLength(5);
    expect(view.players[0]).toEqual(state.players[0]);
    expect(view.rngState).toBe(0);
    expect(view.seed).toBe(0);
  });
});
