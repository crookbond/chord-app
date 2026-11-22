/**
 * A category with many action cards shows the first few and stacks the rest
 * behind one "N more" card; a tap opens the stack. In kernel because mobile
 * has no test harness (ADR 0120/0121).
 */

/** Cards shown before the rest are stacked. */
export const CARD_STACK_SHOWN = 5;

export interface CardStack<T> {
  shown: T[];
  /** Cards behind the stack; empty when everything is shown. */
  stacked: T[];
}

/**
 * Split `items` into what is shown and what is stacked. An open stack shows
 * everything. By default one card over the limit is shown rather than
 * stacked (a stack hiding a single card costs the same tap as the card);
 * `minStacked` 1 stacks even one, for a stack that means "the rest of this
 * email" rather than "too many cards".
 */
export function cardStack<T>(
  items: T[],
  open: boolean,
  limit = CARD_STACK_SHOWN,
  minStacked = 2,
): CardStack<T> {
  if (open || items.length - limit < minStacked) return { shown: items, stacked: [] };
  return { shown: items.slice(0, limit), stacked: items.slice(limit) };
}
