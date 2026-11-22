/**
 * The same mail, mined once — however many of the user's mailboxes it landed
 * in (bug 12, owner decision 2026-08-24).
 *
 * Being cc'd at two of your own addresses is ordinary, and ADR 0080 stores
 * provider ids account-prefixed, so one message becomes two `email_threads`
 * rows that the per-thread mark considers unrelated. `rfc822_message_id` is
 * the identity that crosses accounts.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { runPersonExtraction, type PersonExtractor } from '@/services/email/person-extraction.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('one message across two mailboxes is mined once', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    // The ADR 0074 invite probe runs before extraction and DEFERS the thread
    // on an API error, so without a usable provider nothing is ever mined.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'two-mailboxes');
    return async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      await closeTestDb(db);
    };
  });

  /** A mailbox's copy: its own account-prefixed thread id, the SAME RFC id. */
  const seedCopy = async (
    owner: string,
    opts: { gid: string; subject: string; rfc822: string | null },
  ): Promise<void> => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: owner,
        gmail_thread_id: opts.gid,
        subject: opts.subject,
        snippet: opts.subject,
        from_email: 'pta@school.org',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: owner,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: opts.gid,
        from_email: 'pta@school.org',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: opts.subject,
        snippet: opts.subject,
        body_text: 'Bake sale Friday - please bring something.',
        internal_date: now,
        rfc822_message_id: opts.rfc822,
        created_at: now,
      })
      .execute();
  };

  // `email_categories.id` is globally unique, not per user, so each owner
  // needs its own category id.
  const classifyAll = async (owner: string, gids: string[]) => {
    const catId = `ff-${owner}`;
    return ingestClassification(db, owner, {
      version: 1,
      userId: owner,
      categories: [{ id: catId, parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: gids.map((gmailThreadId) => ({ gmailThreadId, categoryId: catId })),
    });
  };

  const magicExtractor = () => {
    const calls = { n: 0 };
    const extractor: EmailExtractor = {
      extract: () => {
        calls.n += 1;
        return Promise.resolve({ kind: 'list', listName: 'To-dos', item: 'Bake something' });
      },
    };
    return { extractor, calls };
  };

  const personExtractor = () => {
    const calls = { n: 0 };
    const extractor: PersonExtractor = {
      extract: () => {
        calls.n += 1;
        return Promise.resolve([{ name: 'Ms. Patel', relationship: 'teacher', confidence: 0.9 }]);
      },
    };
    return { extractor, calls };
  };

  it('magics skips the second mailbox copy - no LLM call, no second proposal', async () => {
    await seedCopy(userId, { gid: 'primary:t1', subject: 'PTA bake sale', rfc822: '<pta-1@school.org>' });
    await seedCopy(userId, { gid: 'acct2:t9', subject: 'PTA bake sale', rfc822: '<pta-1@school.org>' });
    await classifyAll(userId, ['primary:t1', 'acct2:t9']);

    // Both copies are candidates on the first pass, so mine one at a time -
    // the SECOND pass is where the cross-account mark has to hold.
    const { extractor, calls } = magicExtractor();
    const first = await runEmailMagics(db, userId, { extractor, limit: 1 });
    const second = await runEmailMagics(db, userId, { extractor, limit: 1 });

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(calls.n).toBe(1);
  });

  it('person extraction skips it too', async () => {
    await seedCopy(userId, { gid: 'primary:t2', subject: 'Class notes', rfc822: '<notes-1@school.org>' });
    await seedCopy(userId, { gid: 'acct2:t8', subject: 'Class notes', rfc822: '<notes-1@school.org>' });

    const { extractor, calls } = personExtractor();
    const first = await runPersonExtraction(db, userId, { extractor, limit: 1 });
    const second = await runPersonExtraction(db, userId, { extractor, limit: 1 });

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(calls.n).toBe(1);
  });

  it('a DIFFERENT message is still mined - the join is on identity, not subject', async () => {
    await seedCopy(userId, { gid: 'primary:t3', subject: 'PTA bake sale', rfc822: '<pta-1@school.org>' });
    await seedCopy(userId, { gid: 'primary:t4', subject: 'PTA bake sale', rfc822: '<pta-2@school.org>' });
    await classifyAll(userId, ['primary:t3', 'primary:t4']);

    const { extractor, calls } = magicExtractor();
    await runEmailMagics(db, userId, { extractor, limit: 1 });
    const second = await runEmailMagics(db, userId, { extractor, limit: 1 });

    expect(second.processed).toBe(1);
    expect(calls.n).toBe(2);
  });

  it('a missing rfc822 id falls back to the per-thread mark, never collapsing mail', async () => {
    await seedCopy(userId, { gid: 'primary:t5', subject: 'No id A', rfc822: null });
    await seedCopy(userId, { gid: 'primary:t6', subject: 'No id B', rfc822: null });
    await classifyAll(userId, ['primary:t5', 'primary:t6']);

    const { extractor, calls } = magicExtractor();
    await runEmailMagics(db, userId, { extractor, limit: 1 });
    const second = await runEmailMagics(db, userId, { extractor, limit: 1 });

    expect(second.processed).toBe(1);
    expect(calls.n).toBe(2);
  });

  it('another user with the same message is untouched - the mark is per owner', async () => {
    const other = await createUser(db, 'other-mailbox-owner');
    await seedCopy(userId, { gid: 'primary:t7', subject: 'Shared id', rfc822: '<shared@school.org>' });
    await classifyAll(userId, ['primary:t7']);
    await runEmailMagics(db, userId, { extractor: magicExtractor().extractor, limit: 5 });

    await seedCopy(other, { gid: 'primary:t7', subject: 'Shared id', rfc822: '<shared@school.org>' });
    await classifyAll(other, ['primary:t7']);

    const theirs = await runEmailMagics(db, other, {
      extractor: magicExtractor().extractor,
      limit: 5,
    });
    expect(theirs.processed).toBe(1);
  });
});
