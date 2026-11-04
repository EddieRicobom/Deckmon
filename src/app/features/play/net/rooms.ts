import { diag, diagnosticsLine, resetDiagnostics } from './diag';
import { PvpError } from './errors';
import { cleanName, cleanRoomName, Matchmaker } from './matchmaker';
import type { OpenRoom } from './matchmaker';
import { NO_CANDIDATES_MESSAGE, NoCandidatesError, PvpPeer } from './peer';
import { InboundQueue, OutboundQueue, PROTOCOL_VERSION } from './protocol';
import type { NetMessage } from './protocol';
import { ROOM_CODE_LENGTH } from './room-code';
import { SignalHub } from './signal';

/**
 * Framework-agnostic peer-to-peer client for public rooms. No Angular here: `pvp.service.ts` wraps it with signals.
 *
 * Lifecycle: `idle` → `signaling` (finding or opening the room) → `connecting` (guest found, WebRTC opening) →
 * `connected` → `disconnected` (or `failed`). `reconnect()` reuses the room code, so both sides call it and the
 * unacknowledged commands are resent once the new channel opens.
 */

export type PvpStatus = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface RoomAd {
  code: string;
  hostName: string;
  roomName: string;
  deckName: string;
  createdAt: number;
  /** True when the room needs a password. The password itself is never included. */
  hasPassword: boolean;
}

export interface HostRoomOptions {
  hostName: string;
  deckName: string;
  isPublic: boolean;
  roomName: string;
  password?: string;
}

export interface PeerHello {
  name: string;
  deckName: string;
}

export interface ClientOptions {
  /** Injected for tests; by default a new hub is created on first use. */
  hub?: SignalHub;
}

type Unsub = () => void;

const MANUAL_CONNECT_MS = 45000;
const MAX_PASSWORD = 64;

function normalizePassword(value: string | undefined): string {
  return (value ?? '').trim().slice(0, MAX_PASSWORD);
}

export class PvpClient {
  private hub: SignalHub | null;
  private matchmaker: Matchmaker | null = null;
  private status: PvpStatus = 'idle';
  private code: string | null = null;
  private peer: PvpPeer | null = null;
  /** A manual-code peer that is not open yet (not yet attached). */
  private pendingPeer: PvpPeer | null = null;
  private remoteHello: PeerHello | null = null;
  private local: PeerHello = { name: '', deckName: '' };
  private outbound = new OutboundQueue();
  private inbound = new InboundQueue();
  private lastHost: { opts: HostRoomOptions } | null = null;
  private lastJoin: { code: string; name: string; password: string } | null = null;
  private hostHandle: { cancel(): void } | null = null;
  private joinCancel: (() => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private manualDone: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | null = null;

  private readonly statusListeners = new Set<(s: PvpStatus) => void>();
  private readonly messageListeners = new Set<(m: NetMessage) => void>();
  private readonly codeListeners = new Set<(code: string | null) => void>();
  private readonly helloListeners = new Set<(h: PeerHello) => void>();

  constructor(options: ClientOptions = {}) {
    this.hub = options.hub ?? null;
  }

  /** Current room code (host or guest), or null. */
  get roomCode(): string | null {
    return this.code;
  }

  /** The other side's name and deck, once their hello has arrived. */
  get peerHello(): PeerHello | null {
    return this.remoteHello;
  }

  /** Diagnostic trail as one line, for pasting into a chat when pairing fails. */
  diagnostics(): string {
    return diagnosticsLine();
  }

  onStatus(cb: (s: PvpStatus) => void): Unsub {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  onMessage(cb: (msg: NetMessage) => void): Unsub {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onRoomCode(cb: (code: string | null) => void): Unsub {
    this.codeListeners.add(cb);
    return () => this.codeListeners.delete(cb);
  }

  onHello(cb: (h: PeerHello) => void): Unsub {
    this.helloListeners.add(cb);
    return () => this.helloListeners.delete(cb);
  }

  /** Public rooms, in real time. Returns the function that stops listening. */
  listRooms(onUpdate: (rooms: RoomAd[]) => void): Unsub {
    return this.mm().watchRooms((rooms: OpenRoom[]) =>
      onUpdate(
        rooms.map((r) => ({
          code: r.code,
          hostName: r.name,
          roomName: r.roomName,
          deckName: r.note,
          createdAt: r.createdAt,
          hasPassword: r.hasPassword,
        })),
      ),
    );
  }

  /**
   * Opens a room and resolves when a guest is connected (the code is available right away through `roomCode` and
   * `onRoomCode`). A password-protected room is only found by someone who knows the password.
   */
  hostRoom(opts: HostRoomOptions): Promise<{ code: string }> {
    this.startSession();
    const normalized: HostRoomOptions = {
      ...opts,
      roomName: cleanRoomName(opts.roomName) || cleanName(opts.hostName) || 'Sala',
      password: normalizePassword(opts.password),
    };
    this.local = { name: cleanName(opts.hostName) || 'Treinador', deckName: cleanName(opts.deckName, 40) };
    this.lastHost = { opts: normalized };
    return this.startHost(normalized);
  }

  /** Joins a room by code. Resolves when connected; rejects with a `PvpError` (`wrong-password`, `not-found`, …). */
  joinRoom(code: string, guestName: string, password?: string): Promise<void> {
    this.startSession();
    const pw = normalizePassword(password);
    this.local = { name: cleanName(guestName) || 'Treinador', deckName: '' };
    this.lastJoin = { code, name: guestName, password: pw };
    return this.startJoin(code, guestName, pw);
  }

  /**
   * Opens the same room again with the same code after a dropped connection. Both sides call it; the guest rejoins by
   * code, and the unacknowledged commands go out again once the channel opens.
   */
  reconnect(): Promise<void> {
    if (this.peer) return Promise.resolve();
    const keptCode = this.code;
    this.teardown();
    if (this.lastHost) {
      const { opts } = this.lastHost;
      return this.startHost(opts, keptCode ?? undefined).then(() => undefined);
    }
    if (this.lastJoin) {
      const { code, name, password } = this.lastJoin;
      return this.startJoin(code, name, password);
    }
    return Promise.reject(new PvpError('other', 'Não há sala para reconectar.'));
  }

  /**
   * Sends a message. A `cmd` is numbered here (its `seq` field is ignored) and queued until acknowledged; the others go
   * out as they are. Returns false if the message could not be queued (too many commands unacknowledged).
   */
  send(msg: NetMessage): boolean {
    if (msg.t === 'cmd') {
      const envelope = this.outbound.push(msg.cmd);
      if (!envelope) return false;
      // Queued either way: if the channel is not open now, the envelope goes out on the next attach.
      this.peer?.send(envelope);
      return true;
    }
    return this.peer?.send(msg) ?? false;
  }

  /** Manual fallback without brokers: returns the offer code to copy to the guest. */
  async createManualOffer(): Promise<string> {
    this.startSession();
    this.setStatus('signaling');
    let made: { peer: PvpPeer; code: string };
    try {
      made = await PvpPeer.host();
    } catch (e) {
      const noCandidates = e instanceof NoCandidatesError;
      this.setStatus('failed');
      throw new PvpError(noCandidates ? 'no-candidates' : 'webrtc', noCandidates ? NO_CANDIDATES_MESSAGE : 'Não consegui criar o convite.');
    }
    this.adoptPending(made.peer);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    this.manualDone = { promise, resolve, reject };
    this.code = made.code;
    this.emitCode(made.code);
    return made.code;
  }

  /** Guest side of the manual fallback: takes the offer code, returns the answer code to send back. */
  async acceptManualOffer(offerCode: string): Promise<string> {
    this.startSession();
    this.setStatus('connecting');
    const made = await PvpPeer.join(offerCode);
    if (made.ok === false) {
      this.setStatus('failed');
      throw new PvpError('other', made.message);
    }
    this.adoptPending(made.peer);
    setTimeout(() => {
      if (this.pendingPeer === made.peer) {
        this.pendingPeer = null;
        made.peer.close();
        this.setStatus('failed');
      }
    }, MANUAL_CONNECT_MS);
    return made.code;
  }

  /** Host side of the manual fallback: takes the answer code. Resolves when the channel is open. */
  async acceptManualAnswer(answerCode: string): Promise<void> {
    const peer = this.pendingPeer;
    const done = this.manualDone;
    if (!peer || !done) throw new PvpError('other', 'Crie um convite primeiro.');
    const problem = await peer.acceptAnswer(answerCode);
    if (problem) throw new PvpError('other', problem);
    setTimeout(() => {
      if (this.pendingPeer === peer) {
        this.pendingPeer = null;
        peer.close();
        this.setStatus('failed');
        done.reject(new PvpError('network', 'A conexão não abriu a tempo. Gere um convite novo.'));
      }
    }, MANUAL_CONNECT_MS);
    return done.promise;
  }

  /** Leaves the room, stops the rendezvous and forgets the session. */
  close(): void {
    this.teardown();
    this.hub?.close();
    this.hub = null;
    this.matchmaker = null;
    this.lastHost = null;
    this.lastJoin = null;
    this.local = { name: '', deckName: '' };
    this.outbound = new OutboundQueue();
    this.inbound = new InboundQueue();
    this.setStatus('idle');
  }

  private mm(): Matchmaker {
    if (!this.matchmaker) {
      this.hub ??= new SignalHub();
      this.hub.start();
      this.matchmaker = new Matchmaker(this.hub);
    }
    return this.matchmaker;
  }

  private startSession(): void {
    this.teardown();
    this.outbound = new OutboundQueue();
    this.inbound = new InboundQueue();
    this.lastHost = null;
    this.lastJoin = null;
    resetDiagnostics();
  }

  private startHost(opts: HostRoomOptions, reuseCode?: string): Promise<{ code: string }> {
    return new Promise((resolve, reject) => {
      this.pendingReject = reject;
      this.setStatus('signaling');
      this.hostHandle = this.mm().host(
        {
          listed: opts.isPublic,
          name: this.local.name,
          note: opts.deckName,
          roomName: opts.roomName,
          password: opts.password ?? '',
          code: reuseCode,
        },
        {
          onCode: (code) => {
            this.code = code;
            this.emitCode(code);
          },
          onGuest: () => this.setStatus('connecting'),
          onStatus: (_text, phase) => this.setStatus(phase),
          onPeer: (peer) => {
            this.hostHandle = null;
            this.pendingReject = null;
            this.attach(peer);
            resolve({ code: this.code ?? '' });
          },
          onError: (error) => {
            this.hostHandle = null;
            this.pendingReject = null;
            this.setStatus('failed');
            reject(error);
          },
        },
      );
    });
  }

  private startJoin(code: string, name: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingReject = reject;
      this.code = code;
      this.emitCode(code);
      this.setStatus('signaling');
      this.joinCancel = this.mm().join(code, name, password, {
        onStatus: (_text, phase) => this.setStatus(phase),
        onPeer: (peer) => {
          this.joinCancel = null;
          this.pendingReject = null;
          this.attach(peer);
          resolve();
        },
        onError: (error) => {
          this.joinCancel = null;
          this.pendingReject = null;
          this.setStatus('failed');
          reject(error);
        },
      }, ROOM_CODE_LENGTH);
    });
  }

  /** Puts a manual-code peer on hold until it opens (the same channel wiring as the room flow). */
  private adoptPending(peer: PvpPeer): void {
    this.teardown();
    this.pendingPeer = peer;
    peer.onState = (state, reason) => {
      if (state === 'open') {
        this.pendingPeer = null;
        this.attach(peer);
        this.manualDone?.resolve();
      } else if (state === 'closed' && this.pendingPeer === peer) {
        this.pendingPeer = null;
        this.setStatus('failed');
        this.manualDone?.reject(new PvpError('network', `Conexão recusada (${reason ?? 'fechou'}).`));
      }
    };
  }

  /** Makes `peer` the live connection: hello, resend of unacknowledged commands, and inbound routing. */
  private attach(peer: PvpPeer): void {
    this.peer = peer;
    this.remoteHello = null;
    peer.onMessage = (msg) => this.onWire(msg);
    peer.onState = (state, reason) => {
      if (peer !== this.peer || state !== 'closed') return;
      this.peer = null;
      this.setStatus('disconnected');
      diag('X', reason ?? 'fechou');
    };
    this.setStatus('connected');
    peer.send({ t: 'hello', name: this.local.name, deckName: this.local.deckName, protocol: PROTOCOL_VERSION });
    // Resend-on-reconnect: whatever the other side has not acknowledged goes out again, in order.
    for (const envelope of this.outbound.unacked()) peer.send(envelope);
  }

  private onWire(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          const peer = this.peer;
          this.peer = null;
          peer?.close();
          this.setStatus('failed');
          this.pendingReject?.(new PvpError('protocol', 'Os dois aparelhos estão com versões diferentes do app. Atualize os dois.'));
          this.pendingReject = null;
          return;
        }
        this.remoteHello = { name: msg.name, deckName: msg.deckName };
        for (const fn of [...this.helloListeners]) fn(this.remoteHello);
        return;
      }
      case 'cmd': {
        const result = this.inbound.accept(msg.seq, msg.cmd);
        this.peer?.send({ t: 'ack', seq: result.ack });
        for (const d of result.deliver) this.emitMessage({ t: 'cmd', seq: d.seq, cmd: d.cmd });
        return;
      }
      case 'ack':
        this.outbound.ack(msg.seq);
        return;
      default:
        this.emitMessage(msg);
    }
  }

  private emitMessage(msg: NetMessage): void {
    for (const fn of [...this.messageListeners]) fn(msg);
  }

  private emitCode(code: string | null): void {
    for (const fn of [...this.codeListeners]) fn(code);
  }

  private setStatus(status: PvpStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const fn of [...this.statusListeners]) fn(status);
  }

  /** Stops the current connection and any pending attempt without forgetting queues or the last session. */
  private teardown(): void {
    this.hostHandle?.cancel();
    this.hostHandle = null;
    this.joinCancel?.();
    this.joinCancel = null;
    const live = this.peer;
    this.peer = null;
    live?.close();
    const pending = this.pendingPeer;
    this.pendingPeer = null;
    pending?.close();
    this.remoteHello = null;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingReject = null;
      reject(new PvpError('cancelled', 'Conexão cancelada.'));
    }
    if (this.manualDone) {
      this.manualDone.reject(new PvpError('cancelled', 'Conexão cancelada.'));
      this.manualDone = null;
    }
    if (this.code !== null) {
      this.code = null;
      this.emitCode(null);
    }
  }
}
