/**
 * The bot's `search` tool with a person (ADR 0270), through the executor - the
 * path chat actually takes. Before, a person could only reach search as words
 * in `query`; now `from` / `to` filter by sender or recipient, the tool's local
 * dates are the user's days, and two people with one name come back as a
 * question rather than a guess.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { toolSchemas } from '@/services/bot/tools.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const ME = 'me@family.test';

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'ro');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

const search = async (args: Record<string, unknown>) => {
  const r = await applyToolCall(db, {
    groupId: personalId,
    actorUserId: userId,
    provenance: null,
    mode: 'commit',
    tz: 'America/New_York',
    call: { name: 'search', args: toolSchemas.search.parse(args) } as never,
  });
  return r.data as { emails: Array<{ subject: string }>; people?: Array<{ status: string; candidates: Array<{ name: string | null }> }>; instruction: string };
};

describe('filters the model added on its own (ADR 0279)', () => {
  // Prod 2026-10-20: "Show me emails from mallory" was called with every
  // optional filter filled in, emailKind "delivery" among them, and the bot
  // said there was no mail from him.
  it('finds the person when the user named only the person', async () => {
    await seedSyncedMail(db, userId, { subject: 'Board meeting notes', fromName: 'Steve Mallory', fromEmail: 'fake.one@gmail.com', toEmails: [ME] });
    const triggeringMessageId = 'm_mallory';
    await db.insertInto('messages').values({
      id: triggeringMessageId,
      group_id: personalId,
      sender_id: userId,
      kind: 'text',
      body: 'Show me emails from mallory',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 1,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    }).execute();
    const r = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      tz: 'America/New_York',
      triggeringMessageId,
      call: {
        name: 'search',
        args: toolSchemas.search.parse({
          after: '2026-09-01',
          before: '2026-10-20',
          categories: ['emails'],
          emailAction: ['to_do', 'reply_needed', 'informational', 'other'],
          emailKind: 'delivery',
          from: 'Steve Mallory',
          hasAttachment: false,
          limit: 10,
          query: '',
          to: '',
        }),
      } as never,
    });
    const data = r.data as { emails: Array<{ subject: string }> };
    expect(data.emails.map((e) => e.subject)).toEqual(['Board meeting notes']);
  });
});

describe('search tool with a person', () => {
  it('filters by sender, with the topic in query', async () => {
    await seedSyncedMail(db, userId, { subject: 'Cabin weekend', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', body: 'the lake cabin', toEmails: [ME] });
    await seedSyncedMail(db, userId, { subject: 'Tee time', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME] });
    await seedSyncedMail(db, userId, { subject: 'Your bill is ready', fromName: 'Acme', fromEmail: 'billing@acme.com', body: 'cabin rental bill' });
    const r = await search({ from: 'Bill', query: 'cabin' });
    expect(r.emails.map((e) => e.subject)).toEqual(['Cabin weekend']);
  });

  it('accepts a call with no query at all', async () => {
    await seedSyncedMail(db, userId, { subject: 'Tee time', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME] });
    const r = await search({ from: 'Bill Smith' });
    expect(r.emails.map((e) => e.subject)).toEqual(['Tee time']);
  });

  it('asks which person when two match', async () => {
    await seedSyncedMail(db, userId, { subject: 'Tee time', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME] });
    await seedSyncedMail(db, userId, { subject: 'Q3 numbers', fromName: 'William Chen', fromEmail: 'wchen@acme-corp.test', toEmails: [ME] });
    const r = await search({ from: 'Bill' });
    expect(r.emails).toEqual([]);
    expect(r.people?.[0]?.status).toBe('ambiguous');
    expect(r.instruction).toMatch(/Ask the user which one/);
  });

  it("reads after/before as the user's own days", async () => {
    // 2026-10-10 23:30 in New York is 2026-10-11 03:30Z: inside "before 10-10" locally.
    await seedSyncedMail(db, userId, { subject: 'Late Saturday note', fromName: 'Ann Lee', fromEmail: 'ann@x.test', toEmails: [ME], at: '2026-10-11T03:30:00.000Z' });
    await seedSyncedMail(db, userId, { subject: 'Sunday note', fromName: 'Ann Lee', fromEmail: 'ann@x.test', toEmails: [ME], at: '2026-10-11T15:00:00.000Z' });
    const r = await search({ from: 'ann@x.test', after: '2026-10-10', before: '2026-10-10' });
    expect(r.emails.map((e) => e.subject)).toEqual(['Late Saturday note']);
  });
});
