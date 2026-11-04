import { generateRoomCode, isRoomCode, normalizeRoomCode, ROOM_ALPHABET } from './room-code';

describe('room codes', () => {
  it('generates 4 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(4);
      expect(isRoomCode(code)).toBe(true);
      expect([...code].every((c) => ROOM_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('never uses the look-alike glyphs 0, O, 1 or I', () => {
    expect(ROOM_ALPHABET).toHaveLength(32);
    for (const bad of ['0', 'O', '1', 'I']) expect(ROOM_ALPHABET).not.toContain(bad);
    for (let i = 0; i < 500; i++) expect(generateRoomCode()).not.toMatch(/[0O1I]/);
  });

  it('produces mostly distinct codes', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(1900);
  });

  it('normalizes typed input: case, spaces, dashes and look-alikes', () => {
    expect(normalizeRoomCode(' ab-c 0o1i ')).toBe('ABC');
    expect(normalizeRoomCode('k7 m9')).toBe('K7M9');
    expect(isRoomCode(normalizeRoomCode('k7 m9'))).toBe(true);
  });

  it('rejects wrong length and foreign characters', () => {
    expect(isRoomCode('ABC')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
    expect(isRoomCode('ABC0')).toBe(false);
    expect(isRoomCode('ABCO')).toBe(false);
  });
});
