/**
 * A discretionary broadcast is not a to-do (ADR 0179).
 *
 * A CVS coupon ("$4 off, redeem by Sep 16") and a club's events digest were
 * being staged as `create_task` / `create_event` proposals nobody asked for.
 * The deterministic backstop: a thread whose TOP-LEVEL category is Coupons or
 * Newsletters is kept out of the magics pass entirely, and anything already
 * staged from one is retracted on the sweep.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/** Always proposes a to-do, so "was it mined" is exactly "is there a proposal". */
const stub: EmailExtractor = {
  async extract() {
    return { kind: 'task', title: 'Use the coupon before it expires' };
  },
};

describe('magics skips discretionary broadcasts', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    __resetGmailMock();
    // Without the mock the ADR 0074 invite probe hits the real API and defers
    // every thread — the vacuous-fixture trap ADR 0128 documented.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
    userId = await createUser(db, 'broadcast-user');
    await ensurePersonalGroup(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  /** Seed a fresh unread thread and classify it onto `categories`/`assignments`. */
  async function seedThread(opts: {
    subject: string;
    categories: Array<{ id: string; parentId: string | null; title: string; depth: number }>;
    categoryId: string;
  }): Promise<string> {
    const now = new Date().toISOString();
    const gid = `t_${newId('x')}`;
    const threadId = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gid,
        subject: opts.subject,
        snippet: opts.subject,
        from_email: 'extracare@mystore.cvs.com',
        last_message_at: now,
        is_unread: 1,
        is_archived: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: `m_${gid}`,
        gmail_thread_id: gid,
        from_name: 'CVS',
        from_email: 'extracare@mystore.cvs.com',
        to_emails: JSON.stringify(['me@example.com']),
        cc_emails: JSON.stringify([]),
        subject: opts.subject,
        snippet: opts.subject,
        body_text: '$4 off your entire purchase. Redeem through Wednesday, September 16.',
        body_html: null,
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        rfc822_message_id: null,
        headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
        created_at: now,
      })
      .execute();
    __addGmailMockMessage(userId, {
      id: `m_${gid}`,
      threadId: gid,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: opts.subject,
      internalDate: String(Date.parse(now)),
      historyId: '1',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: opts.subject }],
        body: { size: 10, data: Buffer.from('$4 off.').toString('base64url') },
      },
    });
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: opts.categories,
      assignments: [{ gmailThreadId: gid, categoryId: opts.categoryId }],
    });
    return gid;
  }

  const proposalCount = async (): Promise<number> =>
    (
      await db
        .selectFrom('proposals')
        .select('id')
        .where('proposed_by_user_id', '=', userId)
        .where('status', '=', 'pending')
        .execute()
    ).length;

  const markExists = async (gid: string): Promise<boolean> =>
    (await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirst()) !== undefined;

  it('skips a thread nested under Coupons, and does not mark it mined', async () => {
    const gid = await seedThread({
      subject: '$4 off your entire purchase',
      categories: [
        { id: 'coupons', parentId: null, title: 'Coupons', depth: 0 },
        { id: 'coupons-retail', parentId: 'coupons', title: 'Retail', depth: 1 },
      ],
      categoryId: 'coupons-retail',
    });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(0);
    // ADR 0143 — a policy change must be able to revisit it.
    expect(await markExists(gid)).toBe(false);
  });

  it('skips a bare top-level Newsletters thread', async () => {
    await seedThread({
      subject: 'Dining Spotlight of the Week',
      categories: [{ id: 'newsletters', parentId: null, title: 'Newsletters', depth: 0 }],
      categoryId: 'newsletters',
    });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(0);
  });

  it('still mines ordinary mail', async () => {
    await seedThread({
      subject: 'Permission slip for the trip',
      categories: [{ id: 'family', parentId: null, title: 'Friends & family', depth: 0 }],
      categoryId: 'family',
    });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(1);
  });

  it('retracts a proposal already staged from a Coupons thread', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    const gid = await seedThread({
      subject: '$4 off your entire purchase',
      categories: [{ id: 'coupons', parentId: null, title: 'Coupons', depth: 0 }],
      categoryId: 'coupons',
    });
    // Pre-stage a proposal the way an earlier pass would have.
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Use the CVS coupon' },
      provenance: `gmail:${gid}`,
    });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(0);
    const row = await db
      .selectFrom('proposals')
      .select('status')
      .where('proposed_by_user_id', '=', userId)
      .executeTakeFirst();
    expect(row?.status).toBe('expired');
  });
});
