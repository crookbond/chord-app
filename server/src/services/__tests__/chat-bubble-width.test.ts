/**
 * Prod 2026-10-31, iPhone: after "unsubscribe me from DSCC emails" / "yes",
 * the unsubscribe card in the receipt strip under "yes" drew one letter per
 * line - the column was only as wide as "yes" and "└ ✅ Chord".
 */
import { describe, expect, it } from 'vitest';

import { chatColumnNeedsFixedWidth, type BotCard } from '@chord/kernel';

const dsccCard: BotCard = {
  kind: 'email',
  title: 'Unsubscribe: DSCC',
  subtitle: 'info@dscc.org',
  meta: 'tap to unsubscribe',
};

describe('chat column width', () => {
  it('fixes the width of a short "yes" whose receipt carries the DSCC card', () => {
    expect(chatColumnNeedsFixedWidth({ receiptCards: [dsccCard] })).toBe(true);
  });

  it('fixes the width of a short bot reply with a card or buttons under it', () => {
    expect(chatColumnNeedsFixedWidth({ cards: [dsccCard] })).toBe(true);
    expect(chatColumnNeedsFixedWidth({ proposalCount: 1 })).toBe(true);
  });

  it('leaves plain messages sized by their text', () => {
    expect(chatColumnNeedsFixedWidth({})).toBe(false);
    expect(chatColumnNeedsFixedWidth({ cards: [], receiptCards: [], proposalCount: 0 })).toBe(false);
  });

  it('ignores Telegram-only button cards, which the app does not draw', () => {
    const tgOnly: BotCard = { kind: 'action', title: 'Confirm', callback: { verb: 'p+', id: 'prop_1' } };
    expect(chatColumnNeedsFixedWidth({ cards: [tgOnly] })).toBe(false);
  });
});
