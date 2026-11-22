import { describe, expect, it } from 'vitest';

import {
  capFacts,
  dedupeTimeline,
  dropPastTimeline,
  extractLedgerFact,
  parseDirection,
  extractStateStatus,
  ledgerFromArgs,
  parseAmount,
  receiptToLedgerFact,
} from '@/services/email/tile-facts.js';

describe('extractStateStatus', () => {
  it('keeps live shipping/travel status and drops landed rows', () => {
    expect(extractStateStatus('Your package shipped', '')).toBe('shipped');
    expect(extractStateStatus('Out for delivery today', '')).toBe('out_for_delivery');
    expect(extractStateStatus('Flight delayed', '')).toBe('delayed');
    expect(extractStateStatus('Boarding now', '')).toBe('boarding');
    expect(extractStateStatus('Online check-in is open', '')).toBe('check_in');
    expect(extractStateStatus('Your package was delivered', '')).toBeNull();
    expect(extractStateStatus('Newsletter week 12', '')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads thousands with or without a separator', () => {
    expect(parseAmount('Invoice $1,240.00')).toBe(1240);
    expect(parseAmount('Statement $1240 due')).toBe(1240);
    expect(parseAmount('Autopay $85.50 scheduled')).toBe(85.5);
    expect(parseAmount('Total 2400 USD')).toBe(2400);
    expect(parseAmount('Balance $12,345.67')).toBe(12345.67);
    expect(parseAmount('No numbers here')).toBeNull();
  });
});

describe('extractLedgerFact', () => {
  it('requires a parsed amount and skips receipts without due', () => {
    expect(parseAmount('Invoice $1,240.00')).toBe(1240);
    const bill = extractLedgerFact('Invoice $1,240 due 2026-09-01', '', 'Acme', 'bills@acme.com', 't1');
    expect(bill).toMatchObject({ merchant: 'Acme', amount: 1240, dueAt: '2026-09-01T12:00:00+00:00', threadId: 't1' });
    // ADR 0074 - the owner's offset anchors a bare due date.
    expect(
      extractLedgerFact('Invoice $20 due 2026-09-01', '', 'Acme', null, 't1', '+13:00')?.dueAt,
    ).toBe('2026-09-01T12:00:00+13:00');
    expect(extractLedgerFact('Your receipt $12.00', 'Thank you for your order', 'Store', null, 't2')).toBeNull();
    expect(extractLedgerFact('Statement ready', 'See attached', 'Chase', null, 't3')).toBeNull();
  });

  it("a due date's own DST side is used when a zone name is given, not a stale fallback offset", () => {
    // A due date months out routinely lands on the other side of a DST
    // boundary from whenever classification happens to run — the fallback
    // offset below is deliberately wrong (as if computed in October) to
    // prove it's ignored once `tz` is supplied.
    const staleOctoberOffset = '-04:00';
    expect(
      extractLedgerFact(
        'Invoice $20 due 2026-12-05',
        '',
        'Acme',
        null,
        't1',
        staleOctoberOffset,
        'America/New_York',
      )?.dueAt,
    ).toBe('2026-12-05T12:00:00-05:00');
    // A July due date correctly resolves to -04:00 too, for the right reason.
    expect(
      extractLedgerFact(
        'Invoice $20 due 2026-07-04',
        '',
        'Acme',
        null,
        't1',
        staleOctoberOffset,
        'America/New_York',
      )?.dueAt,
    ).toBe('2026-07-04T12:00:00-04:00');
  });

  it('accepts magics JSON only when amount parses', () => {
    expect(ledgerFromArgs({ kind: 'ledger', amount: 40, merchant: 'Gym' }, 't', 'X')).toMatchObject({
      amount: 40,
      merchant: 'Gym',
      threadId: 't',
    });
    expect(ledgerFromArgs({ kind: 'ledger', amount: 'nope' }, 't', 'X')).toBeNull();
    expect(ledgerFromArgs({ kind: 'event', title: 'Recital' }, 't', 'X')).toBeNull();
  });
});

/**
 * From prod: a `-$119.90` merchant credit rendered in the Finance tile as
 * `American Express $119.90` — the sign dropped, so money coming back read as
 * money owed, and the merchant was the card issuer rather than the shop.
 */
describe('a merchant credit is not a charge', () => {
  // The real Amex layout: merchant on its own line directly above the figure.
  const AMEX = [
    'See the merchant credit details',
    '',
    'JOHN DOE',
    '',
    'Account Ending: 82006',
    '',
    'Your account has been credited',
    '',
    "Here's more information about any merchant credits you received",
    '',
    'REI #133 EAST HANOVE',
    '',
    '-$119.90',
    '',
    'Aug 23, 2026',
  ].join('\n');

  it('reads the sign and the real merchant off the statement line', () => {
    const fact = extractLedgerFact(
      'Merchant credit/refund was issued to your account',
      AMEX,
      'American Express',
      'americanexpress@welcome.americanexpress.com',
      't_amex',
    );
    expect(fact).toMatchObject({
      merchant: 'REI #133 EAST HANOVE',
      amount: 119.9,
      direction: 'credit',
    });
  });

  it('treats accounting parentheses and credit wording as credits too', () => {
    expect(parseDirection('Adjustment ($45.00)')).toBe('credit');
    expect(parseDirection('A refund of $45.00 was issued')).toBe('credit');
    expect(parseDirection('Cash back earned: $12')).toBe('credit');
    // The sign wins over the wording — a statement can mention a refund while
    // the figure on it is what you owe.
    expect(parseDirection('Your refund was applied. Balance due $200.00')).toBe('debit');
  });

  it('leaves an ordinary bill a debit, attributed to the sender', () => {
    const bill = extractLedgerFact('Invoice $1,240 due 2026-09-01', '', 'Acme', 'bills@acme.com', 't1');
    expect(bill).toMatchObject({ merchant: 'Acme', amount: 1240, direction: 'debit' });
  });

  it('ranks money owed above money coming back, whatever the sizes', () => {
    const credit = extractLedgerFact('Refund issued', AMEX, 'American Express', null, 't_c')!;
    const small = extractLedgerFact('Invoice $5 due 2026-09-01', '', 'Acme', null, 't_b')!;
    const ranked = capFacts({ kind: 'ledger', items: [credit, small] });
    expect(ranked.kind === 'ledger' && ranked.items.map((i) => i.threadId)).toEqual(['t_b', 't_c']);
  });

  it('ranks a settled receipt last — nothing to do about it, whatever the size (ADR 0160)', () => {
    const receipt = receiptToLedgerFact({ merchant: 'REI', amount: 5000 }, 't_r', 'X')!;
    const credit = extractLedgerFact('Refund issued', AMEX, 'American Express', null, 't_c')!;
    const bill = extractLedgerFact('Invoice $5 due 2026-09-01', '', 'Acme', null, 't_b')!;
    const ranked = capFacts({ kind: 'ledger', items: [receipt, credit, bill] });
    expect(ranked.kind === 'ledger' && ranked.items.map((i) => i.threadId)).toEqual(['t_b', 't_c', 't_r']);
  });

  it('falls back to the sender when the line above the amount is prose', () => {
    // Narrow on purpose: an unrecognised layout degrades to the old behaviour
    // rather than inventing a merchant out of a sentence.
    const fact = extractLedgerFact(
      'Charge posted',
      'Your account was charged for the following.\n\n$42.00',
      'Chase',
      null,
      't_prose',
    );
    expect(fact).toMatchObject({ merchant: 'Chase', amount: 42 });
  });
});

describe('dropPastTimeline', () => {
  it('drops items whose at is in the past', () => {
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const kept = dropPastTimeline(
      [
        { title: 'Past', at: '2026-08-01T15:00:00.000Z', threadId: 'a' },
        { title: 'Soon', at: '2026-08-20T15:00:00.000Z', threadId: 'b' },
      ],
      now,
    );
    expect(kept.map((i) => i.title)).toEqual(['Soon']);
  });
});

describe('timeline ordering + dedupe', () => {
  it('sorts soonest-first by instant, not by ISO string', () => {
    const facts = capFacts({
      kind: 'timeline',
      items: [
        { title: 'Later', at: '2099-01-15T15:00:00-07:00', threadId: 'a' },
        { title: 'Sooner', at: '2099-01-15T16:00:00Z', threadId: 'b' },
      ],
    });
    expect(facts.kind === 'timeline' && facts.items.map((i) => i.title)).toEqual(['Sooner', 'Later']);
  });

  it('puts a delayed row first and a due bill before an undated one', () => {
    const board = capFacts({
      kind: 'state_board',
      items: [
        { title: 'Package', status: 'shipped', threadId: 'a' },
        { title: 'Flight', status: 'delayed', threadId: 'b' },
      ],
    });
    expect(board.kind === 'state_board' && board.items.map((i) => i.title)).toEqual([
      'Flight',
      'Package',
    ]);

    const led = capFacts({
      kind: 'ledger',
      items: [
        { merchant: 'Undated', amount: 900, dueAt: null, threadId: 'a' },
        { merchant: 'Soon', amount: 10, dueAt: '2026-09-01T12:00:00.000Z', threadId: 'b' },
      ],
    });
    expect(led.kind === 'ledger' && led.items.map((i) => i.merchant)).toEqual(['Soon', 'Undated']);
  });

  it('keeps distinct events on one thread but collapses the same instant to the confirmed copy', () => {
    const items = dedupeTimeline([
      { title: 'Recital (proposed)', at: '2099-01-15T22:00:00Z', threadId: 'a', proposalId: 'p1' },
      { title: 'Recital', at: '2099-01-15T15:00:00-07:00', threadId: 'a', proposalId: null },
      { title: 'Dress rehearsal', at: '2099-01-14T22:00:00Z', threadId: 'a', proposalId: 'p2' },
    ]);
    expect(items.map((i) => i.title).sort()).toEqual(['Dress rehearsal', 'Recital']);
  });
});
