import { buildSdp, compactSdp, parseSdp, unpackSdp } from './sdp-compact';

const fingerprint = Array.from({ length: 32 }, (_, i) => ((i * 37) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

/** A realistic data-channel-only offer, shaped like the one browsers produce. */
function offerSdp(extra: string[] = []): string {
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 192.168.1.20 rport 54321 generation 0 network-cost 999',
    'a=candidate:1 1 udp 2113937151 192.168.1.20 54321 typ host generation 0 network-cost 999',
    'a=candidate:2 1 udp 2113929471 a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.local 60000 typ host generation 0',
    ...extra,
    'a=ice-ufrag:Ab3d',
    'a=ice-pwd:Qw8rT2mK9pXz4LnV7cBd1eFg',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    'a=end-of-candidates',
    '',
  ].join('\r\n');
}

describe('compact SDP', () => {
  it('round-trips an offer: pack, unpack, rebuild, parse again', () => {
    const sdp = offerSdp();
    const packed = compactSdp(sdp, 'offer');
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThan(200);

    const unpacked = unpackSdp(packed!);
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.parts.kind).toBe('offer');
    expect(unpacked.parts.ufrag).toBe('Ab3d');
    expect(unpacked.parts.pwd).toBe('Qw8rT2mK9pXz4LnV7cBd1eFg');
    expect(unpacked.parts.candidates.map((c) => `${c.type}/${c.addr}:${c.port}`)).toEqual([
      'host/v4:54321',
      'host/mdns:60000',
      'srflx/v4:54321',
    ]);

    const rebuilt = buildSdp(unpacked.parts);
    expect(rebuilt).toContain('a=ice-ufrag:Ab3d');
    expect(rebuilt).toContain('203.0.113.7 54321 typ srflx');
    expect(rebuilt).toContain('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.local 60000 typ host');
    expect(rebuilt).toContain(`a=fingerprint:sha-256 ${fingerprint}`);

    // The rebuilt SDP is itself compactable to the same bytes: nothing is lost in the cycle.
    const again = parseSdp(rebuilt, 'offer');
    expect(again).not.toBeNull();
    expect(compactSdp(rebuilt, 'offer')).toEqual(packed);
  });

  it('keeps the kind of an answer and rejects a kind mismatch', () => {
    const answer = offerSdp().replace('a=setup:actpass', 'a=setup:active');
    const packed = compactSdp(answer, 'answer')!;
    const unpacked = unpackSdp(packed);
    expect(unpacked.ok && unpacked.parts.kind).toBe('answer');
    expect(parseSdp(answer, 'offer')).toBeNull();
  });

  it('returns null for SDPs it cannot rebuild exactly (TCP candidate, other SCTP port)', () => {
    expect(compactSdp(offerSdp(['a=candidate:9 1 tcp 1518280447 203.0.113.7 9 typ host tcptype active generation 0']), 'offer')).toBeNull();
    expect(compactSdp(offerSdp().replace('a=sctp-port:5000', 'a=sctp-port:5001'), 'offer')).toBeNull();
  });

  it('detects corruption with the CRC', () => {
    const packed = compactSdp(offerSdp(), 'offer')!;
    const broken = packed.slice();
    broken[10] ^= 0xff;
    const result = unpackSdp(broken);
    expect(result.ok).toBe(false);
  });
});
