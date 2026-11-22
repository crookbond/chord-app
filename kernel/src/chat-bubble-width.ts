/**
 * A chat message's column is as wide as its text, which is right for a bubble
 * and wrong for a card: on iOS and Android a card's text box (`flex: 1`)
 * inside a column sized by its content gets almost no width, so a card under
 * "yes" or "Done." wrapped one letter per line. A browser sizes the same box
 * to its text, so web never showed it. A column that draws a card or a
 * proposal's buttons therefore takes a fixed share of the screen instead.
 * In kernel because mobile has no test harness (ADR 0120/0121).
 */
import type { BotCard } from './sse';

/** A card the app draws; Telegram-only button cards are not drawn. */
function drawnInApp(card: BotCard): boolean {
  return !(card.kind === 'action' && card.callback && !card.url);
}

export function chatColumnNeedsFixedWidth(input: {
  /** Cards under a visible bot reply. */
  cards?: BotCard[];
  /** Cards in the receipt strip under the user's message. */
  receiptCards?: BotCard[];
  /** Proposals whose ✓/✗ are drawn in this column. */
  proposalCount?: number;
}): boolean {
  if ((input.proposalCount ?? 0) > 0) return true;
  return [...(input.cards ?? []), ...(input.receiptCards ?? [])].some(drawnInApp);
}
