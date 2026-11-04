/**
 * Rules view of a card. Pure: the UI (or a test) registers the card list once, the core reads it by card id.
 * Built from the raw DigimonCards.json shape so the core does not depend on Angular models.
 */

export type CardKind = 'digimon' | 'tamer' | 'option' | 'egg' | 'other';

export interface DigivolveRule {
  /** A colour of the digivolution source (the card you digivolve from). */
  color: string;
  /** Level of the source that the rule accepts. */
  level: number;
  /** Memory cost. */
  cost: number;
}

export interface CardInfo {
  id: string;
  name: string;
  kind: CardKind;
  /** Lv number from cardLv ("Lv.4" -> 4). Null when the card has no level. */
  level: number | null;
  colors: string[];
  dp: number;
  playCost: number;
  digivolve: DigivolveRule[];
  /** Options: every listed colour must be present on your side. Empty = no requirement. */
  optionColors: string[];
  /** Main effect text. Timing tags such as [On Play] live here. */
  effect: string;
  /** Inherited effect text: keywords here apply to the stack while this card is under the top card. */
  digivolveEffect: string;
  /** Text of the [Security] effect (tamer and option security cards). */
  securityEffect: string;
}

/** The fields of a raw DigimonCards.json record that the rules read. Everything is checked when parsed. */
export interface Raw {
  id?: unknown;
  cardNumber?: unknown;
  cardType?: unknown;
  cardLv?: unknown;
  color?: unknown;
  dp?: unknown;
  playCost?: unknown;
  name?: unknown;
  effect?: unknown;
  digivolveEffect?: unknown;
  securityEffect?: unknown;
  digivolveCondition?: unknown;
  optionCardColourRequirement?: unknown;
}

const DASH = '-';

function text(v: unknown): string {
  return typeof v === 'string' && v !== DASH ? v : '';
}

function int(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function colorList(v: unknown): string[] {
  const s = text(v);
  return s
    .split('/')
    .map((c) => c.trim())
    .filter((c) => /^[A-Za-z]+$/.test(c));
}

function kindOf(cardType: unknown): CardKind {
  const t = String(cardType ?? '');
  if (t === 'Digi-Egg') return 'egg';
  if (t.startsWith('Digimon')) return 'digimon';
  if (t === 'Tamer') return 'tamer';
  if (t === 'Option') return 'option';
  return 'other';
}

/** Parses one raw card record. Missing or "-" fields become empty values. */
export function parseCardInfo(raw: Raw): CardInfo {
  const name = raw.name as { english?: string } | undefined;
  const lvMatch = /Lv\.(\d+)/.exec(String(raw.cardLv ?? ''));
  const digivolve = Array.isArray(raw.digivolveCondition)
    ? (raw.digivolveCondition as Array<{ color?: unknown; level?: unknown; cost?: unknown }>)
        .map((c) => ({ color: String(c.color ?? ''), level: int(c.level), cost: int(c.cost) }))
        .filter((c) => c.color && c.level > 0)
    : [];
  return {
    id: String(raw.id ?? raw.cardNumber ?? ''),
    name: name?.english && name.english !== DASH ? name.english : String(raw.id ?? ''),
    kind: kindOf(raw.cardType),
    level: lvMatch ? int(lvMatch[1]) : null,
    colors: colorList(raw.color),
    dp: int(raw.dp),
    playCost: int(raw.playCost),
    digivolve,
    optionColors: colorList(raw.optionCardColourRequirement),
    effect: text(raw.effect),
    digivolveEffect: text(raw.digivolveEffect),
    securityEffect: text(raw.securityEffect),
  };
}

type Source = (cardId: string) => CardInfo | undefined;

let source: Source | null = null;

/** Registers the card lookup. Pass null to clear it (rules then treat every card as unknown). */
export function setCardInfoSource(fn: Source | null): void {
  source = fn;
}

/** Looks up a card's rules data. Undefined when unknown or no source is registered. */
export function cardInfo(cardId: string): CardInfo | undefined {
  if (!source || !cardId || cardId === '?') return undefined;
  return source(cardId);
}

/** Builds a lookup from raw card records and registers it. Returns the number of cards registered. */
export function registerCardRecords(records: readonly Raw[]): number {
  const map = new Map<string, CardInfo>();
  for (const raw of records) {
    const info = parseCardInfo(raw);
    if (info.id && !map.has(info.id)) map.set(info.id, info);
  }
  setCardInfoSource((id) => map.get(id));
  return map.size;
}
