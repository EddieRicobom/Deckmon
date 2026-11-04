/**
 * Seeded deterministic PRNG (mulberry32). The state is a single uint32 that lives in GameState,
 * so the same seed plus the same command list always produces the same game.
 */

export interface RngResult<T> {
  value: T;
  rngState: number;
}

/** Returns a float in [0, 1) and the next state. */
export function nextRandom(rngState: number): RngResult<number> {
  let s = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rngState: s >>> 0 };
}

/** Fisher-Yates shuffle that returns a new array and the advanced PRNG state. */
export function shuffle<T>(items: readonly T[], rngState: number): RngResult<T[]> {
  const out = [...items];
  let state = rngState;
  for (let i = out.length - 1; i > 0; i--) {
    const r = nextRandom(state);
    state = r.rngState;
    const j = Math.floor(r.value * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return { value: out, rngState: state };
}

/** Normalises any number (for example Date.now()) to a usable uint32 seed. */
export function normaliseSeed(seed: number): number {
  return Math.floor(Math.abs(seed)) >>> 0 || 1;
}
