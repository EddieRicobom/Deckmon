/**
 * Hidden-information helpers for online play. Each peer is authoritative for its own board: it holds the real
 * cards, and the opponent's board is a placeholder with the same uids and counts but cardId '?'.
 *
 * The sender turns an applied local command into a WireCommand. The receiver fills the placeholder cards named in
 * `reveals`, applies the command, then replaces its placeholder board with `board` when the command depends on
 * the owner's PRNG (setup, mulligan, shuffleDeck). Both sides then agree on the public view (`publicHash`).
 */
import type { Command } from './commands';
import { allCards, cloneState, dealBoard, DeckListEntry, emptyPlayer, expandDeck } from './game';
import { normaliseSeed } from './rng';
import { redactPlayer, HIDDEN_CARD_ID } from './view';
import { clampMemory } from './reducer';
import { GameState, PHASES, Phase, Pending, PlayerIndex, PlayerState, RulesMode, STATE_VERSION } from './types';
import type { QueueItem } from './effects/ast';

export interface WireCommand {
  cmd: Command;
  reveals?: Record<string, string>;
  board?: PlayerState;
}

/** Commands whose outcome depends on the owner's PRNG state, which the other peer never sees. */
const PRNG_COMMANDS = new Set<Command['type']>(['setup', 'mulligan', 'shuffleDeck']);
/** Every command that draws random numbers. The receiver must start from the sender's PRNG state. */
const RNG_COMMANDS = new Set<Command['type']>([...PRNG_COMMANDS, 'flipCoin', 'rollDice']);

/**
 * The cards on `owner`'s board that were hidden from the opponent before the command and are visible after it.
 * Returned as uid -> real cardId.
 */
export function revealsFor(prev: GameState, next: GameState, owner: PlayerIndex): Record<string, string> {
  const hiddenBefore = new Set(
    allCards(redactPlayer(prev.players[owner]))
      .filter((c) => c.cardId === HIDDEN_CARD_ID)
      .map((c) => c.uid),
  );
  const real = new Map(allCards(next.players[owner]).map((c) => [c.uid, c.cardId] as const));
  const out: Record<string, string> = {};
  for (const card of allCards(redactPlayer(next.players[owner]))) {
    if (card.cardId !== HIDDEN_CARD_ID && hiddenBefore.has(card.uid)) {
      out[card.uid] = real.get(card.uid) ?? HIDDEN_CARD_ID;
    }
  }
  return out;
}

/** Builds the wire form of a command that was just applied locally (`prev` before, `next` after). */
export function buildWire(prev: GameState, next: GameState, cmd: Command): WireCommand {
  const wire: WireCommand = { cmd };
  const reveals = revealsFor(prev, next, cmd.player);
  if (Object.keys(reveals).length > 0) wire.reveals = reveals;
  if (RNG_COMMANDS.has(cmd.type)) wire.cmd = { ...cmd, rng: prev.rngState };
  if (PRNG_COMMANDS.has(cmd.type)) wire.board = redactPlayer(next.players[cmd.player]);
  return wire;
}

/** Deals one's own board from one's own deck with a private seed. The seed never leaves the device. */
export function createOwnBoard(
  id: PlayerIndex,
  name: string,
  entries: readonly DeckListEntry[],
  seed: number,
): { player: PlayerState; rngState: number } {
  const { main, eggs } = expandDeck(id, entries);
  const p: PlayerState = { ...emptyPlayer(id, name), deck: main, eggDeck: eggs, eggUids: eggs.map((c) => c.uid) };
  return dealBoard(p, normaliseSeed(seed));
}

/** Builds the starting state on one peer from its own board and the opponent's redacted board. */
export function createOnlineState(args: {
  ownIndex: PlayerIndex;
  names: [string, string];
  own: { player: PlayerState; rngState: number };
  seed: number;
  rival: PlayerState;
  /** The host's rules choice. Absent means manual. */
  mode?: RulesMode;
}): GameState {
  const rivalIndex: PlayerIndex = args.ownIndex === 0 ? 1 : 0;
  const mine: PlayerState = { ...args.own.player, id: args.ownIndex, name: args.names[args.ownIndex] };
  const theirs: PlayerState = { ...args.rival, id: rivalIndex, name: args.names[rivalIndex], eggUids: [] };
  const players: [PlayerState, PlayerState] = args.ownIndex === 0 ? [mine, theirs] : [theirs, mine];
  return {
    mode: args.mode ?? 'manual',
    pending: null,
    winner: null,
    winReason: null,
    reminders: [],
    seed: normaliseSeed(args.seed),
    rngState: args.own.rngState,
    nextId: 1,
    turn: 1,
    activePlayer: 0,
    phase: args.mode === 'assisted' ? 'breeding' : 'unsuspend',
    memory: 0,
    players,
    log: [{ seq: 0, turn: 1, player: 0, text: `Game started. ${args.names[0]} vs ${args.names[1]}.` }],
    version: STATE_VERSION,
    online: true,
  };
}

/** The public view both peers must agree on. Excludes the log, the seed and the PRNG state. */
export function publicHash(state: GameState): string {
  const view = JSON.stringify({
    t: state.turn,
    a: state.activePlayer,
    p: state.phase,
    m: state.memory,
    n: state.nextId,
    x: state.mode ?? 'manual',
    d: state.pending ?? null,
    w: state.winner ?? null,
    b: [redactPlayer(state.players[0]), redactPlayer(state.players[1])],
    // Queue length only when something waits, so states without effects hash as before.
    q: (state.effectQueue ?? []).length || undefined,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + view.length.toString(16);
}

/** Shared fields plus the sender's own board, redacted. Sent by the active player to resynchronise. */
export interface ResyncPayload {
  turn: number;
  activePlayer: PlayerIndex;
  phase: Phase;
  memory: number;
  nextId: number;
  board: PlayerState;
  mode?: RulesMode;
  pending?: Pending | null;
  winner?: PlayerIndex | null;
  winReason?: string | null;
  effectQueue?: QueueItem[];
}

export function resyncPayload(state: GameState, me: PlayerIndex): ResyncPayload {
  return {
    turn: state.turn,
    activePlayer: state.activePlayer,
    phase: state.phase,
    memory: state.memory,
    nextId: state.nextId,
    board: redactPlayer(state.players[me]),
    mode: state.mode ?? 'manual',
    pending: state.pending ?? null,
    winner: state.winner ?? null,
    winReason: state.winReason ?? null,
    effectQueue: state.effectQueue ?? [],
  };
}

/** Applies a resync from `remote`. Keeps this peer's own board, takes the remote board and the shared fields. */
export function applyResync(state: GameState, remote: PlayerIndex, payload: ResyncPayload): GameState {
  if (!payload || typeof payload !== 'object') throw new Error('Malformed resync');
  if (!PHASES.includes(payload.phase)) throw new Error('Malformed resync phase');
  if (payload.activePlayer !== 0 && payload.activePlayer !== 1) throw new Error('Malformed resync player');
  if (!payload.board || payload.board.id !== remote) throw new Error('Resync board does not belong to the sender');
  if (!Number.isSafeInteger(payload.turn) || !Number.isSafeInteger(payload.nextId)) throw new Error('Malformed resync counters');
  const next = cloneState(state);
  next.turn = payload.turn;
  next.activePlayer = payload.activePlayer;
  next.phase = payload.phase;
  next.memory = clampMemory(payload.memory);
  next.nextId = payload.nextId;
  next.mode = payload.mode ?? 'manual';
  next.pending = payload.pending ?? null;
  next.winner = payload.winner ?? null;
  next.winReason = payload.winReason ?? null;
  next.effectQueue = Array.isArray(payload.effectQueue) ? payload.effectQueue : [];
  next.players[remote] = { ...(JSON.parse(JSON.stringify(payload.board)) as PlayerState), name: state.players[remote].name };
  return next;
}
