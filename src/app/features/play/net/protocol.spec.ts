import { decodeNetMessage, encodeNetMessage, InboundQueue, MAX_HELD, MAX_PENDING, OutboundQueue } from './protocol';
import type { CmdEnvelope } from './protocol';

describe('InboundQueue (in-order delivery and dedupe)', () => {
  it('delivers in order and acks cumulatively', () => {
    const q = new InboundQueue();
    expect(q.accept(1, 'a')).toEqual({ deliver: [{ seq: 1, cmd: 'a' }], ack: 1 });
    expect(q.accept(2, 'b')).toEqual({ deliver: [{ seq: 2, cmd: 'b' }], ack: 2 });
  });

  it('holds an early command until the gap is filled, then releases the run', () => {
    const q = new InboundQueue();
    expect(q.accept(3, 'c')).toEqual({ deliver: [], ack: 0 });
    expect(q.accept(2, 'b')).toEqual({ deliver: [], ack: 0 });
    expect(q.accept(1, 'a')).toEqual({ deliver: [1, 2, 3].map((seq) => ({ seq, cmd: ['a', 'b', 'c'][seq - 1] })), ack: 3 });
  });

  it('drops duplicates, both delivered and held', () => {
    const q = new InboundQueue();
    q.accept(1, 'a');
    expect(q.accept(1, 'a')).toEqual({ deliver: [], ack: 1 });
    q.accept(3, 'c');
    expect(q.accept(3, 'c-again')).toEqual({ deliver: [], ack: 1 });
    const out = q.accept(2, 'b');
    expect(out.deliver.map((d) => d.cmd)).toEqual(['b', 'c']);
    expect(out.ack).toBe(3);
  });

  it('refuses commands beyond the window and ignores invalid sequence numbers', () => {
    const q = new InboundQueue();
    expect(q.accept(MAX_HELD + 5, 'far')).toEqual({ deliver: [], ack: 0 });
    expect(q.accept(0, 'zero').deliver).toEqual([]);
    expect(q.accept(-1, 'neg').deliver).toEqual([]);
    expect(q.accept(1.5, 'frac').deliver).toEqual([]);
  });
});

describe('OutboundQueue (numbering, acks, resend)', () => {
  it('numbers commands from 1 and removes them on cumulative ack', () => {
    const q = new OutboundQueue();
    const seqs = ['x', 'y', 'z'].map((cmd) => q.push(cmd)!.seq);
    expect(seqs).toEqual([1, 2, 3]);
    q.ack(2);
    expect(q.unacked().map((e) => e.seq)).toEqual([3]);
  });

  it('refuses to queue past the pending limit', () => {
    const q = new OutboundQueue();
    for (let i = 0; i < MAX_PENDING; i++) expect(q.push(i)).not.toBeNull();
    expect(q.push('overflow')).toBeNull();
  });
});

describe('sequencing over a lossy, reconnecting channel', () => {
  it('delivers every command exactly once and in order after drops and a resend on reconnect', () => {
    const out = new OutboundQueue();
    const inbound = new InboundQueue();
    const delivered: unknown[] = [];
    let lastAck = 0;

    const receive = (env: CmdEnvelope) => {
      const result = inbound.accept(env.seq, env.cmd);
      for (const d of result.deliver) delivered.push(d.cmd);
      lastAck = result.ack;
    };

    // Commands 1..4 are sent, but 2 is lost on the link and the channel breaks before 5 and 6 are sent.
    for (let i = 1; i <= 4; i++) {
      const env = out.push(`cmd${i}`)!;
      if (i !== 2) receive(env);
    }
    expect(delivered).toEqual(['cmd1']);
    expect(lastAck).toBe(1);

    // Reconnect: the sender resends everything unacked (2..4); the receiver then delivers 2, 3, 4 in order.
    out.ack(lastAck);
    for (const env of out.unacked()) receive(env);
    expect(delivered).toEqual(['cmd1', 'cmd2', 'cmd3', 'cmd4']);

    // Play continues on the new channel.
    for (let i = 5; i <= 6; i++) receive(out.push(`cmd${i}`)!);
    expect(delivered).toEqual(['cmd1', 'cmd2', 'cmd3', 'cmd4', 'cmd5', 'cmd6']);

    // A second resend of already-delivered commands changes nothing (duplicates are dropped).
    for (let seq = 1; seq <= 6; seq++) receive({ t: 'cmd', seq, cmd: `cmd${seq}` });
    expect(delivered).toHaveLength(6);
  });
});

describe('decodeNetMessage (untrusted input)', () => {
  it('round-trips every message kind', () => {
    const samples: unknown[] = [
      { t: 'hello', name: 'Ana', deckName: 'Gaia', protocol: 1 },
      { t: 'cmd', seq: 4, cmd: { type: 'play', card: 'BT1-084' } },
      { t: 'ack', seq: 4 },
      { t: 'state-hash', seq: 4, hash: 'ab12' },
      { t: 'chat', text: 'oi' },
      { t: 'reveal', uids: ['u1'], cardIds: ['BT1-084'] },
      { t: 'ping' },
      { t: 'pong' },
      { t: 'resign' },
    ];
    for (const s of samples) expect(decodeNetMessage(encodeNetMessage(s as never))).toEqual(s);
  });

  it('rejects malformed frames, bad types and oversized fields', () => {
    expect(decodeNetMessage('not json')).toBeNull();
    expect(decodeNetMessage('[]')).toBeNull();
    expect(decodeNetMessage('{"t":"nope"}')).toBeNull();
    expect(decodeNetMessage('{"t":"cmd","seq":0,"cmd":1}')).toBeNull();
    expect(decodeNetMessage('{"t":"cmd","seq":1}')).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ t: 'chat', text: 'x'.repeat(501) }))).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ t: 'hello', name: 1, deckName: 'a', protocol: 1 }))).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ t: 'cmd', seq: 1, cmd: 'y'.repeat(20000) }))).toBeNull();
  });
});

describe('setup message rules mode', () => {
  it('keeps the host rules mode and treats anything else as absent', () => {
    const board = { id: 0, name: 'Host' };
    const assisted = decodeNetMessage(JSON.stringify({ t: 'setup', board, mode: 'assisted' }));
    expect(assisted).toEqual({ t: 'setup', board, mode: 'assisted' });
    const manual = decodeNetMessage(JSON.stringify({ t: 'setup', board, mode: 'manual' }));
    expect(manual).toEqual({ t: 'setup', board, mode: 'manual' });
    const odd = decodeNetMessage(JSON.stringify({ t: 'setup', board, mode: 'godmode' }));
    expect(odd).toEqual({ t: 'setup', board });
  });
});
