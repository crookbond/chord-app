/**
 * Which message a reply answers, and who therefore receives it.
 *
 * The thread is the prod one from 2026-10-01 ("Nolan's recent math quiz"):
 * the teacher wrote to both parents, one parent replied-all, and the other
 * then tried to answer the TEACHER from Chord. The first attempt went only to
 * the other parent (Chord answered the newest message, not the one being
 * read); the second, a "reply all", went To: himself, Cc: the other parent -
 * Chord had picked his own just-sent message as the one being answered. The
 * teacher was on neither.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickReplyTarget, replyRecipients, type EmailMessage } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import type { NormalizedMessage } from '@/services/google/gmail-sync.js';
import {
  ensureThreadRow,
  getThread,
  recomputeThread,
  sendReply,
  upsertMessageMeta,
} from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TEACHER = 'mhill@lakesideschool.org';
const SPOUSE = 'family.two@yahoo.com';
const ME = 'ownertest@gmail.com';

const msg = (
  id: string,
  from: string,
  to: string[],
  sent = false,
): Pick<EmailMessage, 'id' | 'fromEmail' | 'toEmails' | 'ccEmails' | 'sent'> => ({
  id,
  fromEmail: from,
  toEmails: to,
  ccEmails: [],
  sent,
});

const fromTeacher = msg('m1', TEACHER, [SPOUSE, ME]);
const fromSpouse = msg('m2', SPOUSE, [ME, TEACHER]);
const myFirstReply = msg('m3', ME, [SPOUSE], true);

describe('reply recipients on the math-quiz thread', () => {
  it('reply all to the message the reader picked reaches everyone on THAT message', () => {
    expect(replyRecipients(fromTeacher, { replyAll: true, myEmail: ME })).toEqual({
      to: [TEACHER],
      cc: [SPOUSE],
    });
  });

  it('does not pick my own sent message when my address is unknown', () => {
    // The 9:31 send: the composer had no usable "my address", so the address
    // test alone let the user's own message through as the one to answer.
    const target = pickReplyTarget([fromTeacher, fromSpouse, myFirstReply], null);
    expect(target?.id).toBe('m2');
    expect(replyRecipients(target, { replyAll: true, myEmail: null }).to).not.toContain(ME);
  });

  it('answering my own message goes to the people I sent it to, never to me', () => {
    for (const myEmail of [ME, null]) {
      const r = replyRecipients(myFirstReply, { replyAll: true, myEmail });
      expect(r).toEqual({ to: [SPOUSE], cc: [] });
    }
  });

  it('a plain reply to my own message still carries no cc', () => {
    const own = { ...msg('m4', ME, [TEACHER], true), ccEmails: [SPOUSE] };
    expect(replyRecipients(own, { replyAll: false, myEmail: ME })).toEqual({ to: [TEACHER], cc: [] });
    expect(replyRecipients(own, { replyAll: true, myEmail: ME })).toEqual({
      to: [TEACHER],
      cc: [SPOUSE],
    });
  });
});

describe('a reply goes where the sender asked', () => {
  const LIST = 'pta-list@lakesideschool.org';

  it('goes to the Reply-To, and reply all copies the rest', () => {
    const fromList = { ...msg('m5', TEACHER, [SPOUSE, ME]), replyTo: LIST };
    expect(replyRecipients(fromList, { replyAll: false, myEmail: ME })).toEqual({ to: [LIST], cc: [] });
    expect(replyRecipients(fromList, { replyAll: true, myEmail: ME })).toEqual({ to: [LIST], cc: [SPOUSE] });
  });

  it('ignores a Reply-To that is my own address', () => {
    const toMe = { ...msg('m6', TEACHER, [ME]), replyTo: ME };
    expect(replyRecipients(toMe, { replyAll: false, myEmail: ME }).to).toEqual([TEACHER]);
  });

  it('a message I sent still answers to the people I sent it to', () => {
    const mine = { ...msg('m7', ME, [TEACHER], true), replyTo: LIST };
    expect(replyRecipients(mine, { replyAll: false, myEmail: ME }).to).toEqual([TEACHER]);
  });
});

describe('the reply is threaded onto the message it answers', () => {
  let db: Kysely<DB>;
  let userId: string;
  let threadRowId: string;
  let priorProvider: string;
  const ids: Record<string, string> = {};

  const put = async (
    key: string,
    gid: string,
    at: string,
    from: string,
    to: string[],
    labels: string[],
  ) => {
    const nm: NormalizedMessage = {
      gmailMessageId: newId('gm'),
      gmailThreadId: gid,
      fromName: null,
      fromEmail: from,
      toEmails: to,
      ccEmails: [],
      subject: "Nolan's recent math quiz",
      snippet: '',
      bodyText: 'body',
      bodyHtml: null,
      internalDate: at,
      isUnread: false,
      labelIds: labels,
      rfc822MessageId: `<${key}@mail.example>`,
      headers: { references: null, inReplyTo: null, date: null },
      attachmentsJson: '[]',
      icsText: '',
    };
    await upsertMessageMeta(db, userId, threadRowId, nm, at);
    const row = await db
      .selectFrom('email_messages')
      .select('id')
      .where('gmail_message_id', '=', nm.gmailMessageId)
      .executeTakeFirstOrThrow();
    ids[key] = row.id;
  };

  beforeEach(async () => {
    db = await openTestDb();
    // No users.email, as in the incident: only the SENT label says "mine".
    userId = await createUser(db, 'ro');
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    const gid = newId('gt');
    threadRowId = await ensureThreadRow(db, userId, gid, '2026-10-01T12:41:58Z');
    await put('teacher', gid, '2026-10-01T12:41:58Z', TEACHER, [SPOUSE, ME], ['INBOX']);
    await put('spouse', gid, '2026-10-01T12:47:50Z', SPOUSE, [ME, TEACHER], ['INBOX']);
    await put('mine', gid, '2026-10-01T13:29:18Z', ME, [SPOUSE], ['SENT']);
    await recomputeThread(db, userId, gid);
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const lastInReplyTo = async (): Promise<string | null> => {
    const row = await db
      .selectFrom('email_messages')
      .select(['headers_json'])
      .where('thread_id', '=', threadRowId)
      .orderBy('created_at', 'desc')
      .orderBy('internal_date', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return (row.headers_json as { inReplyTo?: string | null }).inReplyTo ?? null;
  };

  it('marks my own message as sent in the thread the reader gets', async () => {
    const detail = await getThread(db, userId, threadRowId);
    expect(detail?.messages.map((m) => m.sent)).toEqual([false, false, true]);
  });

  it('answers the picked message, not the newest', async () => {
    await sendReply(db, userId, {
      threadRowId,
      body: 'Hi Ms Maria',
      to: [TEACHER],
      cc: [SPOUSE],
      messageId: ids.teacher,
    });
    expect(await lastInReplyTo()).toBe('<teacher@mail.example>');
  });

  it('with no audience given, the send goes to the Reply-To', async () => {
    const LIST = 'pta-list@lakesideschool.org';
    await db.updateTable('email_messages').set({ reply_to: LIST }).where('id', '=', ids.spouse).execute();
    await sendReply(db, userId, { threadRowId, body: 'Count us in' });
    const sent = await db
      .selectFrom('email_messages')
      .select('to_emails')
      .where('thread_id', '=', threadRowId)
      .orderBy('created_at', 'desc')
      .orderBy('internal_date', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(sent.to_emails).toEqual([LIST]);
  });

  it('with nothing picked, answers the newest message that is not my own', async () => {
    await sendReply(db, userId, { threadRowId, body: 'Thanks', to: [SPOUSE] });
    expect(await lastInReplyTo()).toBe('<spouse@mail.example>');
  });
});
