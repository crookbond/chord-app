/**
 * ADR 0249 — a receipt outlives its email.
 *
 * The reported case: the user read a receipt, then deleted the email, and the
 * purchase dropped out of every total, because receipts were read off the
 * thread row and a trashed thread was skipped (a deleted one has no row at
 * all). Built on a real-shaped receipt run through the suggestion pass.
 */
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findingsQuestions, topShops } from '@chord/kernel';

import { env } from '@/config/env.js';
import { copyThreadReceipts } from '@/db/migrate.js';
import type { DB } from '@/db/schema.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { parseReceipt, runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { keepReceipt, listReceipts, normalizePaymentMethod } from '@/services/email/receipts.service.js';
import { pruneOldRows } from '@/services/retention.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const BODY = `Thank you for your order!

Order #112-4471902-5530611
Dyson V8 Cordless Vacuum        $349.99
Order total: $349.99

Paid with Visa ending in 4242.`;

let db: Kysely<DB>;
let userId: string;
let priorGmailProvider: string;

beforeEach(async () => {
  __resetGmailMock();
  priorGmailProvider = env.GMAIL_PROVIDER;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db
    .updateTable('users')
    .set({ last_tz: 'America/New_York', email: 'john@gmail.com' })
    .where('id', '=', userId)
    .execute();
});
afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorGmailProvider;
  await closeTestDb(db);
});

async function seedReceiptEmail(gid: string, opts: { accountId?: string; at?: string } = {}): Promise<string> {
  const id = newId('emt');
  const messageId = newId('gm');
  const at = opts.at ?? new Date().toISOString();
  __addGmailMockMessage(userId, {
    id: messageId,
    threadId: gid,
    labelIds: ['INBOX'],
    snippet: 'Your Amazon.com order',
    internalDate: String(Date.parse(at)),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'auto-confirm@amazon.com' },
        { name: 'Subject', value: 'Your Amazon.com order' },
      ],
      body: { data: Buffer.from(BODY).toString('base64url') },
    },
  });
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      account_id: opts.accountId ?? null,
      subject: 'Your Amazon.com order',
      snippet: 'Your Amazon.com order',
      from_email: 'auto-confirm@amazon.com',
      from_name: 'Amazon.com',
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_thread_id: gid,
      gmail_message_id: messageId,
      subject: 'Your Amazon.com order',
      snippet: 'Your Amazon.com order',
      from_email: 'auto-confirm@amazon.com',
      from_name: 'Amazon.com',
      body_excerpt: BODY,
      ics_text: '',
      to_emails: JSON.stringify(['john@gmail.com']),
      cc_emails: JSON.stringify([]),
      internal_date: at,
      created_at: at,
    })
    .execute();
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: 'receipts', parentId: null, title: 'Receipts', depth: 0 }],
    assignments: [{ gmailThreadId: gid, categoryId: 'receipts' }],
  });
  return id;
}

/** What the model returns for the receipt above, read through the real parser. */
const receiptStub: EmailExtractor = {
  async extract(input) {
    const facts = parseReceipt(
      JSON.stringify({
        items: [],
        receipt: {
          merchant: 'Amazon.com',
          amount: 349.99,
          currency: 'USD',
          orderNumber: '112-4471902-5530611',
          paymentMethod: 'Visa ending in 4242',
        },
      }),
    );
    if (facts) input.onReceipt?.(facts);
    return null;
  },
};

describe('a receipt kept apart from its email (ADR 0249)', () => {
  it('still counts after the email is trashed, and after it is deleted, with its mailbox and card', async () => {
    const threadId = await seedReceiptEmail('g-amazon');
    await runEmailMagics(db, userId, { extractor: receiptStub });

    const first = (await listReceipts(db, userId)).receipts;
    expect(first).toEqual([
      expect.objectContaining({
        threadId,
        merchant: 'Amazon.com',
        amount: 349.99,
        paymentMethod: 'Visa ••4242',
        mailbox: 'john@gmail.com',
      }),
    ]);

    // Trashed: the old read skipped TRASH, so this is where it vanished.
    await db
      .updateTable('email_threads')
      .set({ gmail_label_ids: JSON.stringify(['TRASH']) })
      .where('id', '=', threadId)
      .execute();
    expect((await listReceipts(db, userId)).receipts.map((r) => r.amount)).toEqual([349.99]);

    // Deleted: the thread row is gone, and only the link goes with it.
    await db.deleteFrom('email_messages').where('thread_id', '=', threadId).execute();
    await db.deleteFrom('email_threads').where('id', '=', threadId).execute();
    const after = (await listReceipts(db, userId)).receipts;
    expect(after).toEqual([
      expect.objectContaining({ threadId: null, amount: 349.99, paymentMethod: 'Visa ••4242' }),
    ]);
  });

  it('records which mailbox a receipt came to', async () => {
    const accountId = newId('acct');
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({
        id: accountId,
        user_id: userId,
        provider: 'outlook',
        email_address: 'john@work.example',
        display_name: null,
        preset_key: null,
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const threadId = await seedReceiptEmail('acct-1:g-work', { accountId });
    await keepReceipt(db, threadId, { merchant: 'Amazon.com', amount: 12 });
    const [r] = (await listReceipts(db, userId)).receipts;
    expect(r.mailbox).toBe('john@work.example');
  });

  it('copies receipts that were already on threads when the table was added', async () => {
    const threadId = await seedReceiptEmail('g-old');
    await sql`UPDATE email_threads SET receipt_json = ${JSON.stringify({ merchant: 'Target', amount: 20 })}::jsonb
      WHERE id = ${threadId}`.execute(db);
    await copyThreadReceipts(db);
    await copyThreadReceipts(db);
    const rows = await db.selectFrom('email_receipts').select(['mailbox']).execute();
    expect(rows).toEqual([{ mailbox: 'john@gmail.com' }]);
    expect((await listReceipts(db, userId)).receipts.map((r) => r.merchant)).toEqual(['Target']);
  });

  it('is removed three years after its email, and with the account', async () => {
    const old = new Date(Date.now() - 1100 * 86_400_000).toISOString();
    // Written directly: a three-year-old read email is not mined (ADR 0143).
    await keepReceipt(db, await seedReceiptEmail('g-ancient', { at: old }), { merchant: 'Target', amount: 9 });
    await keepReceipt(db, await seedReceiptEmail('g-recent'), { merchant: 'Target', amount: 9 });
    expect(await db.selectFrom('email_receipts').select('id').execute()).toHaveLength(2);

    const res = await pruneOldRows(db);
    expect(res.receipts).toBe(1);
    expect(await db.selectFrom('email_receipts').select('gmail_thread_id').execute()).toEqual([
      { gmail_thread_id: 'g-recent' },
    ]);

    await db.deleteFrom('users').where('id', '=', userId).execute();
    expect(await db.selectFrom('email_receipts').select('id').execute()).toHaveLength(0);
  });
});

describe('payment method', () => {
  it('keeps only the card type and its last four digits', () => {
    expect(normalizePaymentMethod('Visa ending in 4242')).toBe('Visa ••4242');
    expect(normalizePaymentMethod('4111 1111 1111 1234')).toBe('Card ••1234');
    expect(normalizePaymentMethod('Mastercard XXXX-XXXX-XXXX-5555')).toBe('Mastercard ••5555');
    expect(normalizePaymentMethod('Amex ending 0005')).toBe('Amex ••0005');
    expect(normalizePaymentMethod('PayPal')).toBe('PayPal');
    expect(normalizePaymentMethod('Apple Pay')).toBe('Apple Pay');
    expect(normalizePaymentMethod('')).toBeNull();
    expect(normalizePaymentMethod(12)).toBeNull();
  });

  it('cuts a whole card number the model returned down before it is stored', () => {
    const facts = parseReceipt(JSON.stringify({ receipt: { amount: 5, paymentMethod: 'Visa 4111111111111111' } }));
    expect(facts?.paymentMethod).toBe('Visa ••1111');
  });
});

describe('Findings questions', () => {
  it('asks only what the mail can answer, then how many orders from each top shop', () => {
    const shops = topShops([
      { merchant: 'Target' },
      { merchant: 'Amazon.com' },
      { merchant: 'Amazon.com' },
      { merchant: "Macy's" },
      { merchant: 'A shop name far too long to read well inside a question' },
    ]);
    expect(shops[0]).toBe('Amazon.com');
    const qs = findingsQuestions(shops);
    expect(qs).toEqual([
      'What am I paying for every month?',
      'Which mailing lists am I on?',
      'Who emails me the most?',
      'Who needs a reply?',
      'How many orders from Amazon.com last month?',
      'How many orders from Target last month?',
      "How many orders from Macy's last month?",
    ]);
  });
});
