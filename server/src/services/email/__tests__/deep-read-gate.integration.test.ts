/**
 * ADR 0110 — when is a second read of the message on offer?
 *
 * The gate is about LENGTH, not about which column the text came from. Getting
 * that wrong is silent: the extractor simply never asks, and a BitGo amount or
 * an Expedia itinerary stays unread with no error anywhere.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { BODY_EXCERPT_CHARS } from '@/utils/email-text.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('the deep-read offer', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorBudget: number;
  let priorProvider: string;
  /** subject → was `readMore` handed to the extractor? */
  const offered = new Map<string, boolean>();

  const spy: EmailExtractor = {
    async extract(input) {
      offered.set(input.subject, Boolean(input.readMore));
      return null;
    },
  };

  beforeEach(async () => {
    offered.clear();
    db = await openTestDb();
    userId = await createUser(db, 'deep-read');
    priorBudget = env.EMAIL_DEEP_READ_PER_TICK;
    // The ADR 0074 invite probe fetches the message from Gmail; without a
    // provider it throws, and a failed probe DEFERS the thread — the
    // extractor is never reached and this file would test nothing.
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { EMAIL_DEEP_READ_PER_TICK: number }).EMAIL_DEEP_READ_PER_TICK = priorBudget;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const seed = async (
    gid: string,
    subject: string,
    body: { excerpt?: string; text?: string },
  ): Promise<void> => {
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
        body_excerpt: body.excerpt ?? null,
        body_text: body.text ?? null,
        // '' = parsed, no invite (ADR 0080). Without it the ADR 0074 probe runs,
        // fails for want of Google credentials, and DEFERS the thread — so the
        // extractor is never reached and this file would silently test nothing.
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
  };

  /** Magics only looks at classified threads. */
  const classify = async (gids: string[]): Promise<void> => {
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:fin', parentId: null, title: 'Finance', depth: 0 }],
      assignments: gids.map((gmailThreadId) => ({ gmailThreadId, categoryId: 'c:fin' })),
    });
  };

  it('offers when there is more than the extractor will show, and not otherwise', async () => {
    await seed('t_capped', 'Invoice at the cap', { excerpt: 'x'.repeat(BODY_EXCERPT_CHARS) });
    await seed('t_short', 'Short note', { excerpt: 'Lunch Friday?' });
    // The case the first version of this gate missed: a thread someone opened
    // holds the WHOLE body, and the extractor still shows only the first 2,000
    // characters of it.
    await seed('t_opened', 'Opened thread', { text: 'y'.repeat(20_000) });
    await classify(['t_capped', 't_short', 't_opened']);

    await runEmailMagics(db, userId, { extractor: spy });

    expect(offered.get('Invoice at the cap')).toBe(true);
    expect(offered.get('Opened thread')).toBe(true);
    // An excerpt under the cap IS the whole message — nothing left to fetch.
    expect(offered.get('Short note')).toBe(false);
  });

  it('stops offering once the tick has spent its ceiling', async () => {
    (env as { EMAIL_DEEP_READ_PER_TICK: number }).EMAIL_DEEP_READ_PER_TICK = 0;
    await seed('t_capped', 'Invoice at the cap', { excerpt: 'x'.repeat(BODY_EXCERPT_CHARS) });
    await classify(['t_capped']);

    await runEmailMagics(db, userId, { extractor: spy });
    expect(offered.get('Invoice at the cap')).toBe(false);
  });
});
