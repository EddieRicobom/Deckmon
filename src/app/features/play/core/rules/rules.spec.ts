import * as fs from 'fs';
import * as path from 'path';
import { applyCommand } from '../reducer';
import { Command } from '../commands';
import { createGame } from '../game';
import { GameState, PlayerState, Stack, CardRef } from '../types';
import { cardInfo, registerCardRecords, setCardInfoSource } from './card-data';
import { keywordsIn, linesWithTiming, securityAttackMod } from './text';
import { redactFor } from '../view';
import { buildWire, publicHash } from '../wire';

// ---------------------------------------------------------------------------------------------
// Synthetic card data. Every rule under test reads these records through the registry.
// ---------------------------------------------------------------------------------------------

type Rec = {
  type?: string;
  lv?: string;
  color?: string;
  dp?: number;
  cost?: number;
  effect?: string;
  inh?: string;
  sec?: string;
  dig?: Array<{ color: string; level: string; cost: string }>;
  optColor?: string;
};

function rec(id: string, o: Rec = {}): Record<string, unknown> {
  return {
    id,
    cardType: o.type ?? 'Digimon',
    cardLv: o.lv ?? 'Lv.4',
    color: o.color ?? 'Red',
    dp: String(o.dp ?? 4000),
    playCost: String(o.cost ?? 0),
    name: { english: id },
    effect: o.effect ?? '-',
    digivolveEffect: o.inh ?? '-',
    securityEffect: o.sec ?? '-',
    digivolveCondition: o.dig ?? [],
    optionCardColourRequirement: o.optColor ?? '-',
  };
}

beforeAll(() => {
  registerCardRecords([
    rec('L3', { lv: 'Lv.3', dp: 3000 }),
    rec('L4', { dp: 4000, dig: [{ color: 'Red', level: '3', cost: '1' }] }),
    rec('L4-5K', { dp: 5000 }),
    rec('L4-3K', { dp: 3000 }),
    rec('L4-2K', { dp: 2000 }),
    rec('L4-RUSH', { dp: 4000, effect: '＜Rush＞' }),
    rec('BLOCK', { dp: 3000, effect: '＜Blocker＞' }),
    rec('PIERCE', { dp: 5000, effect: '＜Piercing＞' }),
    rec('JAM', { dp: 2000, effect: '＜Jamming＞' }),
    rec('RETAL', { dp: 3000, effect: '＜Retaliation＞' }),
    rec('REBOOT', { dp: 4000, effect: '＜Reboot＞' }),
    rec('SEC2', { dp: 4000, effect: '＜Security A. +1＞' }),
    rec('ONPLAY', { dp: 4000, effect: '[On Play] Draw 1.' }),
    rec('COST2', { dp: 4000, cost: 2 }),
    rec('COST1', { dp: 4000, cost: 1 }),
    rec('TAMER', { type: 'Tamer', lv: '-', dp: 0, cost: 1, sec: '[Security] Play this card without paying the cost.' }),
    rec('OPT-RED', { type: 'Option', lv: '-', dp: 0, cost: 1, color: 'Red', optColor: 'Red', effect: '[Main] Gain 2 memory.' }),
    rec('OPT-BLUE', { type: 'Option', lv: '-', dp: 0, cost: 0, color: 'Blue', optColor: 'Blue' }),
    rec('EGG', { type: 'Digi-Egg', lv: 'Lv.2', dp: 0 }),
  ]);
});

afterAll(() => setCardInfoSource(null));

// ---------------------------------------------------------------------------------------------
// Board builders
// ---------------------------------------------------------------------------------------------

const c = (owner: number, name: string, cardId = 'L3'): CardRef => ({ uid: `p${owner}-${name}`, cardId });
const st = (stackId: string, cards: CardRef[], extra: Partial<Stack> = {}): Stack => ({
  stackId,
  cards,
  suspended: false,
  dpMod: 0,
  ...extra,
});

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

/** An assisted game in turn 3, main phase, Alice to act, memory 3 for her. Boards are empty and deterministic. */
function game(): GameState {
  const s = createGame(7, [{ id: 'L3', count: 1 }], [{ id: 'L3', count: 1 }], ['Alice', 'Bob'], 'assisted');
  s.turn = 3;
  s.activePlayer = 0;
  s.phase = 'main';
  s.memory = 3;
  s.players = [board(0), board(1)];
  return s;
}

const run = (s: GameState, ...cmds: Command[]): GameState => cmds.reduce((st2, cmd) => applyCommand(st2, cmd), s);
const err = (s: GameState, cmd: Command): string => {
  try {
    applyCommand(s, cmd);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};
const pass = (player: 0 | 1 = 0): Command => ({ type: 'passTurn', player });
const playHand = (player: 0 | 1, uid: string, to: 'battle' | 'tamer' | 'option' = 'battle'): Command => ({
  type: 'playFromHand',
  player,
  uid,
  to,
});
const attack = (player: 0 | 1, attackerStackId: string, target: string | 'player'): Command => ({
  type: 'attack',
  player,
  attackerStackId,
  target: target === 'player' ? { kind: 'player' } : { kind: 'stack', stackId: target },
});

// ---------------------------------------------------------------------------------------------
// Turn structure and memory
// ---------------------------------------------------------------------------------------------

describe('assisted turn flow', () => {
  it('starts turn 1 in breeding with no draw for the first player', () => {
    const s = createGame(3, [{ id: 'L3', count: 40 }], [{ id: 'L3', count: 40 }], ['A', 'B'], 'assisted');
    expect(s.phase).toBe('breeding');
    const after = run(s, pass(0));
    expect(after.activePlayer).toBe(1);
    expect(after.players[0].hand.length).toBe(s.players[0].hand.length);
    expect(after.players[1].hand.length).toBe(s.players[1].hand.length + 1);
  });

  it('passing draws for the next player, unsuspends them, and stops at breeding', () => {
    const s = game();
    s.players[1].battle = [st('b1', [c(1, 'x')], { suspended: true })];
    const after = run(s, pass(0));
    expect(after.turn).toBe(4);
    expect(after.activePlayer).toBe(1);
    expect(after.phase).toBe('breeding');
    expect(after.memory).toBe(3);
    expect(after.players[1].battle[0].suspended).toBe(false);
    expect(after.players[1].hand.length).toBe(1);
  });

  it('unsuspends Reboot stacks of the player whose turn just ended, but not their other stacks', () => {
    const s = game();
    s.players[0].battle = [
      st('r1', [c(0, 'r', 'REBOOT')], { suspended: true }),
      st('n1', [c(0, 'n')], { suspended: true }),
    ];
    const after = run(s, pass(0));
    expect(after.players[0].battle.find((x) => x.stackId === 'r1')?.suspended).toBe(false);
    expect(after.players[0].battle.find((x) => x.stackId === 'n1')?.suspended).toBe(true);
  });

  it('deck-out loses the game for the player who has to draw', () => {
    const s = game();
    s.players[1].deck = [];
    const after = run(s, pass(0));
    expect(after.winner).toBe(0);
    expect(after.winReason).toMatch(/empty deck/);
    expect(err(after, playHand(0, 'nope'))).toMatch(/game is over/);
  });

  it('breeding: hatch or move ends the phase, and nextPhase skips to main', () => {
    const s = game();
    s.phase = 'breeding';
    s.players[0].eggDeck = [c(0, 'e', 'EGG')];
    const hatched = run(s, { type: 'hatch', player: 0 });
    expect(hatched.phase).toBe('main');
    expect(hatched.players[0].breeding?.cards[0].cardId).toBe('EGG');

    const skipped = run(s, { type: 'nextPhase', player: 0 });
    expect(skipped.phase).toBe('main');
    expect(err(skipped, { type: 'nextPhase', player: 0 })).toMatch(/Phases advance automatically/);
  });

  it('only a Lv.3+ Digimon can move from breeding to battle', () => {
    const s = game();
    s.phase = 'breeding';
    s.players[0].breeding = st('br', [c(0, 'eg', 'EGG')]);
    expect(err(s, { type: 'moveBreedingToBattle', player: 0 })).toMatch(/Lv\.3/);
    s.players[0].breeding = st('br', [c(0, 'l3', 'L3')]);
    const moved = run(s, { type: 'moveBreedingToBattle', player: 0 });
    expect(moved.players[0].battle.length).toBe(1);
    expect(moved.phase).toBe('main');
  });

  it('automatically ends the turn when memory crosses to the opponent side, keeping the gauge', () => {
    const s = game();
    s.memory = 3;
    s.players[0].hand = [c(0, 'h1', 'COST2'), c(0, 'h2', 'COST2')];
    const once = run(s, playHand(0, 'p0-h1'));
    expect(once.memory).toBe(1);
    expect(once.activePlayer).toBe(0);
    const twice = run(once, playHand(0, 'p0-h2'));
    expect(twice.activePlayer).toBe(1);
    expect(twice.turn).toBe(4);
    expect(twice.memory).toBe(1);
    expect(twice.phase).toBe('breeding');
  });

  it('pass sets the next player memory to 3', () => {
    const s = game();
    s.memory = 6;
    const after = run(s, pass(0));
    expect(after.memory).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Play, option, digivolve
// ---------------------------------------------------------------------------------------------

describe('play and digivolve', () => {
  it('refuses to play a card the player cannot pay for', () => {
    const s = game();
    s.memory = 0;
    s.players[0].hand = [c(0, 'h', 'COST1')];
    expect(err(s, playHand(0, 'p0-h'))).toMatch(/Not enough memory/);
  });

  it('digi-eggs cannot be played from hand', () => {
    const s = game();
    s.players[0].hand = [c(0, 'e', 'EGG')];
    expect(err(s, playHand(0, 'p0-e'))).toMatch(/Digi-Eggs cannot be played/);
  });

  it('option needs each of its colours on your side, then goes to trash', () => {
    const s = game();
    s.players[0].hand = [c(0, 'o', 'OPT-RED')];
    expect(err(s, playHand(0, 'p0-o', 'option'))).toMatch(/Red/);
    s.players[0].battle = [st('b1', [c(0, 'red', 'L3')])];
    const after = run(s, playHand(0, 'p0-o', 'option'));
    expect(after.players[0].trash.map((x) => x.uid)).toContain('p0-o');
    expect(after.players[0].option.length).toBe(0);
    expect(after.memory).toBe(2);
  });

  it('a blue option with no blue side is refused', () => {
    const s = game();
    s.players[0].hand = [c(0, 'o', 'OPT-BLUE')];
    expect(err(s, playHand(0, 'p0-o', 'option'))).toMatch(/Blue/);
  });

  it('played Digimon get an On Play reminder with the card text', () => {
    const s = game();
    s.players[0].hand = [c(0, 'd', 'ONPLAY')];
    const after = run(s, playHand(0, 'p0-d'));
    const r = after.reminders ?? [];
    expect(r.length).toBe(1);
    expect(r[0].timing).toBe('On Play');
    expect(r[0].text).toContain('[On Play]');
    expect(r[0].cardName).toBe('ONPLAY');
  });

  it('digivolves onto a matching battle Digimon, pays the cost, draws one, and keeps the stack state', () => {
    const s = game();
    s.memory = 3;
    s.players[0].battle = [st('b1', [c(0, 'base', 'L3')], { suspended: true, enteredTurn: 1 })];
    s.players[0].hand = [c(0, 'd4', 'L4')];
    s.players[0].deck = [c(0, 'top', 'L3')];
    const handBefore = s.players[0].hand.length;
    const after = run(s, { type: 'digivolve', player: 0, handUid: 'p0-d4', onto: 'b1' });
    const stack = after.players[0].battle[0];
    expect(stack.cards.map((x) => x.cardId)).toEqual(['L3', 'L4']);
    expect(stack.suspended).toBe(true);
    expect(stack.enteredTurn).toBe(1);
    expect(after.memory).toBe(2);
    expect(after.players[0].hand.length).toBe(handBefore);
  });

  it('refuses a digivolution whose level or colour does not match', () => {
    const s = game();
    s.players[0].battle = [st('b1', [c(0, 'base', 'L4')])];
    s.players[0].hand = [c(0, 'd4', 'L4')];
    expect(err(s, { type: 'digivolve', player: 0, handUid: 'p0-d4', onto: 'b1' })).toMatch(/cannot digivolve/);
  });
});

// ---------------------------------------------------------------------------------------------
// Attacks and combat
// ---------------------------------------------------------------------------------------------

describe('attacks', () => {
  it('a Digimon that entered this turn cannot attack, but Rush can', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')], { enteredTurn: 3 })];
    s.players[1].battle = [st('t1', [c(1, 't', 'L4')], { suspended: true })];
    expect(err(s, attack(0, 'a1', 't1'))).toMatch(/entered play this turn/);
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4-RUSH')], { enteredTurn: 3 })];
    expect(err(s, attack(0, 'a1', 't1'))).toBe('');
  });

  it('attacking a Digimon needs a suspended target, and it is deleted when it loses', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    s.players[1].battle = [st('t1', [c(1, 't', 'L4-3K')])];
    expect(err(s, attack(0, 'a1', 't1'))).toMatch(/suspended/);
    s.players[1].battle[0].suspended = true;
    const after = run(s, attack(0, 'a1', 't1'));
    expect(after.players[1].battle.length).toBe(0);
    expect(after.players[1].trash.length).toBe(1);
    expect(after.players[0].battle[0].suspended).toBe(true);
  });

  it('a lower-DP attacker is deleted with its digivolution sources', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'src', 'L3'), c(0, 'a', 'L4-2K')])];
    s.players[1].battle = [st('t1', [c(1, 't', 'L4-5K')], { suspended: true })];
    const after = run(s, attack(0, 'a1', 't1'));
    expect(after.players[0].battle.length).toBe(0);
    expect(after.players[0].trash.length).toBe(2);
  });

  it('a tie deletes both Digimon', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    s.players[1].battle = [st('t1', [c(1, 't', 'L4')], { suspended: true })];
    const after = run(s, attack(0, 'a1', 't1'));
    expect(after.players[0].battle.length).toBe(0);
    expect(after.players[1].battle.length).toBe(0);
  });

  it('Retaliation deletes the other Digimon when it is deleted in battle', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'RETAL')])];
    s.players[1].battle = [st('t1', [c(1, 't', 'L4-5K')], { suspended: true })];
    const after = run(s, attack(0, 'a1', 't1'));
    expect(after.players[0].battle.length).toBe(0);
    expect(after.players[1].battle.length).toBe(0);
  });

  it('a direct attack opens security checks owned by the defender', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    const after = run(s, attack(0, 'a1', 'player'));
    expect(after.pending).toMatchObject({ kind: 'security', owner: 1, remaining: 1 });
    expect(after.players[1].security.length).toBe(5);
    const checked = run(after, { type: 'securityCheck', player: 1 });
    expect(checked.pending).toBeNull();
    expect(checked.players[1].security.length).toBe(4);
    expect(checked.players[1].trash.length).toBe(1);
  });

  it('a Tamer security card goes to trash and shows its [Security] reminder', () => {
    const s = game();
    s.players[1].security = [{ uid: 'p1-tam', cardId: 'TAMER', faceUp: false }];
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    const after = run(s, attack(0, 'a1', 'player'), { type: 'securityCheck', player: 1 });
    expect(after.players[1].trash.map((x) => x.uid)).toContain('p1-tam');
    expect((after.reminders ?? []).map((r) => r.timing)).toContain('Security');
  });

  it('Security Attack +1 gives two checks', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'SEC2')])];
    const after = run(s, attack(0, 'a1', 'player'));
    expect(after.pending).toMatchObject({ remaining: 2 });
    const once = run(after, { type: 'securityCheck', player: 1 });
    expect(once.pending).toMatchObject({ remaining: 1 });
    const twice = run(once, { type: 'securityCheck', player: 1 });
    expect(twice.pending).toBeNull();
    expect(twice.players[1].security.length).toBe(3);
  });

  it('a direct attack on a player with no security wins', () => {
    const s = game();
    s.players[1].security = [];
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    const after = run(s, attack(0, 'a1', 'player'));
    expect(after.winner).toBe(0);
    expect(after.pending).toBeNull();
  });

  it('a Digimon security card battles the attacker, and Jamming keeps the attacker alive', () => {
    const s = game();
    s.players[1].security = [{ uid: 'p1-x', cardId: 'L3', faceUp: false }];
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4-2K')])];
    const lost = run(s, attack(0, 'a1', 'player'), { type: 'securityCheck', player: 1 });
    expect(lost.players[0].battle.length).toBe(0);

    s.players[1].security = [{ uid: 'p1-x', cardId: 'L3', faceUp: false }];
    s.players[0].battle = [st('a1', [c(0, 'a', 'JAM')])];
    const jammed = run(s, attack(0, 'a1', 'player'), { type: 'securityCheck', player: 1 });
    expect(jammed.players[0].battle.length).toBe(1);
  });
});

describe('blockers, piercing', () => {
  it('a Blocker becomes the target, and the defender may decline', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    s.players[1].battle = [st('k1', [c(1, 'k', 'BLOCK')])];
    const pending = run(s, attack(0, 'a1', 'player'));
    expect(pending.pending).toMatchObject({ kind: 'block', owner: 1, blockers: ['k1'] });
    expect(err(pending, { type: 'securityCheck', player: 1 })).toMatch(/No security check/);

    const blocked = run(pending, { type: 'resolveBlock', player: 1, blockerStackId: 'k1' });
    expect(blocked.players[1].battle.length).toBe(0);
    expect(blocked.pending).toBeNull();

    const declined = run(pending, { type: 'resolveBlock', player: 1, blockerStackId: null });
    expect(declined.pending).toMatchObject({ kind: 'security', owner: 1 });
  });

  it('only the defender can answer a pending block', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    s.players[1].battle = [st('k1', [c(1, 'k', 'BLOCK')])];
    const pending = run(s, attack(0, 'a1', 'player'));
    expect(err(pending, { type: 'resolveBlock', player: 0, blockerStackId: null })).toMatch(/Waiting for Bob/);
  });

  it('Piercing: deleting the blocker continues into security checks', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'PIERCE')])];
    s.players[1].battle = [st('k1', [c(1, 'k', 'BLOCK')])];
    const after = run(s, attack(0, 'a1', 'player'), { type: 'resolveBlock', player: 1, blockerStackId: 'k1' });
    expect(after.players[1].battle.length).toBe(0);
    expect(after.pending).toMatchObject({ kind: 'security', owner: 1 });
  });

  it('without Piercing the blocked attack does not reach security', () => {
    const s = game();
    s.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    s.players[1].battle = [st('k1', [c(1, 'k', 'BLOCK')])];
    const after = run(s, attack(0, 'a1', 'player'), { type: 'resolveBlock', player: 1, blockerStackId: 'k1' });
    expect(after.pending).toBeNull();
    expect(after.players[1].security.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Force, decisions across peers, reminders and keyword parsing
// ---------------------------------------------------------------------------------------------

describe('force and overrides', () => {
  it('manual changes are refused without Force and logged with it', () => {
    const s = game();
    expect(err(s, { type: 'setMemory', player: 0, value: 5 })).toMatch(/Force/);
    const forced = run(s, { type: 'setMemory', player: 0, value: 5, force: true });
    expect(forced.memory).toBe(5);
    expect(forced.log.some((l) => /Override: setMemory/.test(l.text))).toBe(true);
  });
});

describe('two peers and pending decisions', () => {
  it('the defender resolves the security check, and both peers end with the same public state', () => {
    const full = game();
    full.players[0].battle = [st('a1', [c(0, 'a', 'L4')])];
    full.players[1].security = [{ uid: 'p1-x', cardId: 'L3', faceUp: false }];

    // Alice sees her own board in full and Bob's redacted. Bob sees his own board in full.
    let alice = redactFor(full, 0);
    let bob = redactFor(full, 1);

    const attackCmd = attack(0, 'a1', 'player');
    const attackWire = buildWire(full, applyCommand(full, attackCmd), attackCmd);
    alice = applyCommand(alice, attackCmd);
    bob = applyCommand(bob, attackWire.cmd);
    expect(bob.pending).toMatchObject({ kind: 'security', owner: 1 });
    expect(alice.pending).toMatchObject({ kind: 'security', owner: 1 });
    expect(() => applyCommand(alice, { type: 'securityCheck', player: 0 })).toThrow(/Waiting/);

    // Bob's client resolves the check and sends the reveal; Alice applies it with the reveal filled in.
    const check: Command = { type: 'securityCheck', player: 1 };
    const bobBefore = bob;
    bob = applyCommand(bob, check);
    const wire = buildWire(bobBefore, bob, check);
    expect(wire.reveals && Object.keys(wire.reveals).length).toBe(1);
    alice = applyCommand(alice, { ...wire.cmd, reveals: wire.reveals });

    expect(publicHash(alice)).toBe(publicHash(bob));
    expect(bob.pending).toBeNull();
    expect(alice.pending).toBeNull();
  });
});

describe('keyword and timing parsing', () => {
  it('reads keywords only at the start of a line', () => {
    expect(keywordsIn('＜Raid＞ \n＜Piercing＞ \n[On Play] nothing')).toEqual(['Raid', 'Piercing']);
    expect(keywordsIn('This Digimon gains ＜Security A. +1＞ for each colour.')).toEqual([]);
    expect(securityAttackMod(['Security A. +1', 'Security A. -2', 'Blocker'])).toBe(-1);
  });

  it('extracts timing lines for a reminder', () => {
    const text = '[On Play] Draw 1.\n[When Attacking] Delete a Digimon.';
    expect(linesWithTiming(text, 'When Attacking')).toEqual(['[When Attacking] Delete a Digimon.']);
  });

  it('parses the real card data for WarGreymon (multi-condition digivolve, inherited keywords)', () => {
    const file = path.join(__dirname, '../../../../../assets/cardlists/DigimonCards.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    registerCardRecords(records);
    const info = cardInfo('AD1-004');
    expect(info?.name).toBe('WarGreymon');
    expect(info?.level).toBe(6);
    expect(info?.colors).toEqual(['Red', 'Black']);
    expect(info?.digivolve.length).toBe(2);
    expect(keywordsIn(info?.effect ?? '')).toEqual(expect.arrayContaining(['Raid', 'Piercing']));
  });
});
