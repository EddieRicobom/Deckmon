import { applyCommand } from '../reducer';
import { createGame, clearTemporary, stackDpMod } from '../game';
import { GameState, Stack, CardRef } from '../types';
import { registerCardRecords, setCardInfoSource } from '../rules/card-data';
import { hasKeyword } from '../rules/helpers';
import { parseCardText } from './parser';

// Phase 3B templates: memory set, until-turn durations, "can't attack or block". Synthetic cards, one file.

const block = (text: string) => parseCardText('T', { effect: text, digivolveEffect: '-', securityEffect: '-' });

describe('phase 3B parser', () => {
  it('reads "If you have N or less memory, set it to N" as a conditional memory set', () => {
    const p = block('[Start of Your Turn] If you have 2 or less memory, set it to 3.');
    expect(p.complete).toBe(true);
    expect(p.blocks[0].timings).toEqual(['startOfYourTurn']);
    expect(p.blocks[0].actions).toEqual([{ type: 'memorySet', n: 3, when: { kind: 'memoryAtMost', n: 2 } }]);
  });

  it('does not read a bare "set it to N" without the memory condition', () => {
    expect(block('[Main] Set it to 3.').complete).toBe(false);
  });

  it('reads "Until the end of your opponent\'s next turn" as a prefix on can\'t attack or block', () => {
    const p = block("[Main] Until the end of your opponent's next turn, 1 of your opponent's Digimon can't attack or block.");
    expect(p.complete).toBe(true);
    const acts = p.blocks[0].actions!;
    expect(acts.map((a) => a.type)).toEqual(['cant', 'cant']);
    expect(acts.map((a) => (a.type === 'cant' ? a.what : ''))).toEqual(['attack', 'block']);
    expect(acts.every((a) => a.type === 'cant' && a.duration === 'opponentNextTurn')).toBe(true);
  });

  it('reads a suffix "until the end of your next turn" on a DP buff and a keyword', () => {
    const dp = block('[Main] 1 of your Digimon gets +2000 DP until the end of your next turn.');
    expect(dp.complete).toBe(true);
    expect(dp.blocks[0].actions![0]).toMatchObject({ type: 'dp', delta: 2000, duration: 'yourNextTurn' });
    const kw = block('[Main] 1 of your Digimon gains ＜Blocker＞ until the end of your opponent\'s next turn.');
    expect(kw.complete).toBe(true);
    expect(kw.blocks[0].actions![0]).toMatchObject({ type: 'keyword', keyword: 'Blocker', duration: 'opponentNextTurn' });
  });

  it('does not read can\'t attack without a stated duration', () => {
    expect(block("[Main] 1 of your opponent's Digimon can't attack or block.").complete).toBe(false);
  });

  it('does not attach a duration to an action that has none', () => {
    expect(block("[Main] Until the end of your opponent's next turn, gain 2 memory.").complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Resolver. Synthetic records, registered for this file only.
// ---------------------------------------------------------------------------------------------

function rec(id: string, effect: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    cardType: 'Option',
    cardLv: '-',
    color: 'Red',
    dp: '0',
    playCost: '0',
    name: { english: id },
    effect,
    digivolveEffect: '-',
    securityEffect: '-',
    digivolveCondition: [],
    optionCardColourRequirement: '-',
    ...extra,
  };
}

beforeAll(() => {
  registerCardRecords([
    rec('P3B-PLAIN', '-', { cardType: 'Digimon', cardLv: 'Lv.3', dp: '3000' }),
    rec('P3B-MEM', '[Main] If you have 2 or less memory, set it to 3.'),
    rec('P3B-DP', "[Main] 1 of your opponent's Digimon gets -2000 DP until the end of your opponent's next turn."),
    rec('P3B-CANT', "[Main] Until the end of your opponent's next turn, 1 of your opponent's Digimon can't attack or block."),
    rec('P3B-OWNBUFF', '[Main] 1 of your Digimon gets +1000 DP until the end of your next turn.'),
    rec('P3B-MAINGAIN', '[Start of Your Main Phase] If your opponent has a Digimon, gain 1 memory.', { cardType: 'Digimon', cardLv: 'Lv.3', dp: '3000' }),
  ]);
});

afterAll(() => setCardInfoSource(null));

const card = (uid: string, cardId: string): CardRef => ({ uid, cardId });
const stack = (stackId: string, cards: CardRef[]): Stack => ({ stackId, cards, suspended: false, dpMod: 0 });

/** Assisted main phase on turn 2, player 0 active, with one opposing Digimon on the board. */
function board(memory: number): GameState {
  const s = createGame(7, [], [], ['A', 'B'], 'assisted');
  s.phase = 'main';
  s.activePlayer = 0;
  s.turn = 2;
  s.memory = memory;
  s.players[0].deck = [card('d0', 'P3B-PLAIN'), card('d1', 'P3B-PLAIN'), card('d2', 'P3B-PLAIN')];
  s.players[1].security = [0, 1, 2].map((i) => ({ uid: `sec${i}`, cardId: 'P3B-PLAIN', faceUp: false }));
  s.players[1].battle = [stack('o1', [card('x1', 'P3B-PLAIN')])];
  return s;
}

const play = (s: GameState, uid: string) => applyCommand(s, { type: 'playFromHand', player: 0, uid, to: 'option' });

describe('phase 3B resolver', () => {
  it('[Start of Your Main Phase] fires when breeding ends, and not again in the main phase', () => {
    let s = board(5);
    s.phase = 'breeding';
    s.players[0].battle = [stack('m1', [card('y1', 'P3B-MAINGAIN')])];
    s = applyCommand(s, { type: 'nextPhase', player: 0 });
    expect(s.phase).toBe('main');
    expect(s.memory).toBe(6);
    expect(s.log.filter((l) => l.text.startsWith('P3B-MAINGAIN [Start of Your Main Phase]:'))).toHaveLength(1);
  });

  it('"if you have N or less memory, set it to N" sets the controller side when the condition holds', () => {
    let s = board(1);
    s.players[0].hand = [card('h1', 'P3B-MEM')];
    s = play(s, 'h1');
    expect(s.memory).toBe(3);
  });

  it('the memory set is skipped when the controller has more memory than N', () => {
    let s = board(5);
    s.players[0].hand = [card('h1', 'P3B-MEM')];
    s = play(s, 'h1');
    expect(s.memory).toBe(5);
  });

  it('a DP change until the end of the opponent\'s next turn lasts through their turn and ends with it', () => {
    let s = board(5);
    s.players[0].hand = [card('h1', 'P3B-DP')];
    s = play(s, 'h1');
    const o1 = s.players[1].battle[0];
    expect(stackDpMod(o1)).toBe(-2000);
    // End of turn 2 (the controller's turn): the opponent's next turn is turn 3, so it stays.
    clearTemporary({ ...s, turn: 2 });
    expect(stackDpMod(o1)).toBe(-2000);
    // End of turn 3 (the opponent's turn): gone. clearTemporary edits the shared stacks.
    clearTemporary({ ...s, turn: 3 });
    expect(stackDpMod(o1)).toBe(0);
    expect(o1.timedMods).toBeUndefined();
  });

  it('"can\'t attack or block" until the opponent\'s next turn sets both markers and they clear afterwards', () => {
    let s = board(5);
    s.players[0].hand = [card('h1', 'P3B-CANT')];
    s = play(s, 'h1');
    const o1 = s.players[1].battle[0];
    expect(hasKeyword(o1, "Can't attack")).toBe(true);
    expect(hasKeyword(o1, "Can't block")).toBe(true);
    clearTemporary({ ...s, turn: 3 });
    expect(hasKeyword(o1, "Can't attack")).toBe(false);
  });

  it('"until the end of your next turn" lasts two turns when cast on your own turn', () => {
    let s = board(5);
    s.players[0].battle = [stack('m1', [card('y1', 'P3B-PLAIN')])];
    s.players[0].hand = [card('h1', 'P3B-OWNBUFF')];
    s = play(s, 'h1');
    const mine = s.players[0].battle[0];
    expect(stackDpMod(mine)).toBe(1000);
    // Your next turn is turn 4 (turn 3 is the opponent's).
    const t3 = { ...s, turn: 3, players: s.players };
    clearTemporary(t3);
    expect(stackDpMod(mine)).toBe(1000);
    const t4 = { ...s, turn: 4, players: s.players };
    clearTemporary(t4);
    expect(stackDpMod(mine)).toBe(0);
  });
});
