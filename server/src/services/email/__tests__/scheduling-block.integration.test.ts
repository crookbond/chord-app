/**
 * ADR 0346 phase 2 - the scheduling block: read by the model, finished in
 * code, stored per thread, acted on by nothing yet.
 *
 * Shapes from the recordings: Rob's "mostly free tomorrow from 10-1. Anything
 * work for you?" (17 Nov 2026), and an assistant arranging a call for her
 * principal with a Zoom link already in the mail, the user on Cc.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { finishScheduling, parseScheduling } from '@/services/email/scheduling-block.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const ME = 'john@example.com';
const ROB = 'Hi John,\nI am mostly free tomorrow from 10-1. Anything work for you?\n\nBest\nRob';

describe('parseScheduling', () => {
  it('reads the block beside the items', () => {
    const b = parseScheduling(
      '{"items":[],"scheduling":{"act":"offer_slots","writer":"principal","inviteBy":"unknown","format":"unknown","offered":["tomorrow from 10-1"],"title":"Catch up with Rob"}}',
    );
    expect(b).toMatchObject({ act: 'offer_slots', offered: ['tomorrow from 10-1'], title: 'Catch up with Rob' });
  });

  it('drops a block whose act is not one it knows, and mail with none', () => {
    expect(parseScheduling('{"scheduling":{"act":"schedule"}}')).toBeNull();
    expect(parseScheduling('{"items":[]}')).toBeNull();
    expect(parseScheduling('nope')).toBeNull();
  });

  it('a malformed field falls back to unknown, never a guess', () => {
    expect(readSchedulingBlock({ act: 'agree', inviteBy: 'sure', format: 'zoom call' })).toMatchObject({
      inviteBy: 'unknown',
      format: 'unknown',
    });
  });
});

describe('finishScheduling', () => {
  const msg = {
    bodyText: ROB,
    fromEmail: 'rob@acme.com',
    fromName: 'Rob Smith',
    toEmails: [ME],
    ccEmails: [],
    sentDay: '2026-11-16',
  };

  it('reads the quoted window into a date and time in code', () => {
    const facts = finishScheduling(
      readSchedulingBlock({ act: 'offer_slots', offered: ['tomorrow from 10-1'] })!,
      msg,
      [ME],
    );
    expect(facts.offered).toEqual([expect.objectContaining({ text: 'tomorrow from 10-1', day: '2026-11-17' })]);
    expect(facts.addressed).toBe('to');
  });

  it('reads the time from the message itself when the model quoted none', () => {
    const facts = finishScheduling(readSchedulingBlock({ act: 'ask_times', offered: [] })!, msg, [ME]);
    expect(facts.act).toBe('offer_slots');
    expect(facts.offered[0]).toMatchObject({ day: '2026-11-17', minutes: 600, endMinutes: 780 });
  });

  it('on Cc only the scheduling is someone else\'s, unless something was asked of the user', () => {
    const cc = { ...msg, toEmails: ['tom@x.com'], ccEmails: [ME] };
    const block = readSchedulingBlock({ act: 'ask_times' })!;
    expect(finishScheduling(block, cc, [ME]).act).toBe('fyi');
    expect(finishScheduling(block, cc, [ME], { askedOfUser: true }).act).toBe('offer_slots');
  });

  it('a join link in the email settles the format and the assistant becomes an address', () => {
    const facts = finishScheduling(
      readSchedulingBlock({
        act: 'offer_slots',
        writer: 'assistant',
        onBehalfOf: 'Omar',
        inviteBy: 'them',
        inviteEvidence: 'I will send the invite',
        format: 'unknown',
        offered: ['11/18: 10:30 AM - 12:00 PM PT'],
        assistants: ['Ana'],
      })!,
      {
        bodyText: 'Omar can do 11/18: 10:30 AM - 12:00 PM PT. Join: https://acme.zoom.us/j/123456789 - I will send the invite.',
        fromEmail: 'ana@acme.com',
        fromName: 'Ana Lee',
        toEmails: ['omar@acme.com'],
        ccEmails: [ME],
        sentDay: '2026-11-05',
      },
      [ME],
    );
    expect(facts).toMatchObject({
      writer: 'assistant',
      inviteBy: 'them',
      format: 'video',
      link: { provider: 'zoom' },
      notCore: ['ana@acme.com'],
      addressed: 'cc',
    });
    expect(facts.offered[0]).toMatchObject({ day: '2026-11-18', minutes: 630, endMinutes: 720, timeZone: 'America/Los_Angeles' });
  });
});

describe('the suggestion pass stores the block', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sched');
    await db
      .updateTable('users')
      .set({ email: ME, last_tz: 'America/New_York' })
      .where('id', '=', userId)
      .execute();
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  async function seed(gid: string): Promise<string> {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Catch up',
        snippet: 'I am mostly free tomorrow',
        from_email: 'rob@acme.com',
        from_name: 'Rob Smith',
        last_message_at: now,
        created_at: now,
        updated_at: now,
        is_unread: 1,
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
        subject: 'Catch up',
        snippet: 'I am mostly free tomorrow',
        from_email: 'rob@acme.com',
        from_name: 'Rob Smith',
        to_emails: JSON.stringify([ME]),
        cc_emails: JSON.stringify([]),
        body_excerpt: ROB,
        ics_text: '',
        is_unread: 1,
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:work', parentId: null, title: 'Work', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:work' }],
    });
    return threadRow;
  }

  it('keeps what the model read, finished in code', async () => {
    const threadRow = await seed('t_rob');
    const extractor: EmailExtractor = {
      async extract(input) {
        input.onScheduling?.(
          readSchedulingBlock({
            act: 'offer_slots',
            inviteBy: 'unknown',
            offered: ['tomorrow from 10-1'],
            title: 'Catch up with Rob',
          })!,
        );
        return null;
      },
    };
    await runEmailMagics(db, userId, { extractor });
    const row = await db
      .selectFrom('email_threads')
      .select('scheduling_json')
      .where('id', '=', threadRow)
      .executeTakeFirstOrThrow();
    expect(row.scheduling_json).toMatchObject({
      act: 'offer_slots',
      title: 'Catch up with Rob',
      addressed: 'to',
      offered: [expect.objectContaining({ text: 'tomorrow from 10-1' })],
    });
    expect(row.scheduling_json?.offered[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Stored only: no card from the block.
    const proposals = await db.selectFrom('proposals').select('id').where('proposed_by_user_id', '=', userId).execute();
    expect(proposals).toHaveLength(0);
  });
});
