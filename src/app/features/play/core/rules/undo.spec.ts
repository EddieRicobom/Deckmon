import { createGame } from '../game';
import { Command } from '../commands';
import { GameState, PlayerState, CardRef } from '../types';
import { registerCardRecords, setCardInfoSource } from './card-data';
import { canRedo, createHistory, dispatch, GameHistory, redo, rewindTo, undo, undoableSteps } from '../history';

const rec = (id: string, cost = 0): Record<string, unknown> => ({
  id,
  cardType: 'Digimon',
  cardLv: 'Lv.4',
  color: 'Red',
  dp: '4000',
  playCost: String(cost),
  name: { english: id },
  effect: '-',
  digivolveEffect: '-',
  securityEffect: '-',
  digivolveCondition: [],
  optionCardColourRequirement: '-',
});

beforeAll(() => registerCardRecords([rec('CHEAP', 1), rec('COST2', 2), rec('L3')]));
afterAll(() => setCardInfoSource(null));

const c = (owner: number, name: string, cardId = 'CHEAP'): CardRef => ({ uid: `p${owner}-${name}`, cardId });

function board(id: number): PlayerState {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  return {
    id: id as 0 | 1,
    name: id === 0 ? 'Alice' : 'Bob',
    deck: range(10).map((i) => ({ uid: `p${id}-d${i}`, cardId: 'L3' })),
    eggDeck: [],
    hand: [],
    security: range(5).map((i) => ({ uid: `p${id}-s${i}`, cardId: 'L3', faceUp: false })),
    breeding: null,
    battle: [],
    tamer: [],
    option: [],
    trash: [],
    reveal: [],
    eggUids: [],
  };
}

function game(): GameState {
  const s = createGame(9, [{ id: 'L3', count: 1 }], [{ id: 'L3', count: 1 }], ['Alice', 'Bob'], 'assisted');
  s.turn = 3;
  s.activePlayer = 0;
  s.phase = 'main';
  s.memory = 3;
  s.players = [board(0), board(1)];
  s.players[0].hand = [c(0, 'h1'), c(0, 'h2'), c(0, 'h3')];
  return s;
}

const play = (uid: string): Command => ({ type: 'playFromHand', player: 0, uid, to: 'battle' });
const pass = (player: 0 | 1): Command => ({ type: 'passTurn', player });

describe('undo and redo across automatic phases', () => {
  it('undoing a pass goes back to before the auto unsuspend and draw, as one step', () => {
    const base = game();
    const h0 = createHistory(base);
    const h1 = dispatch(h0, pass(0), 0);
    expect(h1.commands.length).toBe(1);
    expect(h1.present.activePlayer).toBe(1);
    expect(h1.present.players[1].hand.length).toBe(1);

    const back = undo(h1);
    expect(back.present.turn).toBe(3);
    expect(back.present.activePlayer).toBe(0);
    expect(back.present.phase).toBe('main');
    expect(back.present.players[1].hand.length).toBe(0);
    expect(canRedo(back)).toBe(true);

    const forward = redo(back);
    expect(forward.present).toEqual(h1.present);
    expect(canRedo(forward)).toBe(false);
  });

  it('an action that ends the turn automatically is undone with it, in one step', () => {
    const base = game();
    base.players[0].hand = [c(0, 'h1', 'COST2'), c(0, 'h2', 'COST2')];
    const h1 = dispatch(createHistory(base), play('p0-h1'), 0);
    expect(h1.present.memory).toBe(1);
    const h2 = dispatch(h1, play('p0-h2'), 0);
    expect(h2.present.activePlayer).toBe(1);
    expect(h2.commands.length).toBe(2);
    const back = undo(h2);
    expect(back.present.activePlayer).toBe(0);
    expect(back.present.memory).toBe(1);
    expect(back.present.players[0].battle.length).toBe(1);
    expect(undo(back).present).toEqual(base);
  });

  it('undo can step back several times, and rewindTo keeps the rest for redo', () => {
    const base = game();
    let h: GameHistory = createHistory(base);
    h = dispatch(h, play('p0-h1'), 0);
    h = dispatch(h, play('p0-h2'), 0);
    h = dispatch(h, { type: 'changeMemoryBy', player: 0, delta: 1, force: true }, 0);
    expect(undoableSteps(h, 0)).toBe(3);
    const back = undo(h, 3);
    expect(back.present).toEqual(base);
    expect(redo(redo(back)).present.players[0].battle.length).toBe(2);

    const rewound = rewindTo(h, 1);
    expect(rewound.commands.length).toBe(1);
    expect(rewound.present.players[0].battle.length).toBe(1);
  });

  it('a new command clears the redo stack', () => {
    const h1 = dispatch(createHistory(game()), play('p0-h1'), 0);
    const back = undo(h1);
    expect(canRedo(back)).toBe(true);
    const h2 = dispatch(back, play('p0-h2'), 0);
    expect(canRedo(h2)).toBe(false);
  });
});

describe('undo rules between two peers', () => {
  it('allows only your own trailing steps, and stops at the opponent move', () => {
    let h: GameHistory = createHistory(game());
    h = dispatch(h, play('p0-h1'), 0);
    h = dispatch(h, play('p0-h2'), 0);
    expect(undoableSteps(h, 0)).toBe(2);
    h = dispatch(h, pass(0), 0);
    expect(undoableSteps(h, 0)).toBe(3);
    h = dispatch(h, pass(1), 1);
    expect(undoableSteps(h, 0)).toBe(0);
  });

  it('never undoes a step that revealed hidden information to you (a draw into your hand)', () => {
    let h: GameHistory = createHistory(game());
    h = dispatch(h, play('p0-h1'), 0);
    h = dispatch(h, { type: 'draw', player: 0, force: true }, 0);
    expect(h.learned[h.learned.length - 1]).toBe(true);
    expect(undoableSteps(h, 0)).toBe(0);
  });

  it('a step by you that revealed nothing new stays undoable after an earlier draw', () => {
    let h: GameHistory = createHistory(game());
    h = dispatch(h, { type: 'draw', player: 0, force: true }, 0);
    h = dispatch(h, play('p0-h1'), 0);
    expect(undoableSteps(h, 0)).toBe(1);
  });
});

describe('history cap', () => {
  it('keeps 100 undo snapshots but the full command list for replay', () => {
    let h: GameHistory = createHistory(game());
    for (let i = 0; i < 105; i++) {
      h = dispatch(h, { type: 'changeMemoryBy', player: 0, delta: 0, force: true }, null);
    }
    expect(h.past.length).toBe(100);
    expect(h.commands.length).toBe(105);
    expect(undoableSteps(h, null)).toBe(100);
    expect(undo(h, 100).commands.length).toBe(5);
  });
});

describe('log marks (rewind to a log entry)', () => {
  it('records the log length before each command, and follows undo and redo', () => {
    const base = game();
    let h: GameHistory = createHistory(base);
    h = dispatch(h, play('p0-h1'), 0);
    const afterFirst = h.present.log.length;
    h = dispatch(h, play('p0-h2'), 0);
    expect(h.marks).toEqual([base.log.length, afterFirst]);

    const back = undo(h, 1);
    expect(back.marks).toEqual([base.log.length]);
    const again = redo(back);
    expect(again.marks).toEqual([base.log.length, afterFirst]);
  });
});
