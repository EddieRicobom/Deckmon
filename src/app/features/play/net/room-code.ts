/**
 * Short room codes. The alphabet leaves out the glyphs that are easy to confuse when read aloud or typed
 * (0/O, 1/I), so 4 characters from 32 symbols gives about one million codes.
 */

export const ROOM_CODE_LENGTH = 4;

/** 32 symbols, no 0, O, 1 or I. Length 32 keeps `byte % 32` unbiased. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length: number = ROOM_CODE_LENGTH): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

/**
 * Cleans what a person typed: upper case, only letters and digits, and the look-alike glyphs dropped.
 * The result may still be invalid; check it with `isRoomCode`.
 */
export function normalizeRoomCode(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OI01]/g, '');
}

export function isRoomCode(code: string, length: number = ROOM_CODE_LENGTH): boolean {
  return code.length === length && [...code].every((c) => ROOM_ALPHABET.includes(c));
}
