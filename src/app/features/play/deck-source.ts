import { DigimonCard, ICountCard, IDeck } from '../../../models';
import { DeckListEntry } from './core/game';

const MAIN_DECK_SIZE = 50;
const EGG_DECK_MAX = 5;
const STARTER_COPIES = 4;
const EGG_TYPE = 'Digi-Egg';

/** Converts a saved deck into the core's deck list. Unknown cards are kept as main-deck cards. */
export function toDeckList(entries: readonly ICountCard[], cards: ReadonlyMap<string, DigimonCard>): DeckListEntry[] {
  return entries.filter((e) => e.count > 0).map((e) => ({ id: e.id, count: e.count, cardType: cards.get(e.id)?.cardType }));
}

/** Set code of a card id, e.g. 'ST1-01' -> 'ST1'. */
function setCodeOf(cardId: string): string {
  return cardId.split('-', 1)[0].toUpperCase();
}

/**
 * Builds a 50-card starter-style deck from one randomly chosen starter set (ST*).
 * Lobby-only convenience: it uses Math.random, not the game's seeded PRNG.
 */
export function randomStarterDeck(cards: readonly DigimonCard[]): DeckListEntry[] {
  const starters = cards.filter((c) => /^ST\d+/i.test(c.id) && isPlayableCard(c));
  if (starters.length === 0) return [];

  const sets = new Map<string, DigimonCard[]>();
  for (const card of starters) {
    const code = setCodeOf(card.id);
    sets.set(code, [...(sets.get(code) ?? []), card]);
  }
  // Only sets that can form a real deck: at least one Digi-Egg and enough main-deck cards.
  const codes = [...sets.keys()].filter((code) => {
    const set = sets.get(code) ?? [];
    const uniqueIds = new Set(set.map((c) => c.id));
    const eggs = set.filter((c) => c.cardType === EGG_TYPE).length;
    return eggs > 0 && uniqueIds.size - eggs >= Math.ceil(MAIN_DECK_SIZE / STARTER_COPIES);
  });
  if (codes.length === 0) return [];
  const chosen = sets.get(codes[Math.floor(Math.random() * codes.length)]) ?? [];

  const unique = new Map<string, DigimonCard>();
  for (const c of chosen) unique.set(c.id, c);
  const pool = shuffled([...unique.values()]);

  const eggs = pool.filter((c) => c.cardType === EGG_TYPE);
  const main = pool.filter((c) => c.cardType !== EGG_TYPE);

  const entries: DeckListEntry[] = [];
  let mainTotal = 0;
  for (const card of main) {
    if (mainTotal >= MAIN_DECK_SIZE) break;
    const count = Math.min(STARTER_COPIES, MAIN_DECK_SIZE - mainTotal);
    entries.push({ id: card.id, count, cardType: card.cardType });
    mainTotal += count;
  }
  let eggTotal = 0;
  for (const card of eggs) {
    if (eggTotal >= EGG_DECK_MAX) break;
    const count = Math.min(STARTER_COPIES, EGG_DECK_MAX - eggTotal);
    entries.push({ id: card.id, count, cardType: card.cardType });
    eggTotal += count;
  }
  return entries;
}

const CARD_TYPES = new Set(['Digimon', 'Digi-Egg', 'Tamer', 'Option']);

/** Filters out broken wiki entries (template placeholders, missing type or cost). */
function isPlayableCard(c: DigimonCard): boolean {
  const name = c.name?.english ?? '';
  if (!name || name.includes('{{') || name.includes('[[')) return false;
  if (!CARD_TYPES.has(c.cardType)) return false;
  if (c.cardType === 'Digimon' && !/\d/.test(c.cardLv ?? '')) return false;
  if (c.cardType !== 'Digi-Egg' && !/^\d+$/.test(String(c.playCost ?? '').trim())) return false;
  return true;
}

export function deckLabel(deck: Pick<IDeck, 'title'>): string {
  return deck.title?.trim() || 'Untitled deck';
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
