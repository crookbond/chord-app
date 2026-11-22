/**
 * ADR 0319 addendum — moving mail already in the inbox has to be asked for.
 *
 * ADR 0309's filing rule files only mail arriving from now on; `alsoExisting`
 * also moves what is already sitting in the inbox. It was a plain optional
 * boolean, and ADR 0229's addendum records that models fill those in — so
 * "send mail from the school into School" could stage a card offering to move
 * two hundred existing messages, under a main sentence that is exactly right.
 * Both cards do say "new and existing mail", which is why this is a weaker
 * case than `confirmPast` and still worth closing: the user taps because the
 * sentence they asked for is correct.
 *
 * Decided at staging, so the card states what will actually happen.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('add_mail_filter alsoExisting (ADR 0319 addendum)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    // One thread from the school, so `resolveFilterFrom` has a domain to match.
    const threadId = newId('et');
    const at = new Date(Date.now() - 86_400_000).toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: newId('gt'),
        subject: 'Term dates',
        snippet: '',
        from_name: 'Lakeside School',
        from_email: 'office@school.org',
        last_message_at: at,
        message_count: 1,
        is_unread: 0,
        is_archived: 0,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: at,
        updated_at: at,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: newId('gt2'),
        gmail_message_id: newId('gm'),
        from_name: 'Lakeside School',
        from_email: 'office@school.org',
        to_emails: JSON.stringify(['ro@example.com']),
        cc_emails: JSON.stringify([]),
        subject: 'Term dates',
        snippet: '',
        gmail_label_ids: JSON.stringify(['INBOX']),
        internal_date: at,
        created_at: at,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const say = async (body: string): Promise<string> =>
    (await insertMessage(db, { groupId: personalId, senderId: userId, body })).id;

  const stage = (args: Record<string, unknown>, triggeringMessageId?: string) =>
    applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      ...(triggeringMessageId ? { triggeringMessageId } : {}),
      call: { name: 'add_mail_filter', args } as never,
    });

  /** What actually got staged for the tap to run. */
  const stagedArgs = async (): Promise<Record<string, unknown>> => {
    const row = await db
      .selectFrom('proposals')
      .select('args_json')
      .where('tool_name', '=', 'add_mail_filter')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    return JSON.parse(row.args_json) as Record<string, unknown>;
  };

  it('the reported case: nobody asked about existing mail, so only new mail is staged', async () => {
    const res = await stage(
      { from: 'school.org', folder: 'School', alsoExisting: true },
      await say('@Chord send emails from school.org to a folder called School'),
    );

    expect(await stagedArgs()).toMatchObject({ alsoExisting: false });
    // And the card says so, rather than offering a move nobody mentioned.
    expect(res.card?.meta).toContain('new mail from now on');
  });

  it('honours it when the user asked for the mail already there', async () => {
    const res = await stage(
      { from: 'school.org', folder: 'School', alsoExisting: true },
      await say('@Chord file mail from school.org into School, and move the ones already in my inbox'),
    );

    expect(await stagedArgs()).toMatchObject({ alsoExisting: true });
    expect(res.card?.meta).toContain('new and existing mail');
  });

  it('honours "the old ones too"', async () => {
    await stage(
      { from: 'school.org', folder: 'School', alsoExisting: true },
      await say('@Chord put school.org mail in School — the old ones too please'),
    );
    expect(await stagedArgs()).toMatchObject({ alsoExisting: true });
  });

  it('with no message to read, the field is taken as given', async () => {
    await stage({ from: 'school.org', folder: 'School', alsoExisting: true });
    expect(await stagedArgs()).toMatchObject({ alsoExisting: true });
  });

  it('leaves a plain filter alone', async () => {
    const res = await stage({ from: 'school.org', folder: 'School' }, await say('@Chord file school.org into School'));
    expect(await stagedArgs()).toMatchObject({ alsoExisting: false });
    expect(res.card?.title).toBe('File mail from school.org into "School"');
  });
});
