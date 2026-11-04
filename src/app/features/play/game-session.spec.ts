import { createGame } from './core/game';
import { GameState, PlayerState, Stack } from './core/types';
import { registerCardRecords, setCardInfoSource } from './core/rules/card-data';
import { loadSoloGame, clearSoloGame } from './core/saved-game';
import { GameSession } from './game-session.service';

const rec = (id: string, dp: number, effect = '-'): Record<string, unknown> => ({
  id,
  cardType: 'Digimon',
  cardLv: 'Lv.4',
  color: 'Red',
  dp: String(dp),
  playCost: '0',
  name: { english: id },
  effect,
  digivolveEffect: '-',
  securityEffect: '-',
  digivolveCondition: [],
  optionCardColourRequirement: '-',
});

beforeAll(() =>
  registerCardRecords([
    rec('ATK', 9000),
    rec('PIERCE', 9000, '＜Piercing＞'),
    rec('BLK', 1000, '＜Blocker＞'),
    rec('L3', 4000),
  ]),
);
afterAll(() => setCardInfoSource(null));
beforeEach(() => localStorage.clear());

function stack(stackId: string, cardId: string): Stack {
  return { stackId, cards: [{ uid: `${stackId}-card`, cardId }], suspended: false, dpMod: 0, enteredTurn: 1 };
}

function board(id: 0 | 1, battle: Stack[] = []): PlayerState {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  return {
    id,
    name: id === 0 ? 'Alice' : 'Bob',
    deck: range(10).map((i) => ({ uid: `p${id}-d${i}`, cardId: 'L3' })),
    eggDeck: [],
    hand: [],
    security: range(5).map((i) => ({ uid: `p${id}-s${i}`, cardId: 'L3', faceUp: false })),
    breeding: null,
    battle,
    tamer: [],
    option: [],
    trash: [],
    reveal: [],
    eggUids: [],
  };
}

/** Turn 3, main phase, Alice to act. Alice has a 9000 DP Digimon ready to attack. */
function game(attacker = 'ATK', bob: Stack[] = []): GameState {
  const s = createGame(9, [{ id: 'L3', count: 1 }], [{ id: 'L3', count: 1 }], ['Alice', 'Bob'], 'assisted');
  s.mode = 'assisted';
  s.turn = 3;
  s.activePlayer = 0;
  s.phase = 'main';
  s.memory = 3;
  s.players = [board(0, [stack('atk', attacker)]), board(1, bob)];
  return s;
}

const attackPlayer = { type: 'attack' as const, player: 0 as const, attackerStackId: 'atk', target: { kind: 'player' as const } };

describe('GameSession undo across an attack', () => {
  it('attack, security check and undo are one step; redo replays the whole attack', () => {
    const s = new GameSession();
    const base = game();
    s.resumeSolo(base);
    const before = s.state();

    expect(s.applyLocal(attackPlayer)).toBe(true);
    expect(s.state()?.pending).toBeFalsy();
    expect(s.state()?.players[1].security.length).toBe(4);
    expect(s.commandCount()).toBe(2);
    expect(s.undoCount()).toBe(1);

    expect(s.undo()).toBe(true);
    expect(s.state()).toEqual(before);
    expect(s.state()?.pending).toBeFalsy();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(true);

    expect(s.redo()).toBe(true);
    expect(s.state()?.players[1].security.length).toBe(4);
    expect(s.state()?.pending).toBeFalsy();
    expect(s.commandCount()).toBe(2);
    expect(s.canUndo()).toBe(true);
  });

  it('attack into a block prompt: undo takes back the attack and clears the prompt', () => {
    const s = new GameSession();
    s.resumeSolo(game('ATK', [stack('blk', 'BLK')]));
    const before = s.state();

    expect(s.applyLocal(attackPlayer)).toBe(true);
    expect(s.state()?.pending?.kind).toBe('block');
    expect(s.canUndo()).toBe(true);

    expect(s.undo()).toBe(true);
    expect(s.state()).toEqual(before);
    expect(s.state()?.pending).toBeFalsy();
    expect(s.state()?.players[0].battle[0].suspended).toBe(false);
    expect(s.canUndo()).toBe(false);
  });

  it('piercing: block, piercing security check and undo are one step', () => {
    const s = new GameSession();
    s.resumeSolo(game('PIERCE', [stack('blk', 'BLK')]));
    const before = s.state();

    expect(s.applyLocal({ ...attackPlayer, attackerStackId: 'atk' })).toBe(true);
    expect(s.state()?.pending?.kind).toBe('block');
    expect(s.applyLocal({ type: 'resolveBlock', player: 1, blockerStackId: 'blk' })).toBe(true);
    expect(s.state()?.pending).toBeFalsy();
    expect(s.state()?.players[1].security.length).toBe(4);
    expect(s.commandCount()).toBe(3);
    expect(s.undoCount()).toBe(1);

    expect(s.undo()).toBe(true);
    expect(s.state()).toEqual(before);
    expect(s.state()?.players[1].battle[0].stackId).toBe('blk');
    expect(s.state()?.players[1].security.length).toBe(5);
    expect(s.canRedo()).toBe(true);
  });

  it('a solo undo never leaves the game on a pending security check', () => {
    const s = new GameSession();
    s.resumeSolo(game());
    s.applyLocal(attackPlayer);
    s.undo();
    expect(s.state()?.pending).toBeFalsy();
    expect(s.applyLocal({ type: 'nextPhase', player: 0 })).toBe(false);
    expect(s.applyLocal(attackPlayer)).toBe(true);
    expect(s.state()?.players[1].security.length).toBe(4);
  });
});

describe('solo save', () => {
  it('saves every solo change and resumes from the saved state', () => {
    const s = new GameSession();
    s.resumeSolo(game());
    expect(loadSoloGame()?.state.turn).toBe(3);

    s.applyLocal(attackPlayer);
    expect(loadSoloGame()?.state.players[1].security.length).toBe(4);

    const resumed = new GameSession();
    resumed.resumeSolo(loadSoloGame()!.state);
    expect(resumed.state()?.players[1].security.length).toBe(4);
    expect(resumed.canUndo()).toBe(false);

    clearSoloGame();
    expect(loadSoloGame()).toBeNull();
  });
});
