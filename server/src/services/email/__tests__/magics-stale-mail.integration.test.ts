/**
 * Settled mail does not become a fresh obligation (ADR 0143).
 *
 * `GMAIL_BACKFILL_DAYS` is 90, and the magics pass had no age bound and no
 * read-state filter — so connecting a mailbox mined a quarter of a year of
 * already-handled inbox into to-dos, which is the pile-up users reported.
 *
 * The rule is the read-AND-old combination, not either half:
 *   - unread at any age  → still owed, still mined
 *   - read but recent    → they may be about to act, still mined
 *   - read and old       → history
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** Always proposes a to-do, so "was it mined" is exactly "is there a proposal". */
const stub: EmailExtractor = {
  async extract() {
    return { kind: 'task', title: 'Return the permission slip' };
  },
};

describe('magics skips mail already dealt with', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    __resetGmailMock();
    // Without the mock the ADR 0074 invite probe hits the real API, throws,
    // and DEFERS every thread - so all four cases would pass having mined
    // nothing. That is the vacuous-fixture trap ADR 0128 documented.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
    userId = await createUser(db, 'stale-mail-user');
    await ensurePersonalGroup(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  async function seedThread(opts: { read: boolean; ageDays: number }): Promise<string> {
    const at = daysAgo(opts.ageDays);
    const now = new Date().toISOString();
    const gid = `t_${newId('x')}`;
    const threadId = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Permission slip for the trip',
        snippet: 'Please sign and return the attached slip.',
        from_email: 'office@school.example',
        last_message_at: at,
        is_unread: opts.read ? 0 : 1,
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
        from_name: 'School office',
        from_email: 'office@school.example',
        to_emails: JSON.stringify(['me@example.com']),
        cc_emails: JSON.stringify([]),
        subject: 'Permission slip for the trip',
        snippet: 'Please sign and return the attached slip.',
        body_text: 'Please sign and return the attached permission slip.',
        body_html: null,
        internal_date: at,
        is_unread: opts.read ? 0 : 1,
        gmail_label_ids: JSON.stringify(opts.read ? ['INBOX'] : ['INBOX', 'UNREAD']),
        rfc822_message_id: null,
        headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
        created_at: now,
      })
      .execute();
    __addGmailMockMessage(userId, {
      id: `m_${gid}`,
      threadId: gid,
      labelIds: opts.read ? ['INBOX'] : ['INBOX', 'UNREAD'],
      snippet: 'Please sign and return the attached slip.',
      internalDate: String(Date.parse(at)),
      historyId: '1',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Permission slip for the trip' }],
        body: { size: 10, data: Buffer.from('Please sign it.').toString('base64url') },
      },
    });
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'school', parentId: null, title: 'School', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'school' }],
    });
    return gid;
  }

  const proposalCount = async (): Promise<number> => {
    const rows = await db
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', userId)
      .execute();
    return rows.length;
  };

  it('mines unread mail however old it is', async () => {
    // Nobody has looked at it, so the obligation is still owed. This is the
    // case an age-only cutoff would have wrongly dropped.
    await seedThread({ read: false, ageDays: 60 });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(1);
  });

  it('mines mail read recently', async () => {
    await seedThread({ read: true, ageDays: 1 });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(1);
  });

  it('skips mail that was read and left sitting', async () => {
    await seedThread({ read: true, ageDays: 30 });

    await runEmailMagics(db, userId, { extractor: stub });

    expect(await proposalCount()).toBe(0);
  });

  it('does not mark the skipped thread extracted, so raising the window recovers it', async () => {
    // The mark is once-ever (ADR 0076). Burning it here would mean a
    // deployment that widens the window silently never revisits the mail.
    const gid = await seedThread({ read: true, ageDays: 30 });

    await runEmailMagics(db, userId, { extractor: stub });

    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirst();
    expect(mark).toBeUndefined();
  });
});
