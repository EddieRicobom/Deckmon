/**
 * Wire messages between the two peers, plus the sequencing used for the game commands.
 *
 * Commands (`cmd`) are numbered 1, 2, 3… by the sender. The receiver delivers them strictly in order, drops duplicates
 * and holds early arrivals for a bounded window. Acks are cumulative. Unacked commands stay in the outbound queue and
 * are resent in order whenever a new data channel opens, so a reconnect loses nothing and repeats nothing.
 */

export const PROTOCOL_VERSION = 1;

export type NetMessage =
  | { t: 'hello'; name: string; deckName: string; protocol: number }
  | { t: 'cmd'; seq: number; cmd: unknown }
  | { t: 'ack'; seq: number }
  | { t: 'state-hash'; seq: number; hash: string }
  | { t: 'chat'; text: string }
  | { t: 'reveal'; uids: string[]; cardIds: string[] }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'resign' };

/** Hard limits for anything that arrives from the other device (it is never trusted). */
export const MAX_FRAME_CHARS = 32 * 1024;
export const MAX_CMD_CHARS = 16 * 1024;
const MAX_NAME = 40;
const MAX_TEXT = 500;
const MAX_LIST = 200;
const MAX_ID = 64;
const MAX_HASH = 128;

/** Commands the sender may have in flight before it refuses to queue more. */
export const MAX_PENDING = 512;
/** Commands that may arrive early (ahead of a gap) before the receiver refuses them. */
export const MAX_HELD = 256;

export function encodeNetMessage(msg: NetMessage): string {
  return JSON.stringify(msg);
}

/** Parses and validates one frame from the wire. Returns null for anything malformed or out of limits. */
export function decodeNetMessage(raw: string): NetMessage | null {
  if (raw.length > MAX_FRAME_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  switch (o['t']) {
    case 'hello': {
      const name = str(o['name'], MAX_NAME);
      const deckName = str(o['deckName'], MAX_NAME);
      const protocol = uint(o['protocol']);
      if (name === null || deckName === null || protocol === null) return null;
      return { t: 'hello', name, deckName, protocol };
    }
    case 'cmd': {
      const seq = uint(o['seq']);
      if (seq === null || seq < 1 || !('cmd' in o)) return null;
      if (JSON.stringify(o['cmd']).length > MAX_CMD_CHARS) return null;
      return { t: 'cmd', seq, cmd: o['cmd'] };
    }
    case 'ack': {
      const seq = uint(o['seq']);
      return seq === null ? null : { t: 'ack', seq };
    }
    case 'state-hash': {
      const seq = uint(o['seq']);
      const hash = str(o['hash'], MAX_HASH);
      return seq === null || hash === null ? null : { t: 'state-hash', seq, hash };
    }
    case 'chat': {
      const text = str(o['text'], MAX_TEXT);
      return text === null ? null : { t: 'chat', text };
    }
    case 'reveal': {
      const uids = strList(o['uids'], MAX_LIST, MAX_ID);
      const cardIds = strList(o['cardIds'], MAX_LIST, MAX_ID);
      return uids === null || cardIds === null ? null : { t: 'reveal', uids, cardIds };
    }
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'resign':
      return { t: 'resign' };
    default:
      return null;
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function uint(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function strList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = str(item, maxLength);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

export interface CmdEnvelope {
  t: 'cmd';
  seq: number;
  cmd: unknown;
}

/** Sender side: numbers each command and keeps the ones not yet acknowledged. */
export class OutboundQueue {
  private next = 1;
  private pending: CmdEnvelope[] = [];

  /** Queues a command and returns its envelope, or null when too many commands are unacknowledged. */
  push(cmd: unknown): CmdEnvelope | null {
    if (this.pending.length >= MAX_PENDING) return null;
    const envelope: CmdEnvelope = { t: 'cmd', seq: this.next, cmd };
    this.next++;
    this.pending.push(envelope);
    return envelope;
  }

  /** Cumulative ack: everything up to and including `seq` was delivered. */
  ack(seq: number): void {
    this.pending = this.pending.filter((e) => e.seq > seq);
  }

  /** Everything still unacknowledged, in order. Send these again when a new channel opens. */
  unacked(): CmdEnvelope[] {
    return this.pending.slice();
  }

  get size(): number {
    return this.pending.length;
  }
}

export interface Delivery {
  seq: number;
  cmd: unknown;
}

export interface AcceptResult {
  /** Commands now ready to hand to the game, in order. */
  deliver: Delivery[];
  /** Cumulative ack to send back (highest seq received in order). */
  ack: number;
}

/** Receiver side: in-order delivery, duplicate suppression, and a bounded window for early arrivals. */
export class InboundQueue {
  private expected = 1;
  private held = new Map<number, unknown>();

  constructor(private readonly maxHeld = MAX_HELD) {}

  accept(seq: number, cmd: unknown): AcceptResult {
    const ackNow = this.expected - 1;
    if (!Number.isSafeInteger(seq) || seq < 1) return { deliver: [], ack: ackNow };
    if (seq < this.expected) return { deliver: [], ack: ackNow };
    if (seq > this.expected) {
      if (seq - this.expected <= this.maxHeld && !this.held.has(seq)) this.held.set(seq, cmd);
      return { deliver: [], ack: ackNow };
    }
    const deliver: Delivery[] = [{ seq, cmd }];
    this.expected++;
    for (;;) {
      const next = this.held.get(this.expected);
      if (next === undefined && !this.held.has(this.expected)) break;
      this.held.delete(this.expected);
      deliver.push({ seq: this.expected, cmd: next });
      this.expected++;
    }
    return { deliver, ack: this.expected - 1 };
  }
}
