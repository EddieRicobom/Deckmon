/**
 * Human-readable card names for log lines. The core stays pure: the UI registers a resolver once (from the card
 * store), and both peers use the same card data, so log text matches on both sides. Falls back to the card id.
 */
import { HIDDEN_CARD_ID } from './view';

type NameResolver = (cardId: string) => string | undefined;

let resolver: NameResolver | null = null;

export function setCardNameResolver(fn: NameResolver | null): void {
  resolver = fn;
}

/** Name for a card id in log text. Hidden cards read as "a hidden card". */
export function cardLabel(cardId: string): string {
  if (!cardId || cardId === HIDDEN_CARD_ID) return 'a hidden card';
  return resolver?.(cardId) || cardId;
}
