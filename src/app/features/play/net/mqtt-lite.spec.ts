import { connectPacket, MqttReader, publishPacket, subscribePacket, unsubscribePacket, PING_PACKET } from './mqtt-lite';

describe('MQTT 3.1.1 packets', () => {
  it('encodes CONNECT with the MQTT 3.1.1 header', () => {
    const bytes = connectPacket('client-1', 30);
    expect(bytes[0]).toBe(0x10);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('MQTT');
    expect(text).toContain('client-1');
    // Layout: [0] type, [1] remaining length, [2..3] name length, [4..7] "MQTT", [8] level 4,
    // [9] flags (clean session), [10..11] keep-alive seconds.
    expect(bytes[8]).toBe(4);
    expect(bytes[9]).toBe(0x02);
    expect(bytes[10]).toBe(0);
    expect(bytes[11]).toBe(30);
  });

  it('round-trips a PUBLISH through the reader', () => {
    const payload = JSON.stringify({ i: 'abc', d: { r: 'h', t: 'open', code: 'K7M9' } });
    const reader = new MqttReader();
    const out = reader.push(publishPacket('deckmon/v1/dcg/lobby', payload));
    expect(out).toEqual([{ kind: 'publish', topic: 'deckmon/v1/dcg/lobby', payload, retained: false }]);
  });

  it('round-trips a large PUBLISH with a two-byte remaining length', () => {
    const payload = 'x'.repeat(5000);
    const out = new MqttReader().push(publishPacket('t/big', payload));
    expect(out?.[0]).toEqual({ kind: 'publish', topic: 't/big', payload, retained: false });
  });

  it('parses SUBSCRIBE and UNSUBSCRIBE (as seen by a broker)', () => {
    const sub = new MqttReader().push(subscribePacket(7, 'deckmon/v1/dcg/room/abc'));
    expect(sub).toEqual([{ kind: 'subscribe', topic: 'deckmon/v1/dcg/room/abc' }]);
    const unsub = new MqttReader().push(unsubscribePacket(8, 'x/y'));
    expect(unsub).toEqual([{ kind: 'unsubscribe', topic: 'x/y' }]);
  });

  it('reassembles packets split across chunks and several packets in one chunk', () => {
    const a = publishPacket('t/a', 'one');
    const b = publishPacket('t/b', 'two');
    const joined = new Uint8Array([...a, ...b, ...PING_PACKET]);
    const reader = new MqttReader();
    const got: unknown[] = [];
    for (let i = 0; i < joined.length; i++) got.push(...(reader.push(joined.subarray(i, i + 1)) ?? []));
    expect(got).toEqual([
      { kind: 'publish', topic: 't/a', payload: 'one', retained: false },
      { kind: 'publish', topic: 't/b', payload: 'two', retained: false },
      { kind: 'other' },
    ]);
  });

  it('reads CONNACK and flags a refused connection', () => {
    expect(new MqttReader().push(Uint8Array.from([0x20, 0x02, 0x00, 0x00]))).toEqual([{ kind: 'connack', ok: true }]);
    expect(new MqttReader().push(Uint8Array.from([0x20, 0x02, 0x00, 0x05]))).toEqual([{ kind: 'connack', ok: false }]);
  });

  it('rejects an oversized packet instead of buffering it', () => {
    const huge = Uint8Array.from([0x30, 0xff, 0xff, 0xff, 0x7f]);
    expect(new MqttReader().push(huge)).toBeNull();
  });
});
