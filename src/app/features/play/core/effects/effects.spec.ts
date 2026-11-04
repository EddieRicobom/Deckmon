import { applyCommand } from '../reducer';
import { Command } from '../commands';
import { createGame } from '../game';
import { GameState, Stack, CardRef } from '../types';
import { registerCardRecords, setCardInfoSource } from '../rules/card-data';
import { createHistory, dispatch, undo } from '../history';
import { buildWire, publicHash } from '../wire';
import { redactPlayer } from '../view';
import { parseBody, parseCardText, parseDescriptor, splitSentences, targetPhrase } from './parser';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

const block = (text: string) => parseCardText('T', { effect: text, digivolveEffect: '-', securityEffect: '-' });

describe('effect parser', () => {
  it('reads keyword draw on play', () => {
    const p = block('[On Play] ＜Draw 2＞');
    expect(p.complete).toBe(true);
    expect(p.blocks[0].timings).toEqual(['onPlay']);
    expect(p.blocks[0].actions).toEqual([{ type: 'draw', n: 2 }]);
  });

  it('reads delete with a DP filter and a choice of one', () => {
    const p = block("[On Play] Delete 1 of your opponent's Digimon with 4000 DP or less.");
    expect(p.blocks[0].actions).toEqual([
      { type: 'delete', target: { kind: 'select', side: 'opponent', zone: 'battle', filter: { cardType: 'digimon', dp: { op: 'le', n: 4000 } }, mode: 'exactly', n: 1 } },
    ]);
  });

  it('reads up-to deletes with a level filter', () => {
    const p = block('[Main] Delete up to 2 of your opponent\'s Digimon with a level 3 or lower.');
    const a = p.blocks[0].actions![0];
    expect(a).toMatchObject({ type: 'delete', target: { mode: 'upTo', n: 2, filter: { level: { op: 'le', n: 3 } } } });
  });

  it('reads a turn DP buff on your Digimon', () => {
    const p = block('[Main] 1 of your Digimon gets +3000 DP for the turn.');
    expect(p.blocks[0].actions![0]).toMatchObject({ type: 'dp', delta: 3000, duration: 'turn' });
  });

  it('reads memory gain and loss', () => {
    expect(block('[Main] Gain 2 memory.').blocks[0].actions).toEqual([{ type: 'memory', delta: 2 }]);
    expect(block('[When Attacking] Lose 2 memory.').blocks[0].actions).toEqual([{ type: 'memory', delta: -2 }]);
  });

  it('reads the reveal template across three sentences', () => {
    const text =
      '[When Digivolving] Reveal the top 3 cards of your deck. Add 1 yellow Digimon card and 1 purple Digimon card among them to your hand. Place the remaining cards at the bottom of your deck in any order.';
    const p = block(text);
    expect(p.complete).toBe(true);
    expect(p.blocks[0].actions).toEqual([
      {
        type: 'revealTop',
        n: 3,
        picks: [
          { filter: { cardType: 'digimon', color: 'yellow' }, n: 1 },
          { filter: { cardType: 'digimon', color: 'purple' }, n: 1 },
        ],
      },
    ]);
  });

  it('reads Security activation with add-to-hand', () => {
    const p = block("[Security] Activate this card's [Main] effects. Then, add this card to your hand.");
    expect(p.blocks[0].timings).toEqual(['security']);
    expect(p.blocks[0].actions!.map((a) => a.type)).toEqual(['activateMain', 'addSourceToHand']);
  });

  it('reads a conditional clause and its "If you do" continuation', () => {
    const p = parseCardText('T', {
      effect: '-',
      digivolveEffect: '[When Attacking] If you have a yellow Digimon in play, ＜Draw 1＞\nIf you do, trash 1 card in your hand.',
      securityEffect: '-',
    });
    expect(p.complete).toBe(true);
    const actions = p.blocks[0].actions!;
    expect(actions[0]).toMatchObject({ type: 'draw', n: 1, when: { kind: 'colorInPlay', color: 'yellow' } });
    expect(actions[1]).toMatchObject({ type: 'trashFromHand', when: { kind: 'ifDone' } });
  });

  it('marks [Once Per Turn] and reads a self unsuspend', () => {
    const b = block('[When Attacking] [Once Per Turn] Unsuspend this Digimon.').blocks[0];
    expect(b.oncePerTurn).toBe(true);
    expect(b.actions).toEqual([{ type: 'suspend', target: { kind: 'self' }, suspended: false }]);
  });

  it('reads optional "you may" and a trash-zone return', () => {
    const b = block('[On Play] You may return 1 purple Digimon card from your trash to your hand.').blocks[0];
    expect(b.optional).toBe(true);
    expect(b.actions![0]).toMatchObject({ type: 'returnToHand', target: { zone: 'trash', side: 'own', filter: { color: 'purple' } } });
  });

  it('reads trash-the-top then return with Then', () => {
    const p = block('[When Digivolving] Trash the top 3 cards of your deck. Then, return 1 Digimon card from your trash to your hand.');
    expect(p.complete).toBe(true);
    expect(p.blocks[0].actions!.map((a) => a.type)).toEqual(['trashDeckTop', 'returnToHand']);
  });

  it('parses continuous DP and keyword lines without a duration', () => {
    const p = block('[Your Turn] This Digimon gets +1000 DP.\n[Your Turn] All of your yellow Digimon gain ＜Retaliation＞');
    expect(p.blocks[0].timings).toEqual(['yourTurn']);
    expect(p.blocks[0].actions![0]).toMatchObject({ type: 'dp', duration: 'continuous' });
    expect(p.blocks[1].actions![0]).toMatchObject({ type: 'keyword', keyword: 'Retaliation', duration: 'continuous' });
  });

  it('leaves unsupported text unparsed and keeps the card incomplete', () => {
    const p = block('[Your Turn] When this Digimon is blocked, gain 3 memory.');
    expect(p.complete).toBe(false);
    expect(p.blocks[0].actions).toBeNull();
  });

  it('treats keyword-only lines as static', () => {
    const p = block('＜Blocker＞\n＜Security A. +1＞');
    expect(p.complete).toBe(true);
    expect(p.lines.map((l) => l.status)).toEqual(['static', 'static']);
  });

  it('does not split a sentence on the period inside a keyword', () => {
    expect(splitSentences('＜Security A. +1＞ for the turn. Gain 1 memory.')).toEqual(['＜Security A. +1＞ for the turn', 'Gain 1 memory']);
  });

  it('reads descriptors and target phrases', () => {
    expect(parseDescriptor('purple level 3 digimon card')).toEqual({ color: 'purple', level: { op: 'eq', n: 3 }, cardType: 'digimon' });
    expect(parseDescriptor('suspended digimon with 5000 dp or more')).toEqual({ suspended: true, cardType: 'digimon', dp: { op: 'ge', n: 5000 } });
    expect(targetPhrase('all of your digimon')).toMatchObject({ kind: 'select', side: 'own', mode: 'all' });
    expect(targetPhrase('this digimon')).toEqual({ kind: 'self' });
    expect(parseDescriptor('card with the [free] trait')).toBeNull();
  });

  it('returns null for an unknown phrase and never throws', () => {
    expect(parseBody(['Choose any number of your opponent Digimon'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Resolver and integration. Card records are synthetic and registered once for this file.
// ---------------------------------------------------------------------------------------------

type Rec = { type?: string; lv?: string; color?: string; dp?: number; cost?: number; effect?: string; inh?: string; sec?: string; optColor?: string };
function rec(id: string, o: Rec = {}): Record<string, unknown> {
  return {
    id,
    cardType: o.type ?? 'Digimon',
    cardLv: o.lv ?? 'Lv.3',
    color: o.color ?? 'Red',
    dp: String(o.dp ?? 3000),
    playCost: String(o.cost ?? 0),
    name: { english: id },
    effect: o.effect ?? '-',
    digivolveEffect: o.inh ?? '-',
    securityEffect: o.sec ?? '-',
    digivolveCondition: [],
    optionCardColourRequirement: o.optColor ?? '-',
  };
}

beforeAll(() => {
  registerCardRecords([
    rec('PLAIN', { dp: 3000 }),
    rec('BIG', { dp: 6000 }),
    rec('DRAW1', { effect: '[On Play] ＜Draw 1＞' }),
    rec('DELETE-4K', { effect: "[On Play] Delete 1 of your opponent's Digimon with 4000 DP or less." }),
    rec('MAY-DRAW', { effect: '[When Attacking] You may ＜Draw 1＞.' }),
    rec('ONCE-MEM', { effect: '[When Attacking] [Once Per Turn] Gain 1 memory.' }),
    rec('REVEAL-YEL', { effect: '[On Play] Reveal the top 3 cards of your deck. Add 1 yellow Digimon card among them to your hand. Place the remaining cards at the bottom of your deck in any order.' }),
    rec('YEL', { color: 'Yellow', dp: 2000 }),
    rec('RED', { color: 'Red', dp: 2000 }),
    rec('DIG-SRC', { inh: '[When Attacking] ＜Draw 1＞' }),
    rec('OPT-MEM', { type: 'Option', lv: '-', color: 'Red', effect: '[Main] Gain 2 memory.' }),
  ]);
});

afterAll(() => setCardInfoSource(null));

const card = (uid: string, cardId: string): CardRef => ({ uid, cardId });
const stack = (stackId: string, cards: CardRef[], extra: Partial<Stack> = {}): Stack => ({ stackId, cards, suspended: false, dpMod: 0, ...extra });

/** Assisted main phase, turn 2, memory +5, the active player has deck cards, the opponent has security. */
function base(): GameState {
  const s = createGame(11, [], [], ['A', 'B'], 'assisted');
  s.phase = 'main';
  s.activePlayer = 0;
  s.turn = 2;
  s.memory = 5;
  s.players[0].deck = [card('d0', 'PLAIN'), card('d1', 'PLAIN'), card('d2', 'PLAIN'), card('d3', 'PLAIN')];
  s.players[1].security = [0, 1, 2, 3, 4].map((i) => ({ uid: `sec${i}`, cardId: 'PLAIN', faceUp: false }));
  s.players[1].deck = [card('od0', 'PLAIN')];
  return s;
}

const apply = (s: GameState, cmd: Command) => applyCommand(s, cmd);
const hasPending = (s: GameState) => s.pending?.kind === 'effect';

describe('effect resolver', () => {
  it('a [On Play] draw resolves when the card is played', () => {
    let s = base();
    s.players[0].hand = [card('h1', 'DRAW1')];
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(s.players[0].deck.length).toBe(3);
    expect(s.players[0].hand.map((c) => c.cardId)).toEqual(['PLAIN']);
    expect(s.log.some((l) => l.text.startsWith('DRAW1 [On Play]:'))).toBe(true);
  });

  it('a delete with two legal targets asks the controller, then deletes the chosen one', () => {
    let s = base();
    s.players[0].hand = [card('h1', 'DELETE-4K')];
    s.players[1].battle = [stack('o1', [card('x1', 'PLAIN')]), stack('o2', [card('x2', 'PLAIN')])];
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(s.pending?.kind).toBe('effect');
    expect(s.pending && 'owner' in s.pending && s.pending.owner).toBe(0);
    expect(() => apply(s, { type: 'resolveEffect', player: 0, picks: ['o1', 'o2'] })).toThrow();
    s = apply(s, { type: 'resolveEffect', player: 0, picks: ['o2'] });
    expect(s.pending).toBeFalsy();
    expect(s.players[1].battle.map((x) => x.stackId)).toEqual(['o1']);
    expect(s.players[1].trash.map((c) => c.uid)).toEqual(['x2']);
  });

  it('a single legal target is chosen without asking', () => {
    let s = base();
    s.players[0].hand = [card('h1', 'DELETE-4K')];
    s.players[1].battle = [stack('o1', [card('x1', 'PLAIN')]), stack('o2', [card('x2', 'BIG')])];
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(s.pending).toBeFalsy();
    expect(s.players[1].battle.map((x) => x.stackId)).toEqual(['o2']);
  });

  it('"you may" asks first; declining skips it and the attack goes on to security', () => {
    let s = base();
    s.players[0].battle = [stack('b1', [card('c1', 'MAY-DRAW')], { enteredTurn: 1 })];
    s = apply(s, { type: 'attack', player: 0, attackerStackId: 'b1', target: { kind: 'player' } });
    expect(s.pending?.kind).toBe('effect');
    expect(s.pending && 'mode' in s.pending && s.pending.mode).toBe('confirm');
    s = apply(s, { type: 'resolveEffect', player: 0, yes: false });
    expect(s.players[0].deck.length).toBe(4);
    expect(s.pending?.kind).toBe('security');
  });

  it('"you may" with yes draws, then the attack continues', () => {
    let s = base();
    s.players[0].battle = [stack('b1', [card('c1', 'MAY-DRAW')], { enteredTurn: 1 })];
    s = apply(s, { type: 'attack', player: 0, attackerStackId: 'b1', target: { kind: 'player' } });
    s = apply(s, { type: 'resolveEffect', player: 0, yes: true });
    expect(s.players[0].deck.length).toBe(3);
    expect(s.pending?.kind).toBe('security');
  });

  it('inherited digivolution text fires for the stack', () => {
    let s = base();
    s.players[0].battle = [stack('b1', [card('g1', 'DIG-SRC'), card('c1', 'PLAIN')], { enteredTurn: 1 })];
    s = apply(s, { type: 'attack', player: 0, attackerStackId: 'b1', target: { kind: 'player' } });
    expect(s.players[0].deck.length).toBe(3);
  });

  it('[Once Per Turn] fires once per turn', () => {
    let s = base();
    s.players[0].battle = [stack('b1', [card('c1', 'ONCE-MEM')], { enteredTurn: 1 })];
    s.players[1].battle = [stack('o1', [card('x1', 'RED')], { suspended: true })];
    const before = s.memory;
    s = apply(s, { type: 'attack', player: 0, attackerStackId: 'b1', target: { kind: 'stack', stackId: 'o1' } });
    expect(s.memory).toBe(before + 1);
    s.players[1].battle.push(stack('o2', [card('x2', 'RED')], { suspended: true }));
    s.players[0].battle[0].suspended = false;
    s = apply(s, { type: 'attack', player: 0, attackerStackId: 'b1', target: { kind: 'stack', stackId: 'o2' } });
    expect(s.memory).toBe(before + 1);
  });

  it('reveal-top picks the matching card and returns the rest to the bottom', () => {
    let s = base();
    s.players[0].deck = [card('a', 'RED'), card('b', 'YEL'), card('c', 'YEL'), card('e', 'RED')];
    s.players[0].hand = [card('h1', 'REVEAL-YEL')];
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(s.pending?.kind).toBe('effect');
    s = apply(s, { type: 'resolveEffect', player: 0, picks: ['c'] });
    expect(s.players[0].hand.some((c) => c.uid === 'c')).toBe(true);
    expect(s.players[0].reveal).toEqual([]);
    expect(s.players[0].deck.length).toBe(3);
  });

  it('with autoEffects off, the trigger becomes a reminder and nothing moves', () => {
    let s = base();
    s.autoEffects = false;
    s.players[0].hand = [card('h1', 'DRAW1')];
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(s.players[0].deck.length).toBe(4);
    expect(s.reminders?.some((r) => r.timing === 'On Play')).toBe(true);
  });

  it('a played option runs its [Main] effect', () => {
    let s = base();
    s.players[0].hand = [card('h1', 'OPT-MEM')];
    const before = s.memory;
    s = apply(s, { type: 'playFromHand', player: 0, uid: 'h1', to: 'option' });
    expect(s.memory).toBe(before - 0 + 2);
    expect(s.players[0].trash.map((c) => c.uid)).toEqual(['h1']);
  });

  it('undo takes back a trigger and its resolution as one step', () => {
    const s = base();
    s.players[0].hand = [card('h1', 'DRAW1')];
    let h = createHistory(s);
    h = dispatch(h, { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' });
    expect(h.present.players[0].deck.length).toBe(3);
    h = undo(h);
    expect(h.present.players[0].deck.length).toBe(4);
    expect(h.present.players[0].hand.map((c) => c.uid)).toEqual(['h1']);
  });
});

describe('two peers', () => {
  /** Peer 1 sees player 0's hidden cards as placeholders. The wire carries the rest. */
  it('the receiving peer reaches the same public state through the wire', () => {
    const s0 = base();
    s0.online = true;
    s0.players[0].deck = [card('a', 'RED'), card('b', 'YEL'), card('c', 'YEL'), card('e', 'RED')];
    s0.players[0].hand = [card('h1', 'REVEAL-YEL')];
    const s1: GameState = JSON.parse(JSON.stringify(s0));
    s1.players[0] = redactPlayer(s0.players[0]);
    s1.players[0].id = 0;

    const cmd1: Command = { type: 'playFromHand', player: 0, uid: 'h1', to: 'battle' };
    const next1 = apply(s0, cmd1);
    const w1 = buildWire(s0, next1, cmd1);
    const remote1 = applyCommand(s1, { ...w1.cmd, ...(w1.reveals ? { reveals: w1.reveals } : {}) });
    expect(remote1.pending?.kind).toBe('effect');
    expect(publicHash(remote1)).toBe(publicHash(next1));

    const cmd2: Command = { type: 'resolveEffect', player: 0, picks: ['c'] };
    const next2 = apply(next1, cmd2);
    const w2 = buildWire(next1, next2, cmd2);
    const remote2 = applyCommand(remote1, { ...w2.cmd, ...(w2.reveals ? { reveals: w2.reveals } : {}) });
    expect(publicHash(remote2)).toBe(publicHash(next2));
    expect(next2.players[0].reveal.length).toBe(0);
  });
});
