/**
 * Short diagnostic trail of the pairing and connection steps. Each step is a short code plus a detail, for example
 * `H3 Ana` or `I:connected`. It stays in memory only; nothing is stored on the device or sent anywhere.
 *
 * Host: H1 room created · H2 offer ready · H3 guest knocked · H4 offer sent · H5 answer received · H6 answer accepted ·
 * H7 answer rejected · H8 channel open · H9 connection did not close (new offer) · HC room code changed · HX error.
 * Guest: G1 looking for room · G2 offer received · G3 answer ready · G4 answer sent · G5 channel open · G6 dropped ·
 * G7 room busy · G8 room not found · G9 connection timeout.
 * Network: B<n> brokers online · C <candidates> gathered · I:<state> ICE state · P:<local>-<remote> selected path.
 */

export interface DiagEntry {
  code: string;
  atMs: number;
  detail?: string;
}

const MAX_ENTRIES = 60;
let entries: DiagEntry[] = [];
let startedAt = 0;

export function resetDiagnostics(): void {
  entries = [];
  startedAt = Date.now();
}

export function diag(code: string, detail?: string): void {
  if (startedAt === 0) startedAt = Date.now();
  entries.push({ code, atMs: Date.now() - startedAt, detail: detail?.slice(0, 40) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function diagnostics(): readonly DiagEntry[] {
  return entries;
}

/** The whole trail in one line, ready to paste into a chat when debugging a failed pairing. */
export function diagnosticsLine(): string {
  return ['PVP1', ...entries.map((e) => (e.detail ? `${e.code} ${e.detail}` : e.code))].join(' ');
}
