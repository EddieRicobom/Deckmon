import { decodeCode, encodeCode } from './codec';
import { PVP_CONFIG } from './config';
import { diag } from './diag';
import { decodeNetMessage, encodeNetMessage, MAX_FRAME_CHARS } from './protocol';
import type { NetMessage } from './protocol';

/**
 * The direct connection between two devices (WebRTC data channel). There is no app server: pairing exchanges two text
 * codes (the offer and the answer), and after that messages go device to device. STUN only helps each device learn its
 * public address; a TURN relay (optional, `PVP_CONFIG.turn`) covers networks where the direct path fails.
 */

export function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: [...PVP_CONFIG.stunUrls] }];
  const turn = PVP_CONFIG.turn;
  if (turn && turn.urls.length > 0) servers.push({ urls: [...turn.urls], username: turn.username, credential: turn.credential });
  return servers;
}

/** Whether a TURN relay is configured (the UI explains network failures differently when it is). */
export const HAS_TURN = PVP_CONFIG.turn !== null && PVP_CONFIG.turn.urls.length > 0;

/** Wait for local candidates before building the code (the code carries them all; there is no later trickle). */
const GATHER_TIMEOUT_MS = 4500;
const PING_EVERY_MS = 3500;
const SILENCE_LIMIT_MS = 13000;

/** The browser finished gathering addresses and found none: there is nothing to connect to. */
export class NoCandidatesError extends Error {
  constructor() {
    super('sem candidatos de rede');
  }
}

export const NO_CANDIDATES_MESSAGE =
  'Este navegador não gerou nenhum endereço de rede para a conexão (WebRTC bloqueado). Desligue VPN, modo privado ou extensões de privacidade e tente no Chrome ou no Safari atualizados.';

/** Number of network candidates in an SDP. */
export function countCandidates(sdp: string): number {
  return (sdp.match(/^a=candidate:/gm) ?? []).length;
}

export type PeerState = 'new' | 'connecting' | 'open' | 'closed';
export type CloseReason = 'local' | 'remote' | 'timeout' | 'failed';

export interface PeerOptions {
  iceServers?: RTCIceServer[];
}

export class PvpPeer {
  state: PeerState = 'new';
  onState: ((state: PeerState, reason?: CloseReason) => void) | null = null;
  onMessage: ((msg: NetMessage) => void) | null = null;
  /** Frames that were ignored because they did not match the protocol. */
  ignored = 0;
  /** Round trip to the other device in ms (from ping/pong). */
  rtt = 150;

  private readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private pingSentAt = 0;

  private constructor(options: PeerOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers ?? buildIceServers() });
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.finish('failed');
      else if (s === 'closed') this.finish('remote');
    };
    this.pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (c) diag('K', `${c.type ?? '?'}/${c.protocol ?? '?'}${c.address?.endsWith('.local') ? '/m' : ''}`);
    };
    this.pc.onicecandidateerror = (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      diag('KE', `${ev.errorCode} ${(ev.url ?? '').slice(0, 24)}`);
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      diag(`I:${s}`);
      if (s === 'connected' || s === 'completed') void this.logPath();
    };
  }

  /** Records the selected candidate pair, e.g. `P:host-srflx` (local host, remote srflx). */
  private async logPath(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let pairId = '';
      stats.forEach((r: { type?: string; selectedCandidatePairId?: string }) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
      stats.forEach((r: { type?: string; id?: string; nominated?: boolean; state?: string }) => {
        if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.nominated && r.state === 'succeeded'))) {
          pair = r as typeof pair;
        }
      });
      if (!pair) return;
      const type = (id?: string) => (stats.get(id ?? '') as { candidateType?: string } | undefined)?.candidateType ?? '?';
      diag(`P:${type(pair.localCandidateId)}-${type(pair.remoteCandidateId)}`);
    } catch {
      /* browser without full getStats */
    }
  }

  /** Host: creates the offer code. Show it to the guest, then call `acceptAnswer` with the answer code they return. */
  static async host(options: PeerOptions = {}): Promise<{ peer: PvpPeer; code: string }> {
    const peer = new PvpPeer(options);
    peer.attach(peer.pc.createDataChannel('dcg', { ordered: true }));
    peer.setState('connecting');
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await peer.gathered();
      return { peer, code: await encodeCode('offer', peer.pc.localDescription!.sdp) };
    } catch (e) {
      peer.close();
      throw e;
    }
  }

  /** Guest: reads the offer and produces the answer code. The connection opens by itself after the host accepts it. */
  static async join(
    offerCode: string,
    options: PeerOptions = {},
  ): Promise<{ ok: true; peer: PvpPeer; code: string } | { ok: false; message: string }> {
    const decoded = await decodeCode(offerCode, 'offer');
    if (decoded.ok === false) return decoded;
    const peer = new PvpPeer(options);
    peer.setState('connecting');
    peer.pc.ondatachannel = (e) => peer.attach(e.channel);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: decoded.sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await peer.gathered();
    } catch (e) {
      peer.close();
      if (e instanceof NoCandidatesError) return { ok: false, message: NO_CANDIDATES_MESSAGE };
      return { ok: false, message: 'Não consegui ler esse convite. Peça um código novo ao anfitrião.' };
    }
    return { ok: true, peer, code: await encodeCode('answer', peer.pc.localDescription!.sdp) };
  }

  /** Host: applies the guest's answer code. Returns null on success, or the problem to show. */
  async acceptAnswer(answerCode: string): Promise<string | null> {
    const decoded = await decodeCode(answerCode, 'answer');
    if (decoded.ok === false) return decoded.message;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: decoded.sdp });
      return null;
    } catch {
      return 'Esse código de resposta não é deste convite. Gere um convite novo ou peça a resposta de novo.';
    }
  }

  send(msg: NetMessage): boolean {
    if (this.channel?.readyState !== 'open') return false;
    this.channel.send(encodeNetMessage(msg));
    return true;
  }

  close(): void {
    if (this.state === 'closed') return;
    this.finish('local');
  }

  private gathered(): Promise<void> {
    const started = Date.now();
    const report = () => {
      const sdp = this.pc.localDescription?.sdp ?? '';
      diag(`C ${countCandidates(sdp)}`, `${Date.now() - started}ms`);
      // No address at all: the other device has nowhere to connect to, so fail now instead of waiting 30 s.
      if (countCandidates(sdp) === 0) throw new NoCandidatesError();
    };
    if (this.pc.iceGatheringState === 'complete') {
      try {
        report();
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timeout);
        this.pc.removeEventListener('icegatheringstatechange', check);
        try {
          report();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };
      const timeout = setTimeout(done, GATHER_TIMEOUT_MS);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => {
      this.lastHeard = Date.now();
      this.setState('open');
      const ping = () => {
        this.pingSentAt = performance.now();
        this.send({ t: 'ping' });
      };
      this.timer = setInterval(() => {
        if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) return this.finish('timeout');
        ping();
      }, PING_EVERY_MS);
      ping();
    };
    channel.onclose = () => this.finish('remote');
    channel.onmessage = (e) => {
      this.lastHeard = Date.now();
      const raw = typeof e.data === 'string' && e.data.length <= MAX_FRAME_CHARS ? e.data : null;
      const msg = raw === null ? null : decodeNetMessage(raw);
      if (!msg) {
        this.ignored++;
        return;
      }
      if (msg.t === 'ping') {
        this.send({ t: 'pong' });
        return;
      }
      if (msg.t === 'pong') {
        if (this.pingSentAt > 0) {
          const sample = performance.now() - this.pingSentAt;
          this.pingSentAt = 0;
          if (sample >= 0 && sample < 5000) this.rtt = this.rtt === 150 ? sample : this.rtt * 0.6 + sample * 0.4;
        }
        return;
      }
      this.onMessage?.(msg);
    };
  }

  private setState(state: PeerState, reason?: CloseReason): void {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state, reason);
  }

  private finish(reason: CloseReason): void {
    if (this.state === 'closed') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setState('closed', reason);
    try {
      this.channel?.close();
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
