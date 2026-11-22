/**
 * ADR 0063 — the email insights digest: deterministic body + delivery through
 * the proactive scheduler (enqueue → drain → bot message in the personal group).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { setBriefingRule } from '@/services/email/briefing-rules.service.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { buildEmailDigestBody } from '@/services/email/digest.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { drainOnce, enqueueEmailDigest } from '@/services/proactive.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(
  userId: string,
  gmailThreadId: string,
  unread: boolean,
  opts: { fromEmail?: string; subject?: string } = {},
): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gmailThreadId,
      subject: opts.subject ?? gmailThreadId,
      from_email: opts.fromEmail ?? null,
      last_message_at: now,
      is_unread: unread ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

// Prod briefing 2026-10-23 listed one Microsoft notice twice and showed a
// to-do's due date as raw ISO text.
describe('buildEmailDigestBody - repeats', () => {
  const MS = 'We’ve verified your profile (Family Grocery Trip Chat Agent LLC dba ChordApp.ai, 7177760) and you may start exploring Partner Center';

  it('the same notice in two mailboxes is one line', async () => {
    const userId = await createUser(db, 'ms-twice');
    await seedThread(userId, 'g-ms-1', true, { fromEmail: 'msonlineservicesteam@microsoft.com', subject: MS });
    await seedThread(userId, 'g-ms-2', true, { fromEmail: 'msonlineservicesteam@microsoft.com', subject: MS });
    const body = (await buildEmailDigestBody(db, userId)) ?? '';
    expect(body.split(MS).length - 1).toBe(1);
  });

  it('an email already under "Waiting on you" is not repeated under "Worth a look"', async () => {
    const userId = await createUser(db, 'order-once');
    const personal = await ensurePersonalGroup(db, userId);
    await seedThread(userId, 'g-order', true, { fromEmail: 'seller@shop.example', subject: 'Your order cancellation request' });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Wait for seller response about order cancellation', dueAt: '2026-10-27T23:59:59-04:00' },
      provenance: 'gmail:g-order',
    });
    const body = (await buildEmailDigestBody(db, userId)) ?? '';
    expect(body).toContain('Wait for seller response about order cancellation');
    expect(body).not.toContain('Your order cancellation request');
  });

  it("a to-do's due date reads as a day, not as ISO text", async () => {
    const userId = await createUser(db, 'due-day');
    await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
    const personal = await ensurePersonalGroup(db, userId);
    await seedThread(userId, 'g-due', false);
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Wait for seller response about order cancellation', dueAt: '2026-10-27T23:59:59-04:00' },
      provenance: 'gmail:g-due',
    });
    const body = (await buildEmailDigestBody(db, userId)) ?? '';
    expect(body).toContain('→ due Tue, Oct 27');
    expect(body).not.toContain('2026-10-27T23:59:59');
  });
});

describe('buildEmailDigestBody', () => {
  it('returns null when there is no synced mail', async () => {
    const userId = await createUser(db, 'no-mail');
    expect(await buildEmailDigestBody(db, userId)).toBeNull();
  });

  it('leads with reply-worthy unread mail; counts are one closing line', async () => {
    const userId = await createUser(db, 'digest-user');
    await seedThread(userId, 't1', true);
    await seedThread(userId, 't2', true);
    await seedThread(userId, 't3', false);
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [
        { id: 'fin', parentId: null, title: 'Finance', depth: 0 },
        { id: 'trav', parentId: null, title: 'Travel', depth: 0 },
      ],
      assignments: [
        { gmailThreadId: 't1', categoryId: 'fin' },
        { gmailThreadId: 't2', categoryId: 'fin' },
        { gmailThreadId: 't3', categoryId: 'trav' },
      ],
    });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toContain('Worth a look:');
    expect(body).toContain('t1'); // unread subjects surface individually
    expect(body).toContain('t2');
    expect(body).toContain('2 unread');
    expect(body).toContain('Finance 2');
    expect(body).not.toContain('t3'); // read mail doesn't
  });

  // Prod briefing 2026-10-24: "6 unread — Social & professional 39 · Finance
  // 28 · …" — each category's TOTAL threads printed after the unread count.
  it('the count line gives each category its unread mail, not its total', async () => {
    const userId = await createUser(db, 'digest-counts');
    await seedThread(userId, 'f1', true);
    await seedThread(userId, 'f2', false);
    await seedThread(userId, 'f3', false);
    await seedThread(userId, 's1', false);
    await seedThread(userId, 's2', false);
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [
        { id: 'fin', parentId: null, title: 'Finance', depth: 0 },
        { id: 'soc', parentId: null, title: 'Social & professional', depth: 0 },
      ],
      assignments: [
        { gmailThreadId: 'f1', categoryId: 'fin' },
        { gmailThreadId: 'f2', categoryId: 'fin' },
        { gmailThreadId: 'f3', categoryId: 'fin' },
        { gmailThreadId: 's1', categoryId: 'soc' },
        { gmailThreadId: 's2', categoryId: 'soc' },
      ],
    });
    const body = (await buildEmailDigestBody(db, userId)) ?? '';
    const countLine = body.split('\n').at(-1);
    expect(countLine).toBe('1 unread — Finance 1.');
  });

  it('surfaces pending magic suggestions first and hides low-signal unread', async () => {
    const userId = await createUser(db, 'digest-attn');
    await seedThread(userId, 't-news', true); // unread but a newsletter → count line only
    const personal = await ensurePersonalGroup(db, userId);
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [
        { id: 'news', parentId: null, title: 'Newsletters', depth: 0 },
        { id: 'news/fin', parentId: 'news', title: 'Finance', depth: 1 },
      ],
      assignments: [{ gmailThreadId: 't-news', categoryId: 'news/fin' }],
    });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Fall Potluck', startsAt: '2026-10-03T17:30:00-07:00' },
      provenance: 'gmail:t-news',
    });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toContain('Waiting on you:');
    expect(body).toContain('Fall Potluck');
    // Newsletter unread stays off the "Worth a look" list (nested under
    // the Newsletters root) but still counts.
    expect(body).not.toContain('Worth a look:');
    expect(body).toContain('1 unread');
  });
});

describe('buildEmailDigestBody — ADR 0161 exclusion rules', () => {
  it('a sender_domain rule hides matching mail from "Worth a look" and the count line', async () => {
    const userId = await createUser(db, 'excl-domain');
    await seedThread(userId, 't-rip', true, {
      fromEmail: 'notifications@rippling.com',
      subject: 'Happy Birthday, Aris!',
    });
    await seedThread(userId, 't-mom', true, { fromEmail: 'mom@gmail.com', subject: 'Dinner Friday?' });
    await setBriefingRule(db, { userId, kind: 'sender_domain', pattern: 'rippling.com' });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toContain('Dinner Friday?');
    expect(body).not.toContain('Happy Birthday');
    expect(body).toContain('1 unread');
  });

  it('a subject_keyword rule hides matching mail regardless of sender', async () => {
    const userId = await createUser(db, 'excl-keyword');
    await seedThread(userId, 't-anniv', true, {
      fromEmail: 'notifications@rippling.com',
      subject: 'Happy Work Anniversary, Pradeep!',
    });
    await setBriefingRule(db, { userId, kind: 'subject_keyword', pattern: 'anniversary' });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toBeNull();
  });

  it('a category rule hides mail filed under a matching category title', async () => {
    const userId = await createUser(db, 'excl-category');
    await seedThread(userId, 't-social', true, { subject: 'Congrats on the promotion!' });
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'soc', parentId: null, title: 'Social & professional', depth: 0 }],
      assignments: [{ gmailThreadId: 't-social', categoryId: 'soc' }],
    });
    await setBriefingRule(db, { userId, kind: 'category', pattern: 'social' });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toBeNull();
  });

  it('an excluded thread\'s pending suggestion is dropped from "Waiting on you"', async () => {
    const userId = await createUser(db, 'excl-suggestion');
    const personal = await ensurePersonalGroup(db, userId);
    await seedThread(userId, 't-evite', false, { fromEmail: 'invites@evite.com', subject: 'Party!' });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Birthday Party', startsAt: '2026-10-03T17:30:00-07:00' },
      provenance: 'gmail:t-evite',
    });
    await setBriefingRule(db, { userId, kind: 'sender_domain', pattern: 'evite.com' });

    const body = await buildEmailDigestBody(db, userId);
    expect(body === null || !body.includes('Birthday Party')).toBe(true);
  });

  it('mail that matches no rule is unaffected', async () => {
    const userId = await createUser(db, 'excl-noop');
    await seedThread(userId, 't-mom', true, { fromEmail: 'mom@gmail.com', subject: 'Dinner Friday?' });
    await setBriefingRule(db, { userId, kind: 'sender_domain', pattern: 'rippling.com' });

    const body = await buildEmailDigestBody(db, userId);
    expect(body).toContain('Dinner Friday?');
    expect(body).toContain('1 unread');
  });
});

describe('email_digest proactive delivery', () => {
  it('drains to a bot message in the personal group', async () => {
    const userId = await createUser(db, 'proactive-user');
    const personal = await ensurePersonalGroup(db, userId);
    await seedThread(userId, 't1', true);

    await enqueueEmailDigest(db, userId);
    await drainOnce(db);

    const msg = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', personal.id)
      .where('kind', '=', 'bot')
      .where('is_proactive', '=', 1)
      .executeTakeFirst();
    expect(msg).toBeTruthy();
    expect(msg!.body).toContain('📬 Email');

    // The proactive row is retired (fired), so a second drain doesn't repost.
    const fired = await db
      .selectFrom('proactive_messages')
      .selectAll()
      .where('kind', '=', 'email_digest')
      .executeTakeFirst();
    expect(fired!.fired_at).toBeTruthy();
  });

  it('enqueue is idempotent while one is pending', async () => {
    const userId = await createUser(db, 'dedupe-user');
    await ensurePersonalGroup(db, userId);
    await enqueueEmailDigest(db, userId);
    await enqueueEmailDigest(db, userId);
    const rows = await db
      .selectFrom('proactive_messages')
      .select('id')
      .where('kind', '=', 'email_digest')
      .where('persona_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
