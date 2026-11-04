/**
 * Manual pairing code: the WebRTC offer or answer as text to copy and paste, for when the brokers are unreachable.
 * Main format `DCGc.<base64url>` (about 150 characters, see `sdp-compact.ts`). Fallbacks for SDPs outside the compact
 * shape: `DCGz.<base64url>` (JSON of the full SDP, deflate-raw) and `DCGj.<base64url>` (plain JSON). Whitespace in a
 * pasted code is ignored.
 */
import { buildSdp, compactSdp, unpackSdp } from './sdp-compact';
import type { SdpKind } from './sdp-compact';

export type CodeKind = SdpKind;

const PREFIX = 'DCG';
const VERSION = 1;
const MAX_CODE_LENGTH = 20000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A broken code fails on the reader side; here we only avoid an unhandled rejection.
  void writer
    .write(bytes as unknown as BufferSource)
    .then(() => writer.close())
    .catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const canCompress = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function encodeCode(kind: CodeKind, sdp: string): Promise<string> {
  const compact = compactSdp(sdp, kind);
  if (compact) return `${PREFIX}c.${toBase64Url(compact)}`;
  const json = new TextEncoder().encode(JSON.stringify({ v: VERSION, k: kind, s: sdp }));
  if (canCompress()) return `${PREFIX}z.${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  return `${PREFIX}j.${toBase64Url(json)}`;
}

export type DecodeResult = { ok: true; sdp: string } | { ok: false; message: string };

/** Reads a pasted code. `expect` stops an offer from being pasted where an answer belongs, and the other way round. */
export async function decodeCode(text: string, expect: CodeKind): Promise<DecodeResult> {
  const code = text.replace(/\s+/g, '');
  if (code.length === 0) return { ok: false, message: 'Cole o código primeiro.' };
  if (code.length > MAX_CODE_LENGTH) return { ok: false, message: 'Esse texto é grande demais para ser um código de partida.' };
  const match = /^DCG([zjc])\.([A-Za-z0-9_-]+)$/.exec(code);
  if (!match) return { ok: false, message: 'Esse texto não parece um código de partida. Copie o código inteiro, começando por DCG.' };
  const wrongKind = () => ({
    ok: false as const,
    message:
      expect === 'offer'
        ? 'Esse é um código de resposta. Aqui vai o código de convite do anfitrião.'
        : 'Esse é um código de convite. Aqui vai o código de resposta do amigo.',
  });
  const damaged = { ok: false as const, message: 'O código está incompleto ou foi alterado. Copie de novo, inteiro.' };
  if (match[1] === 'c') {
    try {
      const unpacked = unpackSdp(fromBase64Url(match[2]!));
      if (unpacked.ok === false) {
        return unpacked.reason === 'version'
          ? { ok: false, message: 'Código de outra versão do app. Atualize os dois aparelhos.' }
          : damaged;
      }
      if (unpacked.parts.kind !== expect) return wrongKind();
      return { ok: true, sdp: buildSdp(unpacked.parts) };
    } catch {
      return damaged;
    }
  }
  try {
    let bytes = fromBase64Url(match[2]!);
    if (match[1] === 'z') {
      if (!canCompress()) return { ok: false, message: 'Este navegador não consegue abrir este código. Atualize o navegador.' };
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    }
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown; k?: unknown; s?: unknown };
    if (data.v !== VERSION || typeof data.s !== 'string' || data.s.length === 0) {
      return { ok: false, message: 'Código de outra versão do app. Atualize os dois aparelhos.' };
    }
    if (data.k !== expect) return wrongKind();
    return { ok: true, sdp: data.s };
  } catch {
    return damaged;
  }
}
