/**
 * A conversation is read again when someone answers (ADR 0315).
 *
 * Prod, 2026-11-01: "Catchup" with Irene. His "Yes, next week?" was
 * mined into "Reply to Irene with times..."; you offered "anytime after
 * 10 AM, Thursday, November 5"; he answered "10 AM works - talk then". The
 * thread already carried its once-ever suggestion mark, so that answer was
 * never read and no "Call with Irene" card appeared.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  runEmailMagics,
  runReadTimeEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const callDay = new Date(Date.now() + 4 * 24 * HOUR).toISOString().slice(0, 10);

const GID = '1a18e0d8a7251f10';
const IP = 'Baker.Irene@bcg.com';
const ME = 'ownertest@gmail.com';

const ASKS_FOR_TIME = 'Yes, next week?\n\nBest,\nIrene';
const MY_OFFER =
  'Hi Irene,\n\nThat would be awsome, and really appreciate you making time. How is anytime after 10 AM, Thursday, November 5. Just let me know what works best for you.';
const AGREES = `10 AM works - talk then\n\nBest,\nIrene\n\nFrom: ${ME}\nSubject: Re: Catchup\n\n${MY_OFFER}`;

/** Reads the message the way the model would: an agreed time is an event,
 *  an open ask is a reply to-do, your own offer is nothing. */
const extractor: EmailExtractor = {
  async extract(input) {
    const body = input.bodyText ?? '';
    if (body.startsWith('10 AM works')) {
      if (!input.participants?.includes(IP)) throw new Error('participants line missing');
      return {
        kind: 'event',
        title: 'Call with Irene',
        startsAt: `${callDay}T10:00:00-05:00`,
        invite: 'sender',
      };
    }
    if (body.startsWith('Yes, next week?')) {
      return { kind: 'task', title: 'Reply to Irene with times that work for a call', reply: true };
    }
    return null;
  },
};

describe('a newer message re-opens the thread for suggestions', () => {
  let db: Kysely<DB>;
  let userId: string;
  let threadId: string;

  beforeEach(async () => {
    db = await openTestDb();
    __resetGmailMock();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
    userId = await createUser(db, 'remine-user');
    await ensurePersonalGroup(db, userId);
    threadId = newId('emt');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: GID,
        subject: 'Re: Catchup',
        snippet: 'Yes, next week?',
        from_email: IP,
        from_name: 'Irene Baker',
        last_message_at: ago(48),
        is_unread: 1,
        is_archived: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'personal', parentId: null, title: 'Personal', depth: 0 }],
      assignments: [{ gmailThreadId: GID, categoryId: 'personal' }],
    });
    await addMessage('m1', IP, ASKS_FOR_TIME, ago(48), ['INBOX', 'UNREAD']);
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  async function addMessage(mid: string, from: string, body: string, at: string, labels: string[]) {
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: mid,
        gmail_thread_id: GID,
        from_name: null,
        from_email: from,
        to_emails: JSON.stringify([from === ME ? IP : ME]),
        cc_emails: JSON.stringify([]),
        subject: 'Re: Catchup',
        snippet: body.slice(0, 80),
        body_text: body,
        body_html: null,
        internal_date: at,
        is_unread: labels.includes('UNREAD') ? 1 : 0,
        gmail_label_ids: JSON.stringify(labels),
        rfc822_message_id: null,
        headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
        created_at: at,
      })
      .execute();
    await db
      .updateTable('email_threads')
      .set({ last_message_at: at, snippet: body.slice(0, 80) })
      .where('id', '=', threadId)
      .execute();
    __addGmailMockMessage(userId, {
      id: mid,
      threadId: GID,
      labelIds: labels,
      snippet: body.slice(0, 80),
      internalDate: String(Date.parse(at)),
      historyId: '1',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Re: Catchup' }],
        body: { size: body.length, data: Buffer.from(body).toString('base64url') },
      },
    });
  }

  /** The first pass ran when "Yes, next week?" arrived, not just now. */
  async function backdateMarksAndCards(at: string) {
    await db.updateTable('email_extraction_marks').set({ created_at: at }).where('user_id', '=', userId).execute();
    await db.updateTable('proposals').set({ created_at: at }).where('proposed_by_user_id', '=', userId).execute();
  }

  const cards = () =>
    db
      .selectFrom('proposals')
      .select(['tool_name', 'status', 'args_json'])
      .where('proposed_by_user_id', '=', userId)
      .orderBy('created_at')
      .execute();

  it('stages the agreed call and withdraws the stale reply card', async () => {
    expect((await runEmailMagics(db, userId, { extractor })).tasks).toBe(1);
    await backdateMarksAndCards(ago(47));

    // Your own offer does not reopen the thread.
    await addMessage('m2', ME, MY_OFFER, ago(24), ['SENT']);
    expect((await runEmailMagics(db, userId, { extractor })).processed).toBe(0);

    await addMessage('m3', IP, AGREES, ago(1), ['INBOX', 'UNREAD']);
    const res = await runEmailMagics(db, userId, { extractor });
    expect(res.events).toBe(1);

    const all = await cards();
    expect(all.map((c) => [c.tool_name, c.status])).toEqual([
      ['create_task', 'expired'],
      ['create_event', 'pending'],
    ]);
    const args = JSON.parse(all[1]!.args_json) as { title: string; startsAt: string; invitees?: string[] };
    expect(args.title).toBe('Call with Irene');
    expect(args.startsAt).toContain(`${callDay}T10:00:00`);
    // The address comes from his From line, not from the model.
    expect(args.invitees).toEqual(['baker.irene@bcg.com']);

    // Read once per message: the same answer is not mined again.
    expect((await runEmailMagics(db, userId, { extractor })).processed).toBe(0);
  });

  it('confirming tells the personal chat what the calendar did, with an edit link', async () => {
    await runEmailMagics(db, userId, { extractor });
    await backdateMarksAndCards(ago(47));
    await addMessage('m3', IP, AGREES, ago(1), ['INBOX', 'UNREAD']);
    await runEmailMagics(db, userId, { extractor });
    const card = await db
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();

    expect((await confirmProposal(db, { id: card.id, resolvedByUserId: userId })).ok).toBe(true);

    const personal = await ensurePersonalGroup(db, userId);
    const notice = await db
      .selectFrom('messages')
      .leftJoin('message_cards', 'message_cards.message_id', 'messages.id')
      .select(['messages.body', 'messages.kind', 'message_cards.cards_json'])
      .where('messages.group_id', '=', personal.id)
      .where('messages.kind', '=', 'system')
      .executeTakeFirstOrThrow();
    // ADR 0348 — ✓ adds the meeting and invites nobody; the message says so
    // and names who could be invited.
    expect(notice.body).toContain('Added "Call with Irene"');
    expect(notice.body).toContain('No invitations were sent');
    expect(notice.body).toContain('baker.irene@bcg.com');
    const event = await db.selectFrom('events').select('id').where('title', '=', 'Call with Irene').executeTakeFirstOrThrow();
    const cards = JSON.parse(notice.cards_json ?? '[]') as Array<{ href?: string }>;
    expect(cards[0]?.href).toBe(`/calendar?event=${event.id}`);
  });

  it('the read-time pass reads the newer message on open too', async () => {
    await runReadTimeEmailMagics(db, userId, threadId, { extractor });
    await backdateMarksAndCards(ago(47));
    await addMessage('m3', IP, AGREES, ago(1), ['INBOX', 'UNREAD']);

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor });
    expect(res.ranNow).toBe(true);
    expect((await cards()).map((c) => [c.tool_name, c.status])).toEqual([
      ['create_task', 'expired'],
      ['create_event', 'pending'],
    ]);
  });
});
