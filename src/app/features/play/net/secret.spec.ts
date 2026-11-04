// Node's WebCrypto: jsdom under jest exposes no subtle crypto.

if (!globalThis.crypto?.subtle)
  Object.defineProperty(globalThis, 'crypto', { value: (require('crypto') as { webcrypto: Crypto }).webcrypto, configurable: true });

import { deriveRoomSecrets, openFrame, sealFrame } from './secret';

describe('room password protection', () => {
  it('round-trips a sealed frame with the same password and room', async () => {
    const secrets = await deriveRoomSecrets('K7M9', 'gaia-2026');
    const sealed = await sealFrame(secrets.key, 'K7M9', { r: 'h', t: 'offer', offer: 'DCGc.abc' });
    expect(sealed).not.toContain('offer');
    await expect(openFrame(secrets.key, 'K7M9', sealed)).resolves.toEqual({ r: 'h', t: 'offer', offer: 'DCGc.abc' });
  });

  it('fails to open with a wrong password (different key and topic)', async () => {
    const host = await deriveRoomSecrets('K7M9', 'gaia-2026');
    const guest = await deriveRoomSecrets('K7M9', 'wrong-guess');
    expect(guest.topic).not.toBe(host.topic);
    const sealed = await sealFrame(host.key, 'K7M9', { r: 'h', t: 'here' });
    await expect(openFrame(guest.key, 'K7M9', sealed)).resolves.toBeNull();
  });

  it('fails to open a frame replayed into another room (room code is bound as AAD)', async () => {
    const secrets = await deriveRoomSecrets('K7M9', 'gaia-2026');
    const sealed = await sealFrame(secrets.key, 'K7M9', { r: 'g', t: 'join' });
    await expect(openFrame(secrets.key, 'QXBH', sealed)).resolves.toBeNull();
  });

  it('returns null for garbage, truncated or tampered input', async () => {
    const secrets = await deriveRoomSecrets('K7M9', '');
    expect(await openFrame(secrets.key, 'K7M9', '%%%')).toBeNull();
    expect(await openFrame(secrets.key, 'K7M9', 'AAAA')).toBeNull();
    const sealed = await sealFrame(secrets.key, 'K7M9', { r: 'h' });
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-3);
    expect(await openFrame(secrets.key, 'K7M9', tampered)).toBeNull();
  });

  it('gives the same topic for the same code and password, and a hashed topic without the code', async () => {
    const a = await deriveRoomSecrets('K7M9', 'pw');
    const b = await deriveRoomSecrets('K7M9', 'pw');
    expect(a.topic).toBe(b.topic);
    expect(a.topic).not.toContain('K7M9');
  });
});
