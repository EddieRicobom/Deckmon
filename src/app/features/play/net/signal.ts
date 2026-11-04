import { PVP_CONFIG } from './config';
import { diag } from './diag';
import { connectPacket, DISCONNECT_PACKET, MqttReader, PING_PACKET, publishPacket, subscribePacket, unsubscribePacket } from './mqtt-lite';

/**
 * Rendezvous over public MQTT brokers (WebSocket). Several brokers are used at once: every publish goes to all of them,
 * every subscription listens on all of them, and copies of the same message are dropped by their id. One broker being
 * up is enough. The hub never sees game data; it only carries lobby ads and encrypted signaling for the WebRTC handshake.
 */

/** What the hub needs from a WebSocket (lets tests use a fake). */
export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

const defaultFactory: SocketFactory = (url) => new WebSocket(url, 'mqtt') as unknown as SocketLike;

export interface SignalOptions {
  brokers?: readonly string[];
  factory?: SocketFactory;
  /** Waits in milliseconds (tests shorten them). */
  retryBaseMs?: number;
  connackTimeoutMs?: number;
  pingMs?: number;
}

export type SignalData = Record<string, unknown>;
type Handler = (data: SignalData) => void;

interface Link {
  url: string;
  socket: SocketLike | null;
  reader: MqttReader;
  ready: boolean;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  connack: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  lastHeard: number;
}

const MAX_SEEN = 400;
const MAX_PAYLOAD_CHARS = 32 * 1024;

export function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export class SignalHub {
  private readonly links: Link[];
  private readonly factory: SocketFactory;
  private readonly retryBaseMs: number;
  private readonly connackTimeoutMs: number;
  private readonly pingMs: number;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly clientId = `deckmon-dcg-${randomId(12)}`;
  private readonly onlineWaiters = new Set<() => void>();
  private nextPacketId = 1;
  private started = false;
  private closed = false;

  constructor(options: SignalOptions = {}) {
    this.factory = options.factory ?? defaultFactory;
    this.retryBaseMs = options.retryBaseMs ?? 1500;
    this.connackTimeoutMs = options.connackTimeoutMs ?? 8000;
    this.pingMs = options.pingMs ?? 25000;
    this.links = (options.brokers ?? PVP_CONFIG.brokers).map((url) => ({
      url,
      socket: null,
      reader: new MqttReader(),
      ready: false,
      failures: 0,
      retry: null,
      connack: null,
      ping: null,
      lastHeard: 0,
    }));
  }

  /** Brokers connected right now (zero means no rendezvous is available). */
  get online(): number {
    return this.links.filter((link) => link.ready).length;
  }

  /** Calls `fn` each time the hub goes from no brokers to at least one. Returns the function that stops the calls. */
  whenOnline(fn: () => void): () => void {
    this.onlineWaiters.add(fn);
    return () => {
      this.onlineWaiters.delete(fn);
    };
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    for (const link of this.links) this.open(link);
  }

  close(): void {
    this.closed = true;
    for (const link of this.links) {
      this.clearTimers(link);
      if (link.retry) clearTimeout(link.retry);
      link.retry = null;
      try {
        if (link.ready) link.socket?.send(DISCONNECT_PACKET);
        link.socket?.close();
      } catch {
        /* already closed */
      }
      link.socket = null;
      link.ready = false;
    }
    this.handlers.clear();
    this.onlineWaiters.clear();
  }

  /** Receives the messages of a topic until the returned function is called. */
  subscribe(topic: string, handler: Handler): () => void {
    this.start();
    let set = this.handlers.get(topic);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    if (first) for (const link of this.links) if (link.ready) this.send(link, subscribePacket(this.packetId(), topic));
    return () => {
      const current = this.handlers.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size > 0) return;
      this.handlers.delete(topic);
      for (const link of this.links) if (link.ready) this.send(link, unsubscribePacket(this.packetId(), topic));
    };
  }

  /** Publishes to every connected broker. Each copy carries a random id so receivers can drop duplicates. */
  publish(topic: string, data: SignalData): void {
    const payload = JSON.stringify({ i: randomId(12), d: data });
    for (const link of this.links) if (link.ready) this.send(link, publishPacket(topic, payload));
  }

  private packetId(): number {
    const id = this.nextPacketId;
    this.nextPacketId = this.nextPacketId >= 0xfffe ? 1 : this.nextPacketId + 1;
    return id;
  }

  private send(link: Link, bytes: Uint8Array): void {
    try {
      link.socket?.send(bytes);
    } catch {
      this.drop(link);
    }
  }

  private clearTimers(link: Link): void {
    if (link.connack) clearTimeout(link.connack);
    if (link.ping) clearInterval(link.ping);
    link.connack = null;
    link.ping = null;
  }

  private open(link: Link): void {
    if (this.closed) return;
    link.reader = new MqttReader();
    let socket: SocketLike;
    try {
      socket = this.factory(link.url);
    } catch {
      this.scheduleRetry(link);
      return;
    }
    link.socket = socket;
    socket.binaryType = 'arraybuffer';
    // The deadline starts when the socket opens: on a network that drops packets it can sit "connecting" forever.
    link.connack = setTimeout(() => this.drop(link), this.connackTimeoutMs);
    socket.onopen = () => {
      if (link.socket !== socket) return;
      socket.send(connectPacket(this.clientId));
    };
    socket.onmessage = (event) => {
      if (link.socket !== socket || !(event.data instanceof ArrayBuffer)) return;
      const packets = link.reader.push(new Uint8Array(event.data));
      if (!packets) return this.drop(link);
      link.lastHeard = Date.now();
      for (const incoming of packets) {
        if (incoming.kind === 'connack') {
          if (!incoming.ok) return this.drop(link);
          if (link.connack) clearTimeout(link.connack);
          link.connack = null;
          link.ready = true;
          link.failures = 0;
          for (const topic of this.handlers.keys()) this.send(link, subscribePacket(this.packetId(), topic));
          link.lastHeard = Date.now();
          link.ping = setInterval(() => {
            // Half-open connection (a phone that froze the page): nothing heard for a long time, so reconnect.
            if (Date.now() - link.lastHeard > this.pingMs * 2 + 5000) return this.drop(link);
            this.send(link, PING_PACKET);
          }, this.pingMs);
          this.onlineChanged();
        } else if (incoming.kind === 'publish' && !incoming.retained) {
          // Retained messages are stale or planted by a stranger: they never count for pairing.
          this.deliver(incoming.topic, incoming.payload);
        }
      }
    };
    socket.onclose = () => {
      if (link.socket === socket) this.drop(link);
    };
    socket.onerror = () => {
      if (link.socket === socket) this.drop(link);
    };
  }

  private onlineChanged(): void {
    const online = this.online;
    diag(`B${online}`);
    if (online === 1) for (const fn of [...this.onlineWaiters]) fn();
  }

  private drop(link: Link): void {
    const wasReady = link.ready;
    const socket = link.socket;
    link.socket = null;
    link.ready = false;
    this.clearTimers(link);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    if (wasReady) this.onlineChanged();
    this.scheduleRetry(link);
  }

  private scheduleRetry(link: Link): void {
    if (this.closed || link.retry) return;
    link.failures++;
    const wait = Math.min(30000, this.retryBaseMs * 2 ** Math.min(link.failures - 1, 5)) * (0.75 + Math.random() * 0.5);
    link.retry = setTimeout(() => {
      link.retry = null;
      this.open(link);
    }, wait);
  }

  private deliver(topic: string, payload: string): void {
    const set = this.handlers.get(topic);
    if (!set || payload.length > MAX_PAYLOAD_CHARS) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(payload);
    } catch {
      return;
    }
    if (!envelope || typeof envelope !== 'object') return;
    const { i, d } = envelope as { i?: unknown; d?: unknown };
    if (typeof i !== 'string' || i.length > 40 || !d || typeof d !== 'object' || Array.isArray(d)) return;
    if (this.seen.has(i)) return;
    this.seen.add(i);
    this.seenOrder.push(i);
    if (this.seenOrder.length > MAX_SEEN) this.seen.delete(this.seenOrder.shift()!);
    for (const handler of [...set]) handler(d as SignalData);
  }
}
