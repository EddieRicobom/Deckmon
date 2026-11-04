/**
 * Password protection for public rooms. The brokers are public, so nothing on the room topic may be readable or even
 * findable without the password:
 *
 * - The room topic is `<prefix>room/<hex>` where `<hex>` is 128 bits of PBKDF2(password, salt = code). Someone who
 *   does not know the password cannot compute the topic and never sees the traffic.
 * - The AES-GCM key is the next 256 bits of the same PBKDF2 output. Every frame on the room topic is sealed with it,
 *   and the room code is bound as additional data, so a frame cannot be replayed into another room.
 * - A wrong password derives a different key: `openFrame` returns null (GCM authentication fails).
 *
 * The lobby ad is public on purpose: it carries the code, the room name, the host name, the deck name and a
 * `hasPassword` flag, never the password or anything derived from it.
 *
 * PBKDF2 with 100k iterations makes guessing a password from captured traffic slow, but it does not make a weak
 * password safe. Use a real passphrase for private games.
 */
import { PVP_CONFIG } from './config';

export const PBKDF2_ITERATIONS = 100_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RoomSecrets {
  /** Full MQTT topic the room's signaling uses. */
  topic: string;
  key: CryptoKey;
}

export async function deriveRoomSecrets(code: string, password: string): Promise<RoomSecrets> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: encoder.encode(`${PVP_CONFIG.topicPrefix}room/${code}`),
        iterations: PBKDF2_ITERATIONS,
      },
      material,
      512,
    ),
  );
  const topic = `${PVP_CONFIG.topicPrefix}room/${toHex(bits.subarray(0, 16))}`;
  const key = await crypto.subtle.importKey('raw', bits.slice(32, 64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { topic, key };
}

/** Seals one signaling object. `aad` (the room code) binds the frame to its room. */
export async function sealFrame(key: CryptoKey, aad: string, data: Record<string, unknown>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(data))),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return toBase64(out);
}

/** Opens a sealed frame. Returns null for a wrong key, a wrong room, tampering, or anything that is not an object. */
export async function openFrame(key: CryptoKey, aad: string, sealed: string): Promise<Record<string, unknown> | null> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(sealed);
  } catch {
    return null;
  }
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(aad) },
      key,
      bytes.slice(IV_BYTES),
    );
    const data: unknown = JSON.parse(decoder.decode(plain));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
