/**
 * Saves the current solo game in localStorage, so a reload or a closed tab can resume it. Storage can be missing,
 * full, blocked or hold junk (private windows, SSR, a changed format), so every access is guarded and a failure only
 * means nothing is saved.
 */
import { GameState, STATE_VERSION } from './types';

const KEY = 'digimon-sim.solo-save.v1';

export interface SavedSoloGame {
  state: GameState;
  savedAt: number;
}

export function saveSoloGame(state: GameState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: Date.now(), state }));
  } catch {
    /* Storage unavailable or full: the game still works, it just is not saved. */
  }
}

export function loadSoloGame(): SavedSoloGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; state?: Partial<GameState> };
    const state = parsed?.state;
    if (parsed?.v !== 1 || !state || state.version !== STATE_VERSION || !Array.isArray(state.players)) return null;
    if (state.players.length !== 2 || !Array.isArray(state.log)) return null;
    return { state: state as GameState, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

export function clearSoloGame(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing to clear when storage is unavailable. */
  }
}
