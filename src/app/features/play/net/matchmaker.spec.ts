// Node's WebCrypto: jsdom under jest exposes no subtle crypto.

if (!globalThis.crypto?.subtle)
  Object.defineProperty(globalThis, 'crypto', { value: (require('crypto') as { webcrypto: Crypto }).webcrypto, configurable: true });

import { Matchmaker } from './matchmaker';
import type { MatchPeer, MatchTimings, PeerApi } from './matchmaker';
import { PvpError } from './errors';
import type { SignalHub } from './signal';
import type { PeerState } from './peer';

/** In-memory stand-in for the broker hub: publish delivers to every subscriber of the topic, asynchronously. */
class MemoryHub {
  online = 1;
  private readonly subs = new Map<string, Set<(d: Record<string, unknown>) => void>>();

  subscribe(topic: string, fn: (d: Record<string, unknown>) => void): () => void {
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  publish(topic: string, data: Record<string, unknown>): void {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const fn of [...set]) setTimeout(() => fn(JSON.parse(JSON.stringify(data))), 0);
  }

  whenOnline(): () => void {
    return () => undefined;
  }

  close(): void {
    this.subs.clear();
  }
}

class FakePeer implements MatchPeer {
  state: PeerState = 'connecting';
  onState: ((state: PeerState) => void) | null = null;
  async acceptAnswer(): Promise<string | null> {
    return null;
  }
  close(): void {
    this.state = 'closed';
  }
}

/** Peers that never open: the test only checks the pairing up to the offer. */
const neverOpenApi: PeerApi<FakePeer> = {
  host: async () => ({ peer: new FakePeer(), code: 'OFFER-CODE' }),
  join: () => new Promise(() => undefined),
};

const fastTimings: MatchTimings = {
  announceMs: 50,
  joinRetryMs: 20,
  joinTries: 3,
  claimMs: 2000,
  connectMs: 2000,
  roomTtlMs: 9000,
};

function makeMatch(hub: MemoryHub) {
  return new Matchmaker<FakePeer>(hub as unknown as SignalHub, neverOpenApi, fastTimings);
}

describe('Matchmaker with a password', () => {
  it('a wrong password never reaches the room and fails with wrong-password', async () => {
    const hub = new MemoryHub();
    const match = makeMatch(hub);
    const host = match.host(
      { listed: true, name: 'Eddie', roomName: 'Mesa do Eddie', password: 'gaia-2026', code: 'K7M9' },
      { onCode: () => undefined, onPeer: () => undefined, onError: () => undefined },
    );

    const error = await new Promise<PvpError>((resolve) => {
      match.join('K7M9', 'Ana', 'gaia-2027', {
        onStatus: () => undefined,
        onPeer: () => undefined,
        onError: resolve,
      });
    });

    expect(error).toBeInstanceOf(PvpError);
    expect(error.code).toBe('wrong-password');
    host.cancel();
  }, 20000);

  it('the right password finds the room and receives the offer', async () => {
    const hub = new MemoryHub();
    const match = makeMatch(hub);
    const guestNames: string[] = [];
    const host = match.host(
      { listed: false, name: 'Eddie', roomName: 'Sala', password: 'gaia-2026', code: 'K7M9' },
      { onCode: () => undefined, onGuest: (n) => guestNames.push(n), onPeer: () => undefined, onError: () => undefined },
    );

    const connecting = await new Promise<string>((resolve) => {
      const cancel = match.join('k7m9', 'Ana', 'gaia-2026', {
        onStatus: (text, phase) => {
          if (phase === 'connecting') {
            cancel();
            resolve(text);
          }
        },
        onPeer: () => undefined,
        onError: () => undefined,
      });
    });

    expect(connecting).toContain('Sala encontrada');
    expect(guestNames).toEqual(['Ana']);
    host.cancel();
  }, 20000);

  it('lists rooms with the room name and hasPassword flag, never the password', async () => {
    const hub = new MemoryHub();
    const match = makeMatch(hub);
    const host = match.host(
      { listed: true, name: 'Eddie', note: 'Gaia', roomName: 'Mesa do Eddie', password: 'gaia-2026', code: 'Q2HX' },
      { onCode: () => undefined, onPeer: () => undefined, onError: () => undefined },
    );
    const rooms = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const stop = match.watchRooms((r) => {
        if (r.length > 0) {
          stop();
          resolve(r as unknown as Array<Record<string, unknown>>);
        }
      });
    });
    expect(rooms[0]).toMatchObject({ code: 'Q2HX', name: 'Eddie', roomName: 'Mesa do Eddie', note: 'Gaia', hasPassword: true });
    expect(JSON.stringify(rooms)).not.toContain('gaia-2026');
    host.cancel();
  }, 20000);
});
