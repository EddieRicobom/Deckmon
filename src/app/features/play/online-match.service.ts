import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DeckListEntry } from './core/game';
import { redactPlayer } from './core/view';
import { GameState, PlayerIndex, PlayerState } from './core/types';
import { ResyncPayload, WireCommand, createOnlineState, createOwnBoard, publicHash, resyncPayload } from './core/wire';
import { GameSession, CommandTransport } from './game-session.service';
import { PvpError } from './net/errors';
import type { PeerHello } from './net/rooms';
import { PvpService } from './net/pvp.service';
import type { NetMessage } from './net/protocol';

export type MatchRole = 'host' | 'guest';
export type MatchPhase = 'idle' | 'waiting' | 'joining' | 'handshake' | 'playing';

export interface ChatLine {
  mine: boolean;
  name: string;
  text: string;
}

export interface HostSetup {
  name: string;
  deckName: string;
  entries: DeckListEntry[];
  roomName: string;
  isPublic: boolean;
  password: string;
}

export interface JoinSetup {
  name: string;
  deckName: string;
  entries: DeckListEntry[];
  password: string;
}

const NAME_KEY = 'digimon.play.name';
const MAX_NAME = 40;
const MAX_CHAT_LINES = 200;
const MAX_CARD_ID = 64;
const HASH_WINDOW = 64;

/** A plain-English message for a PvpError code. Anything else is shown as it is. */
export function describePvpError(err: unknown): string {
  if (err instanceof PvpError) {
    switch (err.code) {
      case 'wrong-password':
        return 'Wrong password for this room.';
      case 'not-found':
        return 'No room found with that code. Check the code, or the host may have closed the room.';
      case 'room-busy':
        return 'That room already has a guest.';
      case 'network':
        return 'Network problem while connecting. Check your connection and try again.';
      case 'webrtc':
        return 'Could not open a direct connection to the other device. Try again.';
      case 'no-candidates':
        return 'No network route to the other device. Try another network, or use the manual connection.';
      case 'invalid-code':
        return 'Room codes have 4 characters.';
      case 'protocol':
        return 'The other device runs an incompatible version of the game.';
      case 'cancelled':
        return 'Cancelled.';
      default:
        return err.message || 'Something went wrong.';
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function loadStoredName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? '').slice(0, MAX_NAME);
  } catch {
    return '';
  }
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage can be blocked. The name is simply not remembered.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Shape check for a board received from the other device. The reducer checks the rules; this checks the shape. */
function parseBoard(raw: unknown, owner: PlayerIndex): PlayerState | null {
  if (!isObject(raw) || raw['id'] !== owner || typeof raw['name'] !== 'string') return null;
  const arrays = ['deck', 'eggDeck', 'hand', 'security', 'trash', 'reveal', 'battle', 'tamer', 'option'];
  for (const key of arrays) if (!Array.isArray(raw[key])) return null;
  if (raw['breeding'] !== null && !isObject(raw['breeding'])) return null;
  return { ...(raw as unknown as PlayerState), name: (raw['name'] as string).slice(0, MAX_NAME), eggUids: [] };
}

/** Shape check for a wire command from the other device. */
function parseWire(raw: unknown, sender: PlayerIndex): WireCommand | null {
  if (!isObject(raw) || !isObject(raw['cmd']) || typeof raw['cmd']['type'] !== 'string') return null;
  const cmd = raw['cmd'] as unknown as WireCommand['cmd'];
  if (cmd.player !== sender) return null;
  if (cmd.rng !== undefined && (typeof cmd.rng !== 'number' || !Number.isSafeInteger(cmd.rng))) return null;
  const wire: WireCommand = { cmd };
  const reveals = raw['reveals'];
  if (reveals !== undefined) {
    if (!isObject(reveals)) return null;
    for (const value of Object.values(reveals)) {
      if (typeof value !== 'string' || value.length > MAX_CARD_ID) return null;
    }
    wire.reveals = reveals as Record<string, string>;
  }
  const board = raw['board'];
  if (board !== undefined) {
    const parsed = parseBoard(board, sender);
    if (!parsed) return null;
    wire.board = parsed;
  }
  return wire;
}

/**
 * Online match over `PvpService`. It runs the handshake (hello, then setup with each side's redacted board), sends
 * every local move as a wire command, applies the other side's moves, checks public-state hashes, and handles
 * resync, undo, chat and resign. The game rules stay in `core/`.
 */
@Injectable({ providedIn: 'root' })
export class OnlineMatchService implements OnDestroy {
  private readonly pvp = inject(PvpService);
  private readonly session = inject(GameSession);
  private readonly router = inject(Router);

  readonly role = signal<MatchRole | null>(null);
  readonly phase = signal<MatchPhase>('idle');
  readonly error = signal<string | null>(null);
  readonly remoteName = signal('');
  readonly remoteDeckName = signal('');
  readonly chat = signal<ChatLine[]>([]);
  readonly desync = signal(false);
  readonly resignedBy = signal<PlayerIndex | null>(null);
  readonly status = this.pvp.status;
  readonly roomCode = this.pvp.roomCode;
  readonly rooms = this.pvp.rooms;
  /** The game is running but the link is down: the playmat shows a pause overlay. */
  readonly paused = computed(() => this.phase() === 'playing' && this.status() !== 'connected' && this.resignedBy() === null);
  readonly localName = signal(loadStoredName());

  private entries: DeckListEntry[] = [];
  private ownBoard: { player: PlayerState; rngState: number; seed: number } | null = null;
  private rival: PlayerState | null = null;
  private readonly myHashes = new Map<number, string>();
  private readonly peerHashes = new Map<number, string>();
  private readonly unsubs: Array<() => void> = [];

  private readonly transport: CommandTransport = {
    send: (wire) => this.onLocalMove(wire),
    sendUndo: (count) => this.onLocalUndo(count),
  };

  constructor() {
    this.unsubs.push(this.pvp.onMessage((msg) => this.onMessage(msg)));
    this.unsubs.push(this.pvp.client.onHello((hello) => this.onHello(hello)));
  }

  /** Remembers the display name for the next visit. */
  setName(name: string): void {
    const clean = name.slice(0, MAX_NAME);
    this.localName.set(clean);
    storeName(clean);
  }

  // ---- lobby actions --------------------------------------------------------------------------

  /** Opens a room. Once a guest connects, the handshake starts the game. */
  host(setup: HostSetup): void {
    if (!this.begin('host', setup)) return;
    this.phase.set('waiting');
    this.pvp
      .hostRoom({
        hostName: this.localName(),
        deckName: setup.deckName,
        isPublic: setup.isPublic,
        roomName: setup.roomName,
        password: setup.password || undefined,
      })
      .then(
        () => this.afterConnect(),
        (err: unknown) => this.fail(err),
      );
  }

  /** Manual flow, host side: creates an offer (no brokers). Returns the code to copy to the guest. */
  async manualOffer(setup: HostSetup): Promise<string | null> {
    if (!this.begin('host', setup)) return null;
    this.phase.set('waiting');
    try {
      return await this.pvp.createManualOffer();
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /** Manual flow, host side: takes the answer code from the guest. */
  async manualAnswer(answerCode: string): Promise<void> {
    try {
      await this.pvp.acceptManualAnswer(answerCode.trim());
      this.afterConnect();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Manual flow, guest side: takes the offer, returns the answer code to send back. */
  async manualAccept(offerCode: string, setup: JoinSetup): Promise<string | null> {
    if (!this.begin('guest', setup)) return null;
    this.phase.set('joining');
    try {
      return await this.pvp.acceptManualOffer(offerCode.trim());
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  join(code: string, setup: JoinSetup): void {
    if (!this.begin('guest', setup)) return;
    this.phase.set('joining');
    this.pvp.joinRoom(code.trim().toUpperCase(), this.localName(), setup.password || undefined).then(
      () => this.afterConnect(),
      (err: unknown) => this.fail(err),
    );
  }

  reconnect(): void {
    this.pvp.reconnect().catch((err: unknown) => this.error.set(describePvpError(err)));
  }

  /** Leaves the match and forgets the session. */
  leave(): void {
    this.pvp.close();
    this.session.clear();
    this.reset();
    this.role.set(null);
    this.phase.set('idle');
    this.error.set(null);
  }

  resign(): void {
    const me = this.session.localPlayer();
    if (this.phase() !== 'playing' || me === null || this.resignedBy() !== null) return;
    this.pvp.send({ t: 'resign' });
    this.resignedBy.set(me);
  }

  sendChat(text: string): void {
    const clean = text.trim().slice(0, 300);
    if (!clean || this.phase() === 'idle') return;
    this.pvp.send({ t: 'chat', text: clean });
    this.pushChat(true, this.localName(), clean);
  }

  /** Active player only: sends shared fields and its own redacted board to the opponent. */
  resync(): void {
    const state = this.session.state();
    const me = this.session.localPlayer();
    if (!state || me === null) return;
    if (state.activePlayer !== me) {
      this.session.lastError.set('Only the active player can resynchronise the table.');
      return;
    }
    this.pvp.send({ t: 'resync', payload: resyncPayload(state, me) });
    this.recordHash();
  }

  // ---- transport from the game session --------------------------------------------------------

  private onLocalMove(wire: WireCommand): void {
    if (!this.pvp.send({ t: 'cmd', seq: 0, cmd: wire })) {
      this.session.lastError.set('Too many moves are waiting for the opponent. Reconnect and try again.');
      this.desync.set(true);
    }
    this.recordHash();
  }

  private onLocalUndo(count: number): void {
    this.pvp.send({ t: 'undo', count });
    this.recordHash();
  }

  // ---- incoming messages ----------------------------------------------------------------------

  private onMessage(msg: NetMessage): void {
    switch (msg.t) {
      case 'setup': {
        const remote = this.remoteIndex();
        if (this.phase() === 'playing' || remote === null) return;
        const board = parseBoard(msg.board, remote);
        if (!board) return;
        this.rival = board;
        this.remoteName.set(board.name);
        this.ensureOwnBoard();
        this.tryStart();
        return;
      }
      case 'cmd': {
        const remote = this.remoteIndex();
        if (this.phase() !== 'playing' || remote === null) return;
        const wire = parseWire(msg.cmd, remote);
        if (!wire || !this.session.applyRemote(wire)) {
          this.desync.set(true);
          return;
        }
        this.recordHash();
        return;
      }
      case 'undo': {
        if (this.phase() !== 'playing') return;
        if (!this.session.applyRemoteUndo(msg.count)) {
          this.desync.set(true);
          return;
        }
        this.recordHash();
        return;
      }
      case 'state-hash':
        this.onPeerHash(msg.seq, msg.hash);
        return;
      case 'resync': {
        const remote = this.remoteIndex();
        if (this.phase() !== 'playing' || remote === null) return;
        if (!this.session.applyResyncPayload(msg.payload as ResyncPayload, remote)) return;
        this.desync.set(false);
        this.recordHash();
        return;
      }
      case 'chat':
        this.pushChat(false, this.remoteName() || 'Opponent', msg.text);
        return;
      case 'resign': {
        const remote = this.remoteIndex();
        if (remote !== null && this.phase() === 'playing') this.resignedBy.set(remote);
        return;
      }
      default:
        return;
    }
  }

  private onHello(hello: PeerHello): void {
    this.remoteDeckName.set(hello.deckName);
    if (!this.remoteName()) this.remoteName.set(hello.name);
    // A reconnect during a game keeps the game. Only the opening handshake sends the board.
    if (this.phase() === 'playing' || this.role() === null) return;
    this.ensureOwnBoard();
    this.phase.set('handshake');
    if (this.ownBoard) {
      this.pvp.send({ t: 'setup', board: redactPlayer(this.ownBoard.player) });
    }
  }

  private onPeerHash(seq: number, hash: string): void {
    if (this.phase() !== 'playing') return;
    const mine = this.myHashes.get(seq);
    if (mine === undefined) {
      this.peerHashes.set(seq, hash);
      this.trim(this.peerHashes);
      return;
    }
    if (mine !== hash) this.desync.set(true);
  }

  // ---- internals ------------------------------------------------------------------------------

  /** Records this side's public hash for the current command count and checks the peer's hash for it. */
  private recordHash(): void {
    const state = this.session.state();
    if (!state) return;
    const count = this.session.commandCount();
    const hash = publicHash(state);
    this.myHashes.set(count, hash);
    this.trim(this.myHashes);
    const peer = this.peerHashes.get(count);
    if (peer !== undefined) {
      this.peerHashes.delete(count);
      if (peer !== hash) this.desync.set(true);
    }
    this.pvp.send({ t: 'state-hash', seq: count, hash });
  }

  private trim(map: Map<number, string>): void {
    while (map.size > HASH_WINDOW) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private tryStart(): void {
    const role = this.role();
    if (this.phase() === 'playing' || role === null || !this.ownBoard || !this.rival) return;
    const ownIndex: PlayerIndex = role === 'host' ? 0 : 1;
    const rivalName = this.rival.name;
    // Names come from the boards each side sent, so both peers write the same game log.
    const names: [string, string] = ownIndex === 0 ? [this.localName(), rivalName] : [rivalName, this.localName()];
    const state: GameState = createOnlineState({
      ownIndex,
      names,
      own: this.ownBoard,
      seed: this.ownBoard.seed,
      rival: this.rival,
    });
    this.session.startOnline(state, ownIndex, this.transport);
    this.myHashes.clear();
    this.peerHashes.clear();
    this.chat.set([]);
    this.desync.set(false);
    this.resignedBy.set(null);
    this.phase.set('playing');
    this.recordHash();
    void this.router.navigateByUrl('/play/table');
  }

  private ensureOwnBoard(): void {
    const role = this.role();
    if (this.ownBoard || role === null) return;
    const seed = Date.now() ^ Math.floor(Math.random() * 0xffffffff);
    const id: PlayerIndex = role === 'host' ? 0 : 1;
    const built = createOwnBoard(id, this.localName(), this.entries, seed);
    this.ownBoard = { ...built, seed };
  }

  private afterConnect(): void {
    if (this.phase() === 'waiting' || this.phase() === 'joining') this.phase.set('handshake');
  }

  private begin(role: MatchRole, setup: { name: string; entries: DeckListEntry[] }): boolean {
    if (this.session.state() && !this.session.online()) {
      this.error.set('Finish or leave your current game before starting an online match.');
      return false;
    }
    this.pvp.close();
    this.session.clear();
    this.reset();
    const name = setup.name.trim().slice(0, MAX_NAME);
    if (name) {
      this.localName.set(name);
      storeName(name);
    }
    this.entries = setup.entries;
    this.role.set(role);
    this.error.set(null);
    return true;
  }

  private fail(err: unknown): void {
    this.error.set(describePvpError(err));
    this.phase.set('idle');
    this.role.set(null);
  }

  private reset(): void {
    this.entries = [];
    this.ownBoard = null;
    this.rival = null;
    this.remoteName.set('');
    this.remoteDeckName.set('');
    this.chat.set([]);
    this.desync.set(false);
    this.resignedBy.set(null);
    this.myHashes.clear();
    this.peerHashes.clear();
  }

  /** The other seat: from the live game when there is one, otherwise from the role during the handshake. */
  private remoteIndex(): PlayerIndex | null {
    const me = this.session.localPlayer();
    if (me !== null) return me === 0 ? 1 : 0;
    const role = this.role();
    return role === null ? null : role === 'host' ? 1 : 0;
  }

  private pushChat(mine: boolean, name: string, text: string): void {
    this.chat.update((lines) => [...lines, { mine, name, text: text.slice(0, 300) }].slice(-MAX_CHAT_LINES));
  }

  ngOnDestroy(): void {
    for (const off of this.unsubs) off();
  }
}
