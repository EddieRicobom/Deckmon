import { PVP_CONFIG } from './config';
import { diag } from './diag';
import { PvpError } from './errors';
import { isRoomCode, generateRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from './room-code';
import type { RoomSecrets } from './secret';
import { deriveRoomSecrets, openFrame, sealFrame } from './secret';
import { NO_CANDIDATES_MESSAGE, NoCandidatesError, PvpPeer, HAS_TURN } from './peer';
import type { CloseReason, PeerState } from './peer';
import { randomId, SignalHub } from './signal';

/**
 * Pairing without a server. The host opens a room with a short code (4 characters) and, if listed, the room shows in a
 * public lobby. A guest taps the room or types the code. Everything on the room topic is sealed with a key derived from
 * the code and an optional password (`secret.ts`), and the topic itself is derived from them too. The lobby is public
 * and carries only what a listing needs.
 *
 * Lobby topic: `<prefix>lobby` (room ads every 3 s, gone after 9 s without an ad).
 * Room topic: `<prefix>room/<hash>` (encrypted `here`, `join`, `offer`, `answer`, `busy`, `closed` frames).
 *
 * Anything that arrives is untrusted: shapes and sizes are checked before use.
 */

type Data = Record<string, unknown>;

/** Fields of a signaling frame. All optional and untyped until checked where they are used. */
interface Frame {
  r?: unknown;
  t?: unknown;
  hid?: unknown;
  code?: unknown;
  name?: unknown;
  room?: unknown;
  note?: unknown;
  pw?: unknown;
  gid?: unknown;
  offer?: unknown;
  answer?: unknown;
  c?: unknown;
}

export interface OpenRoom {
  code: string;
  /** Name of the host (shown in the list). */
  name: string;
  /** Room name chosen by the host. */
  roomName: string;
  /** Short text from the host (for example the deck name). */
  note: string;
  hasPassword: boolean;
  createdAt: number;
  /** When the last ad arrived (ms). */
  seenAt: number;
}

export interface MatchPeer {
  state: PeerState;
  onState: ((state: PeerState, reason?: CloseReason) => void) | null;
  acceptAnswer(code: string): Promise<string | null>;
  close(): void;
}

export interface PeerApi<P extends MatchPeer> {
  host(): Promise<{ peer: P; code: string }>;
  join(offerCode: string): Promise<{ ok: true; peer: P; code: string } | { ok: false; message: string }>;
}

const realApi: PeerApi<PvpPeer> = {
  host: () => PvpPeer.host(),
  join: (code) => PvpPeer.join(code),
};

export interface MatchTimings {
  announceMs: number;
  joinRetryMs: number;
  joinTries: number;
  claimMs: number;
  connectMs: number;
  roomTtlMs: number;
}

export const MATCH_TIMINGS: MatchTimings = {
  announceMs: 3000,
  joinRetryMs: 2000,
  joinTries: 7,
  claimMs: 25000,
  connectMs: 30000,
  roomTtlMs: 9000,
};

export type MatchPhase = 'signaling' | 'connecting';

export interface HostOptions {
  /** Shown in the public list. Unlisted rooms are joined by code only. */
  listed: boolean;
  name: string;
  /** Short host text (deck name). */
  note?: string;
  roomName: string;
  /** Empty string means no password. */
  password: string;
  /** Reuse a code (for a reconnect). */
  code?: string;
}

export interface HostHandlers<P> {
  onCode(code: string): void;
  onGuest?(name: string): void;
  onStatus?(text: string, phase: MatchPhase): void;
  onPeer(peer: P): void;
  onError(error: PvpError): void;
}

export interface JoinHandlers<P> {
  onStatus(text: string, phase: MatchPhase): void;
  onPeer(peer: P): void;
  onError(error: PvpError): void;
}

export interface HostHandle {
  cancel(): void;
  code(): string;
}

const MAX_OFFER = 20000;
const MAX_ROOMS = 20;
const NETWORK_PROBLEM = HAS_TURN
  ? 'Não conectou. A rede de um dos dois bloqueou a conexão. Tente de novo, ou os dois na mesma rede Wi-Fi.'
  : 'Não conectou: as redes de vocês não deixaram os celulares se ligarem direto (comum no 4G). Tentem os dois na mesma rede Wi-Fi.';
const WEBRTC_PROBLEM = 'Este navegador não conseguiu criar a conexão (WebRTC). Tente no Chrome ou no Safari atualizados.';
const CRYPTO_PROBLEM = 'Este navegador não consegue preparar a sala segura (WebCrypto). Atualize o navegador.';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** A name from a stranger: no control or direction characters, single spaces, short. */
export function cleanName(value: unknown, max = 24): string {
  return text(value, 80)
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Room name chosen by the host, up to 32 characters. */
export function cleanRoomName(value: unknown): string {
  return cleanName(value, 32);
}

const ROOM_CODE = /^[A-Z2-9]{4,6}$/;

export class Matchmaker<P extends MatchPeer = PvpPeer> {
  constructor(
    private readonly hub: SignalHub,
    private readonly api: PeerApi<P> = realApi as unknown as PeerApi<P>,
    private readonly timings: MatchTimings = MATCH_TIMINGS,
  ) {}

  private get lobbyTopic(): string {
    return `${PVP_CONFIG.topicPrefix}lobby`;
  }

  /** Open rooms in real time. Returns the function that stops listening. */
  watchRooms(onRooms: (rooms: OpenRoom[]) => void): () => void {
    const rooms = new Map<string, OpenRoom & { hid: string }>();
    const emit = () => {
      const now = Date.now();
      for (const [code, room] of rooms) if (now - room.seenAt > this.timings.roomTtlMs) rooms.delete(code);
      // Ordered by when the room appeared, not by the last ad, so the list does not jump under a tap.
      onRooms(
        [...rooms.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ hid: _hid, ...room }) => room),
      );
    };
    const off = this.hub.subscribe(this.lobbyTopic, (m: Frame) => {
      if (m.r !== 'h') return;
      const code = text(m.code, 8);
      const hid = text(m.hid, 24);
      if (!ROOM_CODE.test(code) || !hid) return;
      const known = rooms.get(code);
      if (m.t === 'closed') {
        if (known?.hid !== hid) return;
        rooms.delete(code);
      } else if (m.t === 'open') {
        if (!known && rooms.size >= MAX_ROOMS) return;
        const now = Date.now();
        rooms.set(code, {
          code,
          hid,
          name: cleanName(m.name) || 'Treinador',
          roomName: cleanRoomName(m.room) || 'Sala',
          note: cleanName(m.note),
          hasPassword: m.pw === true,
          createdAt: known?.createdAt ?? now,
          seenAt: now,
        });
      } else return;
      emit();
    });
    // Ask the rooms already open to announce again, instead of waiting for the next cycle. The first ask often goes out
    // before any broker is up, so it is repeated when the first broker connects.
    const ask = () => this.hub.publish(this.lobbyTopic, { r: 'g', t: 'who' });
    ask();
    const offOnline = this.hub.whenOnline(ask);
    const timer = setInterval(emit, 1500);
    return () => {
      off();
      offOnline();
      clearInterval(timer);
    };
  }

  /** Opens a room. The connection prepares itself; `onPeer` fires when a guest has joined and the channel is open. */
  host(options: HostOptions, handlers: HostHandlers<P>): HostHandle {
    const hid = randomId(10);
    const length = ROOM_CODE_LENGTH;
    let code = options.code && isRoomCode(options.code, length) ? options.code : generateRoomCode(length);
    let alive = true;
    let generation = 0;
    let secrets: RoomSecrets | null = null;
    let ready: { peer: P; offer: string } | null = null;
    let claimed: string | null = null;
    let claimTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let announceTimer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let preparing = false;
    let answerApplied = false;
    let offWho: (() => void) | null = null;

    const send = (data: Data) => {
      const current = secrets;
      if (!current) return;
      const at = code;
      void sealFrame(current.key, at, { r: 'h', hid, ...data }).then((sealed) => {
        if (alive) this.hub.publish(current.topic, { c: sealed });
      });
    };
    const announce = () => {
      if (!secrets) return;
      send({ t: 'here' });
      if (options.listed && !claimed) {
        this.hub.publish(this.lobbyTopic, {
          r: 'h',
          t: 'open',
          hid,
          code,
          name: options.name,
          note: options.note ?? '',
          room: options.roomName,
          pw: options.password.length > 0,
        });
      }
    };
    const waiting = () => handlers.onStatus?.('Aguardando um amigo entrar…', 'signaling');
    const clearClaim = () => {
      claimed = null;
      answerApplied = false;
      if (claimTimer) clearTimeout(claimTimer);
      if (connectTimer) clearTimeout(connectTimer);
      claimTimer = null;
      connectTimer = null;
    };
    const unlistLobby = () => {
      if (options.listed) this.hub.publish(this.lobbyTopic, { r: 'h', t: 'closed', hid, code });
    };

    const onRoomMessage = (m: Frame) => {
      if (!alive) return;
      if (m.r === 'h') {
        // Another host with the same code (rare): the one with the larger hid moves to a new code, so the two never
        // swap at once.
        if (typeof m.hid === 'string' && m.hid !== hid && m.hid > hid && !claimed && m.t === 'here') {
          unlistLobby();
          const next = generateRoomCode(length);
          diag('HC', next);
          void start(next);
        }
        return;
      }
      const gid = text(m.gid, 24);
      if (!gid) return;
      if (m.t === 'join') {
        if (claimed && claimed !== gid) return send({ t: 'busy', gid });
        if (!ready) return;
        if (!claimed) {
          claimed = gid;
          const guest = cleanName(m.name) || 'Amigo';
          diag('H3', guest);
          handlers.onGuest?.(guest);
          unlistLobby();
          claimTimer = setTimeout(() => {
            if (!alive || !claimed) return;
            // The guest vanished: the room goes back to the list with the same offer.
            diag('H9', 'convidado sumiu');
            clearClaim();
            waiting();
            announce();
          }, this.timings.claimMs);
        }
        send({ t: 'offer', gid, offer: ready.offer });
        diag('H4');
      } else if (m.t === 'answer' && claimed === gid && ready) {
        const answer = text(m.answer, MAX_OFFER);
        // The answer arrives more than once (the guest repeats it for safety): only the first counts.
        if (!answer || answerApplied) return;
        answerApplied = true;
        diag('H5', `${answer.length}c`);
        handlers.onStatus?.('Resposta do amigo recebida. Abrindo a conexão direta…', 'connecting');
        const current = ready;
        if (claimTimer) clearTimeout(claimTimer);
        claimTimer = null;
        void current.peer.acceptAnswer(answer).then((problem) => {
          if (!alive || ready !== current) return;
          if (problem) {
            diag('H7', problem.slice(0, 30));
            clearClaim();
            waiting();
            announce();
            return;
          }
          diag('H6');
          connectTimer ??= setTimeout(() => {
            if (!alive || ready !== current || current.peer.state === 'open') return;
            // The direct connection did not open (the guest's network): drop it and prepare a new offer.
            diag('H9', 'tempo');
            handlers.onStatus?.(`${NETWORK_PROBLEM} A sala continua aberta.`, 'signaling');
            current.peer.onState = null;
            current.peer.close();
            ready = null;
            clearClaim();
            void prepare();
          }, this.timings.connectMs);
        });
      }
    };

    const start = async (next: string) => {
      code = next;
      const run = ++generation;
      unsubscribe?.();
      unsubscribe = null;
      secrets = null;
      try {
        const derived = await deriveRoomSecrets(next, options.password);
        if (!alive || run !== generation) return;
        secrets = derived;
        unsubscribe = this.hub.subscribe(derived.topic, (d: Frame) => {
          const sealed = d.c;
          if (typeof sealed !== 'string') return;
          void openFrame(derived.key, next, sealed).then((m) => {
            if (m && alive && run === generation) onRoomMessage(m);
          });
        });
        handlers.onCode?.(next);
        announce();
      } catch {
        diag('HX', 'cripto');
        handlers.onError(new PvpError('other', CRYPTO_PROBLEM));
        stop(true);
      }
    };

    const prepare = async () => {
      if (preparing || !alive) return;
      preparing = true;
      try {
        const made = await this.api.host();
        if (!alive) {
          made.peer.close();
          return;
        }
        const record = { peer: made.peer, offer: made.code };
        ready = record;
        diag('H2', `${made.code.length}c`);
        made.peer.onState = (state, reason) => {
          if (!alive || ready !== record) return;
          if (state === 'open') {
            diag('H8');
            made.peer.onState = null;
            stop(false);
            handlers.onPeer(made.peer);
          } else if (state === 'closed') {
            // The connection failed (network): say so and prepare a new offer while the room stays open.
            diag('H9', reason ?? 'fechou');
            if (claimed) handlers.onStatus?.(`${NETWORK_PROBLEM} A sala continua aberta.`, 'signaling');
            ready = null;
            clearClaim();
            void prepare();
          }
        };
        announce();
      } catch (e) {
        const noCandidates = e instanceof NoCandidatesError;
        diag('HX', noCandidates ? 'sem-candidatos' : 'erro');
        handlers.onError(
          noCandidates ? new PvpError('no-candidates', NO_CANDIDATES_MESSAGE) : new PvpError('webrtc', WEBRTC_PROBLEM),
        );
        stop(true);
      } finally {
        preparing = false;
      }
    };

    const stop = (closePeer: boolean) => {
      if (!alive) return;
      alive = false;
      generation++;
      if (announceTimer) clearInterval(announceTimer);
      offWho?.();
      offWho = null;
      clearClaim();
      unlistLobby();
      unsubscribe?.();
      unsubscribe = null;
      if (closePeer && ready) {
        ready.peer.onState = null;
        ready.peer.close();
      }
      ready = null;
    };

    handlers.onCode(code);
    waiting();
    diag('H1', code);
    void start(code);
    announceTimer = setInterval(() => announce(), this.timings.announceMs);
    // Someone opening the list asks for the ads: answer at once.
    offWho = options.listed
      ? this.hub.subscribe(this.lobbyTopic, (m: Frame) => {
          if (m.r === 'g' && m.t === 'who' && alive && !claimed) announce();
        })
      : null;
    void prepare();
    return {
      code: () => code,
      cancel: () => stop(true),
    };
  }

  /**
   * Joins the room `rawCode`. A wrong password never sees the room topic, so it gets no offer: after the retries it
   * fails with `wrong-password` (or `not-found` when no password was given). Returns the function that cancels.
   */
  join(rawCode: string, name: string, password: string, handlers: JoinHandlers<P>, codeLength = ROOM_CODE_LENGTH): () => void {
    const code = normalizeRoomCode(rawCode);
    if (!isRoomCode(code, codeLength)) {
      handlers.onError(new PvpError('invalid-code', `O código da sala tem ${codeLength} letras ou números. Confira com o seu amigo.`));
      return () => undefined;
    }
    const gid = randomId(12);
    let alive = true;
    let tries = 0;
    let joinTimer: ReturnType<typeof setInterval> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let answered = false;
    let peer: P | null = null;
    let unsubscribe: (() => void) | null = null;
    let secrets: RoomSecrets | null = null;

    const finish = () => {
      alive = false;
      if (joinTimer) clearInterval(joinTimer);
      if (connectTimer) clearTimeout(connectTimer);
      unsubscribe?.();
      unsubscribe = null;
    };
    const fail = (error: PvpError) => {
      if (!alive) return;
      finish();
      if (peer) {
        peer.onState = null;
        peer.close();
        peer = null;
      }
      handlers.onError(error);
    };
    const send = (data: Data) => {
      const current = secrets;
      if (!current) return;
      void sealFrame(current.key, code, { r: 'g', gid, ...data }).then((sealed) => {
        if (alive) this.hub.publish(current.topic, { c: sealed });
      });
    };
    const knock = () => {
      if (!alive || answered || !secrets) return;
      // With no broker up, the attempt does not count: the failure would be the network, not the code.
      if (this.hub.online === 0) return handlers.onStatus('Sem ponto de encontro no momento. Tentando de novo…', 'signaling');
      if (tries >= this.timings.joinTries) {
        diag('G8', code);
        return fail(
          password
            ? new PvpError('wrong-password', 'Senha errada ou sala não encontrada. Confira a senha com o anfitrião.')
            : new PvpError('not-found', `Não achei a sala ${code}. Confira o código e se o anfitrião continua com a tela aberta.`),
        );
      }
      tries++;
      send({ t: 'join', name });
    };
    const onMessage = (m: Frame) => {
      if (!alive || m.r !== 'h' || text(m.gid, 24) !== gid) return;
      if (m.t === 'busy') {
        diag('G7');
        return fail(new PvpError('room-busy', 'Essa sala já está com outro jogador. Peça para o anfitrião abrir outra, ou espere um instante.'));
      }
      if (m.t !== 'offer' || answered) return;
      const offer = text(m.offer, MAX_OFFER);
      if (!offer) return;
      answered = true;
      if (joinTimer) clearInterval(joinTimer);
      joinTimer = null;
      diag('G2', `${offer.length}c`);
      handlers.onStatus('Sala encontrada. Preparando a resposta…', 'connecting');
      void this.api
        .join(offer)
        .then((made) => {
          if (!alive) {
            if (made.ok === true) made.peer.close();
            return;
          }
          if (made.ok === false) return fail(new PvpError('other', made.message));
          diag('G3', `${made.code.length}c`);
          peer = made.peer;
          made.peer.onState = (state, reason) => {
            if (!alive) return;
            if (state === 'open') {
              diag('G5');
              made.peer.onState = null;
              peer = null;
              finish();
              handlers.onPeer(made.peer);
            } else if (state === 'closed') {
              diag('G6', reason ?? 'fechou');
              fail(
                reason === 'failed'
                  ? new PvpError('network', NETWORK_PROBLEM)
                  : new PvpError('network', 'A conexão caiu antes de começar. Tente entrar de novo.'),
              );
            }
          };
          // The answer goes out a few times: a broker can lose one, and the host drops the repeats.
          const sendAnswer = () => {
            if (alive) send({ t: 'answer', gid, answer: made.code });
          };
          sendAnswer();
          diag('G4');
          handlers.onStatus('Resposta enviada. Abrindo a conexão direta com o anfitrião…', 'connecting');
          setTimeout(sendAnswer, 1200);
          setTimeout(sendAnswer, 3000);
          connectTimer = setTimeout(() => {
            diag('G9');
            fail(new PvpError('network', NETWORK_PROBLEM));
          }, this.timings.connectMs);
        })
        .catch(() => fail(new PvpError('webrtc', WEBRTC_PROBLEM)));
    };

    void (async () => {
      let derived: RoomSecrets;
      try {
        derived = await deriveRoomSecrets(code, password);
      } catch {
        return fail(new PvpError('other', CRYPTO_PROBLEM));
      }
      if (!alive) return;
      secrets = derived;
      unsubscribe = this.hub.subscribe(derived.topic, (d: Frame) => {
        const sealed = d.c;
        if (typeof sealed !== 'string') return;
        void openFrame(derived.key, code, sealed).then((m) => {
          if (m) onMessage(m);
        });
      });
      handlers.onStatus(`Procurando a sala ${code}…`, 'signaling');
      diag('G1', code);
      knock();
      joinTimer = setInterval(knock, this.timings.joinRetryMs);
    })();

    return () => {
      if (!alive) return;
      finish();
      if (peer) {
        peer.onState = null;
        peer.close();
        peer = null;
      }
    };
  }
}
