/**
 * ADR 0246 — the pure half of receipts: one purchase counted once, totals kept
 * per currency, and "repeating charge" meaning three evenly spaced charges of
 * about the same amount, not two that happen to share a shop.
 */
import { describe, expect, it } from 'vitest';

import {
  dedupeReceipts,
  detectRecurring,
  merchantKeyOf,
  summarizeSpending,
  type Receipt,
} from '../receipts.service.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const DAY = 86_400_000;

let n = 0;
const r = (merchant: string, amount: number, at: string, extra: Partial<Receipt> = {}): Receipt => ({
  threadId: `t${(n += 1)}`,
  merchant,
  merchantKey: merchantKeyOf(merchant),
  amount,
  currency: 'USD',
  at: new Date(at).toISOString(),
  orderNumber: null,
  paymentMethod: null,
  mailbox: null,
  ...extra,
} as Receipt);
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

describe('merchantKeyOf', () => {
  it('folds the spellings one shop arrives under', () => {
    expect(merchantKeyOf('Amazon.com')).toBe('amazon');
    expect(merchantKeyOf('AMAZON, Inc.')).toBe('amazon');
    expect(merchantKeyOf("Trader Joe's")).toBe('trader joe s');
  });
});

describe('dedupeReceipts', () => {
  it('counts an order once across its confirmation and shipping emails', () => {
    const out = dedupeReceipts([
      r('Amazon', 42.1, '2026-09-03T10:00:00Z', { orderNumber: '112-55' }),
      r('Amazon', 42.1, '2026-09-05T08:00:00Z', { orderNumber: '112-55' }),
      r('Amazon', 9.99, '2026-09-05T08:00:00Z', { orderNumber: '112-77' }),
    ]);
    expect(out.map((x) => x.amount).sort()).toEqual([42.1, 9.99]);
  });

  it('drops a same-day same-amount twin with no order number, and keeps a different amount', () => {
    const out = dedupeReceipts([
      r('Uber', 18.4, '2026-09-03T10:00:00Z'),
      r('Uber', 18.4, '2026-09-03T10:05:00Z'),
      r('Uber', 22.0, '2026-09-03T19:00:00Z'),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('summarizeSpending', () => {
  const receipts = [
    r('Amazon', 10, '2026-09-10T12:00:00Z'),
    r('Amazon.com', 5.5, '2026-09-20T12:00:00Z'),
    r('Amazon', 7, '2026-08-02T12:00:00Z', { currency: 'EUR' }),
    r('Target', 30, '2026-08-02T12:00:00Z'),
  ];

  it('totals per merchant and never adds two currencies together', () => {
    const groups = summarizeSpending(receipts, 'merchant');
    expect(groups.map((g) => [g.key, g.currency, g.total, g.count])).toEqual([
      ['Target', 'USD', 30, 1],
      ['Amazon', 'USD', 15.5, 2],
      ['Amazon', 'EUR', 7, 1],
    ]);
  });

  it('puts a purchase in the month it happened in for the user, not for the server', () => {
    const late = [r('Shop', 1, '2026-10-01T02:00:00Z')];
    expect(summarizeSpending(late, 'month')[0].key).toBe('2026-10');
    // 10pm on 30 September in New York.
    expect(summarizeSpending(late, 'month', -240)[0].key).toBe('2026-09');
  });
});

describe('detectRecurring', () => {
  it('finds a monthly charge after three evenly spaced payments', () => {
    const out = detectRecurring(
      [r('Netflix', 15.49, daysAgo(65)), r('Netflix', 15.49, daysAgo(35)), r('Netflix', 15.49, daysAgo(5))],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ merchant: 'Netflix', cadence: 'monthly', charges: 3, amount: 15.49 });
    expect(Date.parse(out[0].nextExpectedAt)).toBeGreaterThan(NOW);
  });

  it('does not call two charges a subscription', () => {
    expect(detectRecurring([r('Netflix', 15.49, daysAgo(35)), r('Netflix', 15.49, daysAgo(5))], NOW)).toEqual([]);
  });

  it('ignores a shop the user simply buys from often, at uneven gaps and amounts', () => {
    const out = detectRecurring(
      [
        r('Amazon', 12, daysAgo(60)),
        r('Amazon', 80, daysAgo(52)),
        r('Amazon', 31, daysAgo(20)),
        r('Amazon', 9, daysAgo(3)),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('ignores evenly spaced charges whose amounts differ too much to be one plan', () => {
    const out = detectRecurring(
      [r('Con Ed', 60, daysAgo(65)), r('Con Ed', 140, daysAgo(35)), r('Con Ed', 95, daysAgo(5))],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('leaves out a pattern that has already stopped', () => {
    const out = detectRecurring(
      [r('Gym', 40, daysAgo(200)), r('Gym', 40, daysAgo(170)), r('Gym', 40, daysAgo(140))],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('recognises a yearly charge', () => {
    const out = detectRecurring(
      [r('Domain Co', 20, daysAgo(735)), r('Domain Co', 20, daysAgo(370)), r('Domain Co', 21, daysAgo(5))],
      NOW,
    );
    expect(out[0]).toMatchObject({ cadence: 'yearly' });
  });
});
