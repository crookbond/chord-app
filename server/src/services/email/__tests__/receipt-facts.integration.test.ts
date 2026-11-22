/**
 * ADR 0160 — a receipt is settled, not owed.
 *
 * Mined by the magics pass into `receipt_json` (mirroring delivery/flight —
 * ADR 0135/0138): read-don't-propose, since a purchase already paid in full
 * has nothing left to confirm.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  parseReceipt,
  runEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { receiptToLedgerFact } from '@/services/email/tile-facts.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('parseReceipt', () => {
  it('takes the amount and details the email stated', () => {
    expect(
      parseReceipt(
        '{"kind":"none","receipt":{"merchant":"REI","amount":119.9,"currency":"usd","purchasedAt":"2026-09-03","orderNumber":"ORD-4471"}}',
      ),
    ).toEqual({
      merchant: 'REI',
      amount: 119.9,
      currency: 'USD',
      purchasedAt: '2026-09-03',
      orderNumber: 'ORD-4471',
    });
  });

  it('drops the block when no amount is stated — an unpriced receipt is not a fact', () => {
    expect(parseReceipt('{"receipt":{"merchant":"REI"}}')).toBeNull();
  });

  it('drops a purchase date it cannot parse rather than rendering a wrong day', () => {
    expect(parseReceipt('{"receipt":{"amount":40,"purchasedAt":"sometime last week"}}')).toMatchObject({
      amount: 40,
      purchasedAt: null,
    });
  });

  it('ignores mail with no receipt block at all', () => {
    expect(parseReceipt('{"kind":"none"}')).toBeNull();
    expect(parseReceipt('not json')).toBeNull();
  });
});

describe('receiptToLedgerFact', () => {
  it('marks a receipt paid — never owed, never a refund', () => {
    const fact = receiptToLedgerFact({ merchant: 'REI', amount: 119.9 }, 't1', 'Fallback');
    expect(fact).toEqual({ merchant: 'REI', amount: 119.9, direction: 'paid', dueAt: null, threadId: 't1' });
  });

  it('falls back to the sender name when the mail named no merchant', () => {
    expect(receiptToLedgerFact({ amount: 12 }, 't2', 'Store')?.merchant).toBe('Store');
  });

  it('produces nothing for an unpriced or zero-amount fact', () => {
    expect(receiptToLedgerFact({ merchant: 'REI' }, 't3', 'X')).toBeNull();
    expect(receiptToLedgerFact({ amount: 0 }, 't3', 'X')).toBeNull();
    expect(receiptToLedgerFact(null, 't3', 'X')).toBeNull();
  });
});

describe('runEmailMagics — receipts', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'receipt');
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const seed = async (gid: string, subject: string, body: string, fromEmail = 'receipts@rei.com'): Promise<string> => {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: fromEmail,
        from_name: 'REI',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: body,
        // '' = parsed, no invite: without it the ADR 0074 probe defers the thread.
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:rcp', parentId: null, title: 'Receipts', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:rcp' }],
    });
    return threadRow;
  };

  /** Answers like the real extractor: a receipt block, suggestion "none". */
  const stub = (): EmailExtractor => ({
    async extract(input) {
      input.onReceipt?.({
        merchant: 'REI',
        amount: 119.9,
        currency: 'USD',
        purchasedAt: '2026-09-03',
        orderNumber: 'ORD-4471',
      });
      return null;
    },
  });

  it('stores the receipt for a future Finance feature to read', async () => {
    const threadRow = await seed(
      't_rcp',
      'Your REI order is confirmed',
      'Thank you for your order. Total charged: $119.90. Order #ORD-4471.',
    );
    await runEmailMagics(db, userId, { extractor: stub() });

    const row = await db
      .selectFrom('email_threads')
      .select('receipt_json')
      .where('id', '=', threadRow)
      .executeTakeFirstOrThrow();
    expect(row.receipt_json).toMatchObject({
      merchant: 'REI',
      amount: 119.9,
      currency: 'USD',
      purchasedAt: '2026-09-03',
      orderNumber: 'ORD-4471',
    });
  });

  it('never stages a proposal — a receipt is a record, not a decision', async () => {
    await seed('t_rcp2', 'Your REI order is confirmed', 'Total charged: $119.90.');
    await runEmailMagics(db, userId, { extractor: stub() });

    const pending = await db.selectFrom('proposals').select('id').where('proposed_by_user_id', '=', userId).execute();
    expect(pending).toHaveLength(0);
  });
});
