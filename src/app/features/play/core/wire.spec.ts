import { applyCommand } from './reducer';
import { Command } from './commands';
import { createGame, DeckListEntry } from './game';
import { redactFor, redactPlayer } from './view';
import { applyResync, buildWire, createOnlineState, createOwnBoard, publicHash, resyncPayload, WireCommand } from './wire';
import { GameState, PlayerIndex } from './types';

const deckA: DeckListEntry[] = [
  { id: 'BT1-001', count: 20, cardType: 'Digimon' },
  { id: 'BT1-003', count: 10, cardType: 'Tamer' },
  { id: 'BT1-010', count: 10, cardType: 'Option' },
  { id: 'BT1-020', count: 5, cardType: 'Digi-Egg' },
];
const deckB: DeckListEntry[] = [
  { id: 'BT2-001', count: 30, cardType: 'Digimon' },
  { id: 'BT2-002', count: 5, cardType: 'Digi-Egg' },
];

/**
 * Two peers in one test. `host` holds the full state from player 0's side (own board real, opponent placeholder),
 * `guest` holds the same game from player 1's side. Local moves go through `buildWire`, remote moves through the
 * same reducer the real session uses.
 */
function pair(seed = 7): { host: GameState; guest: GameState } {
  const full = createGame(seed, deckA, deckB, ['Host', 'Guest']);
  return { host: full, guest: redactFor(full, 1) };
}

/** Plays one command on `local`, returns the wire form and the next local state. */
function localMove(local: GameState, cmd: Command): { next: GameState; wire: WireCommand } {
  const next = applyCommand(local, cmd);
  return { next, wire: buildWire(local, next, cmd) };
}

/** Applies a wire command the way the remote peer does. */
function remoteMove(remote: GameState, wire: WireCommand): GameState {
  return applyCommand(remote, { ...wire.cmd, reveals: wire.reveals, board: wire.board });
}

function cardIdOf(state: GameState, player: PlayerIndex, uid: string): string | undefined {
  const p = state.players[player];
  const all = [
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
  return all.find((c) => c.uid === uid)?.cardId;
}

describe('online hidden information', () => {
  it('reveals the card when a hand card is played to the battle area', () => {
    const { host, guest } = pair();
    const uid = host.players[0].hand[0].uid;
    const cardId = host.players[0].hand[0].cardId;

    const { next, wire } = localMove(host, { type: 'playFromHand', player: 0, uid, to: 'battle' });
    expect(wire.reveals).toEqual({ [uid]: cardId });

    const guestNext = remoteMove(guest, wire);
    expect(cardIdOf(guestNext, 0, uid)).toBe(cardId);
    expect(publicHash(guestNext)).toBe(publicHash(next));
  });

  it('keeps the placeholder when the reveal is missing', () => {
    const { host, guest } = pair();
    const uid = host.players[0].hand[0].uid;
    const { wire } = localMove(host, { type: 'playFromHand', player: 0, uid, to: 'battle' });

    const guestNext = applyCommand(guest, wire.cmd);
    expect(cardIdOf(guestNext, 0, uid)).toBe('?');
  });

  it('sends no reveal for a draw, which only moves a hidden card', () => {
    const { host, guest } = pair();
    const { next, wire } = localMove(host, { type: 'draw', player: 0 });
    expect(wire.reveals).toBeUndefined();
    expect(wire.board).toBeUndefined();

    const guestNext = remoteMove(guest, wire);
    expect(publicHash(guestNext)).toBe(publicHash(next));
    expect(guestNext.players[0].hand.every((c) => c.cardId === '?')).toBe(true);
  });

  it('does not reveal a card moved between two hidden zones', () => {
    const { host } = pair();
    const top = host.players[0].deck[host.players[0].deck.length - 1];
    const { wire } = localMove(host, { type: 'moveCard', player: 0, uid: top.uid, to: 'hand' });
    expect(wire.reveals).toBeUndefined();
  });

  it('reveals a card moved from the deck to the trash', () => {
    const { host, guest } = pair();
    const top = host.players[0].deck[host.players[0].deck.length - 1];
    const { next, wire } = localMove(host, { type: 'moveCard', player: 0, uid: top.uid, to: 'trash' });
    expect(wire.reveals).toEqual({ [top.uid]: top.cardId });
    expect(publicHash(remoteMove(guest, wire))).toBe(publicHash(next));
  });

  it('reveals a security card when it is turned face-up', () => {
    const { host, guest } = pair();
    const sec = host.players[0].security[0];
    const { next, wire } = localMove(host, { type: 'setFaceUp', player: 0, uid: sec.uid, faceUp: true });
    expect(wire.reveals).toEqual({ [sec.uid]: sec.cardId });
    expect(publicHash(remoteMove(guest, wire))).toBe(publicHash(next));
  });

  it('sends the redacted board for shuffles, so the peer does not need the PRNG', () => {
    const { host, guest } = pair();
    const { next, wire } = localMove(host, { type: 'mulligan', player: 0 });
    expect(wire.board).toBeDefined();
    expect(wire.board!.id).toBe(0);
    expect(wire.board!.hand.every((c) => c.cardId === '?')).toBe(true);

    const guestNext = remoteMove(guest, wire);
    expect(publicHash(guestNext)).toBe(publicHash(next));
  });

  it('keeps the public hash equal across a sequence of mixed moves', () => {
    let { host, guest } = pair(99);
    const steps: Command[] = [
      { type: 'playFromHand', player: 0, uid: host.players[0].hand[0].uid, to: 'battle' },
      { type: 'hatch', player: 0 },
      { type: 'revealSecurity', player: 0 },
      { type: 'passTurn', player: 0, memory: 2 },
    ];
    for (const cmd of steps) {
      const moved = localMove(host, cmd);
      host = moved.next;
      guest = remoteMove(guest, moved.wire);
      expect(publicHash(guest)).toBe(publicHash(host));
    }
  });

  it('detects a diverged public view', () => {
    const { host, guest } = pair();
    const { next } = localMove(host, { type: 'draw', player: 0 });
    const other = applyCommand(guest, { type: 'nextPhase', player: 1 });
    expect(publicHash(next)).not.toBe(publicHash(other));
  });

  it('resyncs the receiver to the sender board and shared fields', () => {
    let { host, guest } = pair();
    const moved = localMove(host, { type: 'playFromHand', player: 0, uid: host.players[0].hand[0].uid, to: 'battle' });
    host = moved.next;
    // The guest never received the move, so it is out of sync until the resync.
    expect(publicHash(guest)).not.toBe(publicHash(host));
    guest = applyResync(guest, 0, resyncPayload(host, 0));
    expect(publicHash(guest)).toBe(publicHash(host));
  });

  it('keeps the receiver own board when it applies a resync', () => {
    const { host, guest } = pair();
    const before = guest.players[1].hand.map((c) => c.cardId);
    const after = applyResync(guest, 0, resyncPayload(host, 0));
    expect(after.players[1].hand.map((c) => c.cardId)).toEqual(before);
  });

  it('rejects a resync whose board belongs to the wrong player', () => {
    const { host, guest } = pair();
    const payload = resyncPayload(host, 1);
    expect(() => applyResync(guest, 0, payload)).toThrow();
  });
});

describe('online setup', () => {
  it('builds matching starting states on both peers from the exchanged boards', () => {
    const hostBoard = createOwnBoard(0, 'Host', deckA, 123);
    const guestBoard = createOwnBoard(1, 'Guest', deckB, 456);
    const names: [string, string] = ['Host', 'Guest'];

    const hostState = createOnlineState({
      ownIndex: 0,
      names,
      own: hostBoard,
      seed: 123,
      rival: redactPlayer(guestBoard.player),
    });
    const guestState = createOnlineState({
      ownIndex: 1,
      names,
      own: guestBoard,
      seed: 456,
      rival: redactPlayer(hostBoard.player),
    });

    expect(hostState.players[0].hand.length).toBe(5);
    expect(guestState.players[1].hand.length).toBe(5);
    expect(hostState.players[1].hand.every((c) => c.cardId === '?')).toBe(true);
    expect(guestState.players[0].hand.every((c) => c.cardId === '?')).toBe(true);
    expect(hostState.players[1].hand.length).toBe(guestState.players[1].hand.length);
    expect(publicHash(hostState)).toBe(publicHash(guestState));
  });
});

describe('online coin flips and dice', () => {
  it('gives the same result on both peers even though their PRNG states differ', () => {
    let { host, guest } = pair(21);
    // Advance the host's PRNG without sending it, so the two peers no longer share a PRNG state.
    host = applyCommand(host, { type: 'flipCoin', player: 0 });
    expect(guest.rngState).toBe(0);
    const flip = localMove(host, { type: 'flipCoin', player: 0 });
    const roll = localMove(flip.next, { type: 'rollDice', player: 0, sides: 6 });
    expect(flip.wire.cmd.rng).toBe(host.rngState);

    guest = remoteMove(guest, flip.wire);
    guest = remoteMove(guest, roll.wire);
    const texts = (st: GameState) => st.log.slice(-2).map((e) => e.text);
    expect(texts(guest)).toEqual(texts(roll.next));
    expect(guest.rngState).toBe(roll.next.rngState);
    expect(publicHash(guest)).toBe(publicHash(roll.next));
  });
});

describe('online rules mode', () => {
  it('starts both peers in the host rules mode, with the same public view', () => {
    const hostBoard = createOwnBoard(0, 'Host', deckA, 11);
    const guestBoard = createOwnBoard(1, 'Guest', deckB, 22);
    const names: [string, string] = ['Host', 'Guest'];
    const hostState = createOnlineState({ ownIndex: 0, names, own: hostBoard, seed: 11, rival: redactPlayer(guestBoard.player), mode: 'assisted' });
    const guestState = createOnlineState({ ownIndex: 1, names, own: guestBoard, seed: 22, rival: redactPlayer(hostBoard.player), mode: 'assisted' });
    expect(hostState.mode).toBe('assisted');
    expect(guestState.mode).toBe('assisted');
    expect(hostState.phase).toBe('breeding');
    expect(publicHash(hostState)).toBe(publicHash(guestState));
  });

  it('defaults to manual when no mode is given (older peers)', () => {
    const hostBoard = createOwnBoard(0, 'Host', deckA, 11);
    const guestBoard = createOwnBoard(1, 'Guest', deckB, 22);
    const state = createOnlineState({ ownIndex: 0, names: ['Host', 'Guest'], own: hostBoard, seed: 11, rival: redactPlayer(guestBoard.player) });
    expect(state.mode).toBe('manual');
    expect(state.phase).toBe('unsuspend');
  });
});
