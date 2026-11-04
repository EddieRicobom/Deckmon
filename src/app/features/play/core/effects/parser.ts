/**
 * Pattern-based parser from English card text to the effect AST (ast.ts). Pure: no state, no card registry.
 *
 * Text model. A card field (effect, digivolveEffect, securityEffect) is a list of lines. A line starting with a
 * timing tag opens a block; untagged lines and bullets that follow continue it ("If you do, ..."). A line that is only
 * static keywords is a static line. A block parses as a whole: if any sentence fails, every line in the block stays
 * unparsed and keeps its reminder. Parsing never throws.
 *
 * Coverage. `parseCardText` reports each line as parsed, static or unparsed. A card is complete when no line is
 * unparsed. Per-card overrides (overrides.ts) replace the parse for cards the templates cannot read.
 */
import type { Action, Cmp, Condition, EffectField, EffectTiming, Filter, Side, Target } from './ast';
import { OVERRIDES } from './overrides';

/** Display tag (as printed) to timing. Keys are lower-case. */
const TIMING_OF_TAG: Record<string, EffectTiming> = {
  'on play': 'onPlay',
  'when digivolving': 'whenDigivolving',
  'when attacking': 'whenAttacking',
  'on deletion': 'onDeletion',
  security: 'security',
  main: 'main',
  'start of your turn': 'startOfYourTurn',
  'end of your turn': 'endOfYourTurn',
  'your turn': 'yourTurn',
  'all turns': 'allTurns',
  "opponent's turn": 'opponentsTurn',
  "end of opponent's turn": 'endOfOpponentsTurn',
};

/** Keywords that need no engine step: their effect is read by the rules layer or only shown. */
const STATIC_KEYWORD = /^(blocker|rush|piercing|jamming|retaliation|reboot|raid|barrier|armor purge|security a\. [+-]\d+)$/i;
const KEYWORD_RUN = /^((?:＜[^＞]+＞\s*)+)$/;

export interface ParsedBlock {
  index: number;
  field: EffectField;
  /** Lower-case display tags of the opening line (timing and "once per turn"). */
  tags: string[];
  timings: EffectTiming[];
  optional: boolean;
  oncePerTurn: boolean;
  /** Null when the block is not fully parsed (reminder only). */
  actions: Action[] | null;
  lines: string[];
}

export interface ParsedLine {
  field: EffectField;
  text: string;
  status: 'parsed' | 'static' | 'unparsed' | 'override';
}

export interface ParsedCard {
  blocks: ParsedBlock[];
  lines: ParsedLine[];
  /** True when every line is parsed, static or overridden. */
  complete: boolean;
  override: boolean;
}

export interface CardTexts {
  effect: string;
  digivolveEffect: string;
  securityEffect: string;
}

// ---------------------------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------------------------

/** Splits on sentence periods, never inside a keyword (＜Security A. +1＞). Periods are dropped. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '＜') depth++;
    else if (ch === '＞') depth = Math.max(0, depth - 1);
    cur += ch;
    if (ch === '.' && depth === 0) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim().replace(/\.$/, '').trim()).filter((s) => s.length > 0);
}

/** "A. Then, B" becomes two clauses. "Then" only splits between clauses. */
function splitThen(sentence: string): string[] {
  return sentence
    .split(/(?:^|\s+)then,?\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Leading [Tag]s of a line, lower-cased, and the rest of the line. */
function splitTags(line: string): { tags: string[]; rest: string } {
  const tags: string[] = [];
  let rest = line.trim();
  let m: RegExpExecArray | null;
  while ((m = /^\[([^\]]+)\]\s*/.exec(rest))) {
    tags.push(m[1].trim().toLowerCase());
    rest = rest.slice(m[0].length);
  }
  return { tags, rest };
}

// ---------------------------------------------------------------------------------------------
// Filters and targets
// ---------------------------------------------------------------------------------------------

const COLORS = 'red|blue|yellow|green|purple|black|white';

function cmpOp(word: string | undefined): Cmp['op'] {
  if (!word) return 'eq';
  if (word === 'less' || word === 'lower') return 'le';
  return 'ge';
}

/**
 * Reads a noun phrase such as "purple level 3 digimon card with 4000 DP or less" into a filter. Returns null when any
 * part is not understood.
 */
export function parseDescriptor(raw: string): Filter | null {
  let s = raw.trim().toLowerCase();
  const f: Filter = {};
  let m: RegExpExecArray | null;
  for (let guard = 0; guard < 8; guard++) {
    if ((m = /^(.*\S) with (\d+) dp or (less|lower|more|higher)$/.exec(s))) {
      f.dp = { op: cmpOp(m[3]), n: +m[2] };
    } else if ((m = /^(.*\S) with a play cost of (\d+)(?: or (less|lower|more|higher))?$/.exec(s))) {
      f.cost = { op: m[3] ? cmpOp(m[3]) : 'eq', n: +m[2] };
    } else if ((m = /^(.*\S) with (?:a )?level (\d+)(?: or (less|lower|more|higher))?$/.exec(s))) {
      f.level = { op: m[3] ? cmpOp(m[3]) : 'eq', n: +m[2] };
    } else if ((m = /^(.*\S) with no digivolution cards$/.exec(s))) {
      f.noDigivolution = true;
    } else if ((m = /^(.*\S) with \[([^\]]+)\] in (?:its|their) name$/.exec(s))) {
      f.nameContains = m[2].toLowerCase();
    } else if ((m = /^(.*\S) in play$/.exec(s))) {
      // "in play" is where battle targets already are.
    } else {
      break;
    }
    s = m[1];
  }
  if ((m = new RegExp(`^(${COLORS}) `).exec(s))) {
    f.color = m[1];
    s = s.slice(m[0].length);
  }
  if ((m = /^level (\d+)(?: or (less|lower|more|higher))? /.exec(s))) {
    f.level = { op: m[2] ? cmpOp(m[2]) : 'eq', n: +m[1] };
    s = s.slice(m[0].length);
  }
  if ((m = /^suspended /.exec(s))) {
    f.suspended = true;
    s = s.slice(m[0].length);
  }
  if ((m = /^(digimon|tamer|option|cards?)( cards?)?$/.exec(s))) {
    if (m[1] === 'digimon' || m[1] === 'tamer' || m[1] === 'option') f.cardType = m[1];
    return f;
  }
  return null;
}

/**
 * Reads a target phrase: "this Digimon", "1 of your Digimon", "up to 2 of your opponent's Digimon with 4000 DP or
 * less", "All of your Digimon", "1 purple Digimon card from your trash". Null when not understood.
 */
export function targetPhrase(raw: string): Target | null {
  const s = raw.trim().toLowerCase();
  if (/^this (digimon|tamer|option|card)$/.test(s)) return { kind: 'self' };
  let body = s;
  let zone: 'battle' | 'trash' = 'battle';
  const tr = / from your trash$/.exec(body);
  if (tr) {
    zone = 'trash';
    body = body.slice(0, tr.index);
  }
  let mode: 'exactly' | 'upTo' | 'all' = 'exactly';
  let n = 1;
  let m: RegExpExecArray | null;
  if ((m = /^up to (\d+) (?:of )?/.exec(body))) {
    mode = 'upTo';
    n = +m[1];
  } else if ((m = /^(\d+|one|a|an) (?:of )?/.exec(body))) {
    n = /^\d+$/.test(m[1]) ? +m[1] : 1;
  } else if ((m = /^(all|any number) of /.exec(body))) {
    mode = m[1] === 'all' ? 'all' : 'upTo';
    n = 99;
  } else {
    return null;
  }
  body = body.slice(m[0].length);
  let side: Side;
  if ((m = /^your opponents?(?:'s)? /.exec(body))) {
    side = 'opponent';
    body = body.slice(m[0].length);
  } else if ((m = /^your /.exec(body))) {
    side = 'own';
    body = body.slice(m[0].length);
  } else if (zone === 'trash') {
    // "1 purple Digimon card from your trash": the trash is always your own.
    side = 'own';
  } else {
    return null;
  }
  if (zone === 'trash' && side === 'opponent') return null;
  const filter = parseDescriptor(body);
  if (!filter) return null;
  return { kind: 'select', side, zone, filter, mode, n };
}

function battleTarget(raw: string): Target | null {
  const t = targetPhrase(raw);
  return t && t.kind === 'select' && t.zone === 'battle' ? t : null;
}

/** A battle target, or "this Digimon" (the card's own stack). */
function battleOrSelf(raw: string): Target | null {
  const t = targetPhrase(raw);
  if (!t) return null;
  if (t.kind === 'self') return t;
  return t.zone === 'battle' ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Conditions and actions
// ---------------------------------------------------------------------------------------------

const CONDITIONS: Array<[RegExp, (m: RegExpExecArray) => Condition]> = [
  [/^if you have (\d+) or more cards in your hand, (.+)$/, (m) => ({ kind: 'handAtLeast', n: +m[1] })],
  [/^if you have (\d+) or fewer cards in your hand, (.+)$/, (m) => ({ kind: 'handAtMost', n: +m[1] })],
  [/^if you have (\d+) or more security cards, (.+)$/, (m) => ({ kind: 'securityAtLeast', n: +m[1] })],
  [/^if you have (\d+) security cards or less, (.+)$/, (m) => ({ kind: 'securityAtMost', n: +m[1] })],
  [new RegExp(`^if you have (?:an? )?(${COLORS}) digimon in play, (.+)$`), (m) => ({ kind: 'colorInPlay', color: m[1] })],
  [/^if your opponent has (?:a|an) digimon with no digivolution cards, (.+)$/, () => ({ kind: 'opponentHasNoDigivolutionDigimon' })],
  [/^if your opponent has (?:a|an) digimon, (.+)$/, () => ({ kind: 'opponentHasDigimon' })],
  [/^if you do, (.+)$/, () => ({ kind: 'ifDone' })],
];

const KEYWORD_CANON: Record<string, string> = {
  blocker: 'Blocker',
  rush: 'Rush',
  piercing: 'Piercing',
  jamming: 'Jamming',
  retaliation: 'Retaliation',
  reboot: 'Reboot',
};

function canonKeyword(k: string): string {
  const sec = /^security a\. ([+-]\d+)$/.exec(k);
  if (sec) return `Security A. ${sec[1]}`;
  return KEYWORD_CANON[k] ?? k;
}

type ActionOut = Action | Action[] | null;
const ACTIONS: Array<[RegExp, (m: RegExpExecArray) => ActionOut]> = [
  [/^＜draw (\d+)＞$/, (m) => ({ type: 'draw', n: +m[1] })],
  [/^＜recovery \+(\d+) \(deck\)＞$/, (m) => ({ type: 'recovery', n: +m[1] })],
  [
    /^＜de-digivolve (\d+)＞ (.+)$/,
    (m) => {
      const target = battleTarget(m[2]);
      return target ? { type: 'deDigivolve', target, n: +m[1] } : null;
    },
  ],
  [/^gain (\d+) memory$/, (m) => ({ type: 'memory', delta: +m[1] })],
  [/^lose (\d+) memory$/, (m) => ({ type: 'memory', delta: -+m[1] })],
  [
    /^(.+?) gets? ([+-]\d+) dp for the turn$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'dp', target, delta: +m[2], duration: 'turn' } : null;
    },
  ],
  [
    /^(.+?) gains? ＜(blocker|rush|piercing|jamming|retaliation|reboot|security a\. [+-]\d+)＞ for the turn$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'keyword', target, keyword: canonKeyword(m[2]), duration: 'turn' } : null;
    },
  ],
  [
    /^(.+?) gets? ([+-]\d+) dp$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'dp', target, delta: +m[2], duration: 'continuous' } : null;
    },
  ],
  [
    /^(.+?) gains? ＜(blocker|rush|piercing|jamming|retaliation|reboot|security a\. [+-]\d+)＞$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'keyword', target, keyword: canonKeyword(m[2]), duration: 'continuous' } : null;
    },
  ],
  [/^play this card without paying the cost$/, () => ({ type: 'playSource' })],
  [
    /^suspend (.+)$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'suspend', target, suspended: true } : null;
    },
  ],
  [
    /^unsuspend (.+)$/,
    (m) => {
      const target = battleOrSelf(m[1]);
      return target ? { type: 'suspend', target, suspended: false } : null;
    },
  ],
  [
    /^delete (.+)$/,
    (m) => {
      const target = battleTarget(m[1]);
      return target ? { type: 'delete', target } : null;
    },
  ],
  [
    /^return (.+?) to (?:its owner's|the|your) hand$/,
    (m) => {
      const target = targetPhrase(m[1]);
      return target && target.kind === 'select' ? { type: 'returnToHand', target } : target?.kind === 'self' ? { type: 'returnToHand', target } : null;
    },
  ],
  [
    /^return (.+?) to the bottom of (?:its owner's|your) deck$/,
    (m) => {
      const target = battleTarget(m[1]);
      return target ? { type: 'returnToDeckBottom', target } : null;
    },
  ],
  [
    /^trash (\d+|one|a|an) cards? in your hand$/,
    (m) => ({
      type: 'trashFromHand',
      target: { kind: 'select', side: 'own', zone: 'hand', filter: {}, mode: 'exactly', n: /^\d+$/.test(m[1]) ? +m[1] : 1 },
    }),
  ],
  [/^trash the top (\d+) cards? of your deck$/, (m) => ({ type: 'trashDeckTop', n: +m[1] })],
  [/^activate this card's \[main\] effects?$/, () => ({ type: 'activateMain' })],
  [/^add this card to (?:its owner's|the|your) hand$/, () => ({ type: 'addSourceToHand' })],
];

const ADD_PICKS = /^add (.+) among them to your hand$/;
const REST_TO_BOTTOM = /^(?:place|return) the (?:remaining|rest)(?: cards)? (?:at|to) the bottom of your deck in any order$/;

function parsePicks(text: string): Array<{ filter: Filter; n: number }> | null {
  const out: Array<{ filter: Filter; n: number }> = [];
  for (const piece of text.split(/ and /)) {
    const m = /^(\d+|one|a|an) (.+)$/.exec(piece.trim());
    if (!m) return null;
    const filter = parseDescriptor(m[2]);
    if (!filter) return null;
    out.push({ filter, n: /^\d+$/.test(m[1]) ? +m[1] : 1 });
  }
  return out.length > 0 ? out : null;
}

/** One clause to actions. A condition prefix is read first, then the action template. */
function parseClause(clause: string): Action[] | null {
  let s = clause;
  let when: Condition | undefined;
  for (const [re, make] of CONDITIONS) {
    const m = re.exec(s);
    if (m) {
      when = make(m);
      s = m[m.length - 1];
      break;
    }
  }
  if (!when && /^(if|when|while|otherwise|after|during|at the|choose|you may)\b/.test(s)) return null;
  for (const [re, make] of ACTIONS) {
    const m = re.exec(s);
    if (!m) continue;
    const out = make(m);
    if (!out) return null;
    const list = Array.isArray(out) ? out : [out];
    return list.map((a) => (when ? ({ ...a, when } as Action) : a));
  }
  return null;
}

/**
 * Parses the sentences of one block. A reveal clause consumes the sentences that follow it (add, then the rest).
 * Returns null when any part is not understood.
 */
export function parseBody(sentences: string[]): { actions: Action[]; optional: boolean } | null {
  const list = sentences.flatMap(splitThen).map((s) => s.trim()).filter((s) => s.length > 0);
  let optional = false;
  const actions: Action[] = [];
  for (let i = 0; i < list.length; i++) {
    let s = list[i].toLowerCase();
    if (i === 0 && s.startsWith('you may ')) {
      optional = true;
      s = s.slice('you may '.length);
    }
    const reveal = /^reveal the top (\d+) cards? of your deck$/.exec(s);
    if (reveal) {
      const add = ADD_PICKS.exec((list[i + 1] ?? '').toLowerCase());
      const rest = REST_TO_BOTTOM.test((list[i + 2] ?? '').toLowerCase());
      const picks = add && rest ? parsePicks(add[1]) : null;
      if (!picks) return null;
      actions.push({ type: 'revealTop', n: +reveal[1], picks });
      i += 2;
      continue;
    }
    const clause = parseClause(s);
    if (!clause) return null;
    actions.push(...clause);
  }
  if (actions.length === 0) return null;
  return { actions, optional };
}

// ---------------------------------------------------------------------------------------------
// Blocks and cards
// ---------------------------------------------------------------------------------------------

interface OpenBlock {
  field: EffectField;
  tags: string[];
  lines: string[];
  sentences: string[];
  start: number;
}

/** A line that is only static keywords (＜Blocker＞ ＜Rush＞). */
function isStaticLine(line: string): boolean {
  if (!KEYWORD_RUN.test(line)) return false;
  // Keyword-only lines are recognised declarations. Only the ones that do something on their own (draw, recovery,
  // de-digivolve) need an effect, so they are not static.
  return [...line.matchAll(/＜([^＞]+)＞/g)].every((m) => !/^(draw|recovery|de-digivolve)\b/i.test(m[1].trim()));
}

function finishBlock(open: OpenBlock, blocks: ParsedBlock[], lines: ParsedLine[]): void {
  const timed = open.tags.filter((t) => t in TIMING_OF_TAG);
  const unknown = open.tags.filter((t) => !(t in TIMING_OF_TAG) && t !== 'once per turn');
  const timings = [...new Set(timed.map((t) => TIMING_OF_TAG[t]))];
  const parsed = timed.length > 0 && unknown.length === 0 ? parseBody(open.sentences) : null;
  const block: ParsedBlock = {
    index: blocks.length,
    field: open.field,
    tags: open.tags,
    timings,
    optional: parsed?.optional ?? false,
    oncePerTurn: open.tags.includes('once per turn'),
    actions: parsed ? parsed.actions : null,
    lines: open.lines,
  };
  blocks.push(block);
  for (const text of open.lines) lines.push({ field: open.field, text, status: parsed ? 'parsed' : 'unparsed' });
}

/** Printed text uses non-breaking spaces and curly apostrophes. The patterns expect plain ones. */
export function normaliseText(text: string): string {
  return text.replace(/ /g, ' ').replace(/[‘’]/g, "'");
}

function parseField(field: EffectField, text: string, blocks: ParsedBlock[], lines: ParsedLine[]): void {
  let open: OpenBlock | null = null;
  const rawLines = normaliseText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '-');
  for (const line of rawLines) {
    if (isStaticLine(line)) {
      if (open) finishBlock(open, blocks, lines);
      open = null;
      lines.push({ field, text: line, status: 'static' });
      continue;
    }
    const bullet = line.startsWith('・');
    const { tags, rest } = splitTags(line);
    if (tags.length > 0 && !bullet) {
      if (open) finishBlock(open, blocks, lines);
      open = { field, tags, lines: [line], sentences: splitSentences(rest), start: blocks.length };
      continue;
    }
    if (open) {
      open.lines.push(line);
      open.sentences.push(...splitSentences(bullet ? line.slice(1) : line));
      continue;
    }
    // Untagged text with no block to continue: reminder only.
    lines.push({ field, text: line, status: 'unparsed' });
  }
  if (open) finishBlock(open, blocks, lines);
}

/** Parses the three text fields of a card. Cards listed in OVERRIDES use their hand-written effects instead. */
export function parseCardText(cardId: string, texts: CardTexts): ParsedCard {
  const override = OVERRIDES[cardId];
  if (override) {
    const lines: ParsedLine[] = [];
    const blocks = override.map((b, index) => ({
      index,
      field: b.field,
      tags: [],
      timings: [b.timing],
      optional: b.optional,
      oncePerTurn: b.oncePerTurn,
      actions: b.actions,
      lines: [b.text],
    }));
    for (const b of override) lines.push({ field: b.field, text: b.text, status: 'override' });
    return { blocks, lines, complete: true, override: true };
  }
  const blocks: ParsedBlock[] = [];
  const lines: ParsedLine[] = [];
  parseField('effect', texts.effect, blocks, lines);
  parseField('digivolveEffect', texts.digivolveEffect, blocks, lines);
  parseField('securityEffect', texts.securityEffect, blocks, lines);
  return { blocks, lines, complete: lines.every((l) => l.status !== 'unparsed'), override: false };
}

const cache = new Map<string, ParsedCard>();

/** Cached parse by card id and text. Safe to call on every trigger. */
export function parsedCard(cardId: string, texts: CardTexts): ParsedCard {
  const key = `${cardId}\u0000${texts.effect}\u0000${texts.digivolveEffect}\u0000${texts.securityEffect}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = parseCardText(cardId, texts);
    if (cache.size > 5000) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

/** Display tag names the engine understands, lower-case. Used by reminders to match a timing. */
export function timingOfTag(tag: string): EffectTiming | undefined {
  return TIMING_OF_TAG[tag.trim().toLowerCase()];
}
