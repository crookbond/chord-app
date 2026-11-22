/**
 * A reply finishes the "reply to …" to-do (ADR 0314).
 *
 * Reported: after answering an email, its "Reply to Sarah…" card stayed in
 * Action Items. Nothing on the reply path touched the thread's suggestions
 * (only Trash did, ADR 0073/0143), so a pending card waited out its 72h and
 * then counted as "still owed" (ADR 0134), and a confirmed, undated reply
 * to-do was never auto-archived (ADR 0092) and stayed open for good.
 *
 * Every case goes through `recomputeThread`, the step every provider's sync
 * and every Chord send pass through, so the reply is seen however it was sent.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { answeredSince } from '@/services/email/reply-todos.js';
import { runVacationReplies, setVacation } from '@/services/email/vacation.service.js';
import { buildReplyRaw, isAutoSubmitted } from '@/services/google/gmail-sync.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { createTask } from '@/services/tasks.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const MIN = 60_000;
const ago = (mins: number) => new Date(Date.now() - mins * MIN).toISOString();

const REPLY_TITLE = 'Reply to Sarah with times that work for coffee';
const SARAH = { fromName: 'Sarah Chen', fromEmail: 'sarah.chen@example.com' };

describe('a reply closes the reply to-do', () => {
  let db: Kysely<DB>;
  let uid: string;
  let personal: string;

  beforeEach(async () => {
    db = await openTestDb();
    __resetGmailMock();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
    uid = await createUser(db, 'alice');
    personal = (await ensurePersonalGroup(db, uid)).id;
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  /** Sarah asks for a time; returns her provider thread id. */
  async function sarahAsks(at = ago(30)): Promise<string> {
    const gid = `t_${newId('x')}`;
    await seedSyncedMail(db, uid, {
      ...SARAH,
      gmailThreadId: gid,
      subject: 'Coffee next week?',
      snippet: 'When are you free for coffee next week?',
      body: 'When are you free for coffee next week?',
      labels: ['INBOX', 'UNREAD'],
      at,
    });
    return gid;
  }

  async function userReplies(gid: string, at = new Date().toISOString(), to = SARAH.fromEmail): Promise<void> {
    await seedSyncedMail(db, uid, {
      fromName: 'Alice',
      fromEmail: 'alice@example.com',
      toEmails: [to],
      gmailThreadId: gid,
      subject: 'Re: Coffee next week?',
      snippet: 'Tuesday at 2 works',
      body: 'Tuesday at 2 works',
      labels: ['SENT'],
      at,
    });
  }

  async function sarahWritesAgain(gid: string, at = new Date().toISOString()): Promise<void> {
    await seedSyncedMail(db, uid, {
      ...SARAH,
      gmailThreadId: gid,
      subject: 'Re: Coffee next week?',
      snippet: 'Tuesday is out, can you do Thursday?',
      labels: ['INBOX', 'UNREAD'],
      at,
    });
  }

  const card = async (gid: string, title: string, closesOnReply: boolean) =>
    createProposal(db, {
      groupId: personal,
      proposedByUserId: uid,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title, ...(closesOnReply ? { closesOnReply: true } : {}) },
      provenance: `gmail:${gid}`,
    });

  const todo = async (gid: string, title: string, closesOnReply: boolean) =>
    createTask(db, {
      groupId: personal,
      createdBy: uid,
      title,
      sourceRawContext: `gmail:${gid}`,
      closesOnReply,
    });

  const proposalStatus = async (id: string) =>
    (await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow())
      .status;
  const taskRow = async (id: string) =>
    db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('withdraws the pending reply card when the user replies', async () => {
    const gid = await sarahAsks();
    const p = await card(gid, REPLY_TITLE, true);

    await userReplies(gid);

    expect(await proposalStatus(p.id)).toBe('expired');
  });

  it('marks a confirmed reply to-do done, not archived', async () => {
    const gid = await sarahAsks();
    const t = await todo(gid, REPLY_TITLE, true);

    await userReplies(gid);

    const row = await taskRow(t.id);
    expect(row.status).toBe('done');
    expect(row.completed_at).not.toBeNull();
  });

  it('leaves the thread’s other to-dos and cards alone', async () => {
    // Replying "will do" does not return the slip.
    const gid = await sarahAsks();
    const slipCard = await card(gid, 'Return the permission slip', false);
    const slip = await todo(gid, 'Return the permission slip', false);

    await userReplies(gid);

    expect(await proposalStatus(slipCard.id)).toBe('pending');
    expect((await taskRow(slip.id)).status).toBe('open');
  });

  it('keeps a reply to-do open until the reply it asks for arrives', async () => {
    const gid = await sarahAsks();
    const t = await todo(gid, REPLY_TITLE, true);

    // Another message from Sarah is not an answer.
    await sarahWritesAgain(gid);

    expect((await taskRow(t.id)).status).toBe('open');
  });

  it('an earlier reply does not answer a question asked after it', async () => {
    // Sarah asks, the user answers, Sarah asks again; the to-do made from
    // the second question is still owed.
    const gid = await sarahAsks(ago(60));
    await userReplies(gid, ago(40));
    await sarahWritesAgain(gid, ago(20));
    const t = await todo(gid, 'Reply to Sarah about Thursday instead', true);
    await sarahWritesAgain(gid, ago(1)); // any later recompute of the thread

    expect((await taskRow(t.id)).status).toBe('open');

    await userReplies(gid);
    expect((await taskRow(t.id)).status).toBe('done');
  });

  it('does not touch another user’s reply to-do in a thread with the same id', async () => {
    const bob = await createUser(db, 'bob');
    const gid = await sarahAsks();
    const bobs = await createTask(db, {
      groupId: (await ensurePersonalGroup(db, bob)).id,
      createdBy: bob,
      title: REPLY_TITLE,
      sourceRawContext: `gmail:${gid}`,
      closesOnReply: true,
    });

    await userReplies(gid);

    expect((await taskRow(bobs.id)).status).toBe('open');
  });

  describe('cards and to-dos made before the mark existed', () => {
    // Prod, 2026-10-31: the user wrote first, Irene answered, and a card
    // staged before ADR 0314 shipped (no `closesOnReply`) stayed after the
    // user's reply.
    const IRENE = { fromName: 'Baker, Irene (NYC)', fromEmail: 'baker.irene@bcg.com' };
    const TITLE = 'Reply to Irene with times that work for a 10-15 mins call next week';

    async function thread(): Promise<string> {
      const gid = `t_${newId('x')}`;
      await seedSyncedMail(db, uid, {
        fromName: 'Alice',
        fromEmail: 'alice@example.com',
        toEmails: [IRENE.fromEmail],
        gmailThreadId: gid,
        subject: 'Catchup',
        snippet: 'Hi IP - lmk when you have time sometime for a 10-15 mins call.',
        labels: ['SENT'],
        at: ago(23 * 60),
      });
      await seedSyncedMail(db, uid, {
        ...IRENE,
        gmailThreadId: gid,
        subject: 'Re: Catchup',
        snippet: 'Yes, next week? Best, Irene',
        labels: ['INBOX'],
        at: ago(22 * 60),
      });
      return gid;
    }

    it('withdraws an unmarked reply card when the user replies', async () => {
      const gid = await thread();
      const p = await card(gid, TITLE, false);

      await userReplies(gid, undefined, IRENE.fromEmail);

      expect(await proposalStatus(p.id)).toBe('expired');
    });

    it('marks an unmarked reply to-do done', async () => {
      const gid = await thread();
      const t = await todo(gid, TITLE, false);

      await userReplies(gid, undefined, IRENE.fromEmail);

      expect((await taskRow(t.id)).status).toBe('done');
    });

    it('still leaves an unmarked to-do that is not a reply', async () => {
      const gid = await thread();
      const p = await card(gid, 'Send Irene the product deck', false);

      await userReplies(gid, undefined, IRENE.fromEmail);

      expect(await proposalStatus(p.id)).toBe('pending');
    });
  });

  it('clears the reply-needed badge once the newest message is the user’s', async () => {
    const gid = await sarahAsks();
    await db
      .updateTable('email_threads')
      .set({ action: 'reply_needed' })
      .where('gmail_thread_id', '=', gid)
      .execute();

    await userReplies(gid);

    const row = await db
      .selectFrom('email_threads')
      .select('action')
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe('other');
  });

  describe('an automatic reply is not the user answering', () => {
    // Audit: Chord's own vacation responder (ADR 0124) sends a SENT message
    // into the thread, and any SENT message after the ask counted as the
    // reply - so going on holiday closed every "Reply to ..." to-do and
    // cleared every reply-needed badge.
    async function onHoliday(): Promise<void> {
      await setVacation(db, uid, {
        enabled: true,
        subject: null,
        body: 'I am away until Monday.',
        startsAt: ago(120),
        endsAt: null,
      });
    }

    it('the vacation reply leaves the reply to-do and card open', async () => {
      await onHoliday();
      const gid = await sarahAsks();
      const t = await todo(gid, REPLY_TITLE, true);
      const p = await card(gid, REPLY_TITLE, true);

      expect(await runVacationReplies(db, uid)).toBe(1);

      const sent = await db
        .selectFrom('email_messages')
        .select(['auto_reply', 'gmail_label_ids'])
        .where('gmail_thread_id', '=', gid)
        .where(sql<boolean>`gmail_label_ids @> '["SENT"]'::jsonb`)
        .execute();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.auto_reply).toBe(1);
      expect((await taskRow(t.id)).status).toBe('open');
      expect(await proposalStatus(p.id)).toBe('pending');

      // The user's own reply still closes it.
      await userReplies(gid);
      expect((await taskRow(t.id)).status).toBe('done');
    });

    it('the vacation reply keeps the reply-needed badge, in recompute and ingest', async () => {
      await onHoliday();
      const gid = await sarahAsks();
      await db
        .updateTable('email_threads')
        .set({ action: 'reply_needed' })
        .where('gmail_thread_id', '=', gid)
        .execute();

      await runVacationReplies(db, uid);
      const action = async () =>
        (
          await db
            .selectFrom('email_threads')
            .select('action')
            .where('gmail_thread_id', '=', gid)
            .executeTakeFirstOrThrow()
        ).action;
      expect(await action()).toBe('reply_needed');

      await ingestClassification(db, uid, {
        version: 1,
        userId: uid,
        categories: [{ id: 'friends', parentId: null, title: 'Friends & family', depth: 0 }],
        assignments: [{ gmailThreadId: gid, categoryId: 'friends', action: 'reply_needed' }],
      });
      expect(await action()).toBe('reply_needed');
    });

    it('the outgoing auto-reply says Auto-Submitted, and sync reads it back', () => {
      const raw = buildReplyRaw({
        fromEmail: 'alice@example.com',
        to: ['sarah.chen@example.com'],
        subject: 'Re: Coffee',
        inReplyTo: null,
        references: null,
        body: 'Away',
        autoSubmitted: true,
      });
      const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      expect(text).toMatch(/^Auto-Submitted: auto-replied$/m);
      expect(isAutoSubmitted('auto-replied')).toBe(true);
      expect(isAutoSubmitted('No')).toBe(false);
      expect(isAutoSubmitted(null)).toBe(false);
    });
  });

  describe('a forward is not the user answering', () => {
    // Audit follow-up: forwarding Sarah's email to someone else (from Gmail,
    // where the forward lands in the same thread with SENT) counted as the
    // reply - the "Reply to Sarah" to-do closed and the badge cleared, though
    // Sarah never heard back.
    async function userForwards(gid: string, at = new Date().toISOString()): Promise<void> {
      await seedSyncedMail(db, uid, {
        fromName: 'Alice',
        fromEmail: 'alice@example.com',
        toEmails: ['Bob Partner <bob.partner@example.com>'],
        gmailThreadId: gid,
        subject: 'Fwd: Coffee next week?',
        snippet: 'Can you check our calendar?',
        labels: ['SENT'],
        at,
      });
    }

    it('leaves the reply to-do and card open, and the badge on', async () => {
      const gid = await sarahAsks();
      const t = await todo(gid, REPLY_TITLE, true);
      const p = await card(gid, REPLY_TITLE, true);
      await db.updateTable('email_threads').set({ action: 'reply_needed' }).where('gmail_thread_id', '=', gid).execute();

      await userForwards(gid);

      expect((await taskRow(t.id)).status).toBe('open');
      expect(await proposalStatus(p.id)).toBe('pending');
      const action = async () =>
        (await db.selectFrom('email_threads').select('action').where('gmail_thread_id', '=', gid).executeTakeFirstOrThrow())
          .action;
      expect(await action()).toBe('reply_needed');
      await ingestClassification(db, uid, {
        version: 1,
        userId: uid,
        categories: [{ id: 'friends', parentId: null, title: 'Friends & family', depth: 0 }],
        assignments: [{ gmailThreadId: gid, categoryId: 'friends', action: 'reply_needed' }],
      });
      expect(await action()).toBe('reply_needed');

      // Replying to Sarah afterwards still closes it.
      await userReplies(gid);
      expect((await taskRow(t.id)).status).toBe('done');
      expect(await action()).toBe('other');
    });

    it('a reply-all that copies Sarah still counts', async () => {
      const gid = await sarahAsks();
      const t = await todo(gid, REPLY_TITLE, true);

      await seedSyncedMail(db, uid, {
        fromName: 'Alice',
        fromEmail: 'alice@example.com',
        toEmails: ['bob.partner@example.com'],
        ccEmails: ['Sarah Chen <SARAH.CHEN@example.com>'],
        gmailThreadId: gid,
        subject: 'Re: Coffee next week?',
        snippet: 'Tuesday at 2 works for both of us',
        labels: ['SENT'],
        at: new Date().toISOString(),
      });

      expect((await taskRow(t.id)).status).toBe('done');
    });
  });

  it('a classifier pass after the reply cannot put the badge back', async () => {
    const gid = await sarahAsks();
    await userReplies(gid);

    await ingestClassification(db, uid, {
      version: 1,
      userId: uid,
      categories: [{ id: 'friends', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'friends', action: 'reply_needed' }],
    });

    const row = await db
      .selectFrom('email_threads')
      .select('action')
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe('other');
  });

  describe('staging', () => {
    const replyStub: EmailExtractor = {
      async extract() {
        // The title alone marks it (the model may leave out the flag).
        return { kind: 'task', title: REPLY_TITLE };
      },
    };

    async function classify(gid: string) {
      await ingestClassification(db, uid, {
        version: 1,
        userId: uid,
        categories: [{ id: 'friends', parentId: null, title: 'Friends & family', depth: 0 }],
        assignments: [{ gmailThreadId: gid, categoryId: 'friends' }],
      });
    }

    const cards = async () =>
      db
        .selectFrom('proposals')
        .select(['args_json'])
        .where('proposed_by_user_id', '=', uid)
        .where('tool_name', '=', 'create_task')
        .execute();

    it('stages the reply card marked to close on reply', async () => {
      // Control: without it the case below would pass having mined nothing.
      const gid = await sarahAsks();
      await classify(gid);

      await runEmailMagics(db, uid, { extractor: replyStub });

      const rows = await cards();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.args_json)).toMatchObject({
        title: REPLY_TITLE,
        closesOnReply: true,
      });
    });

    it('stages no reply card for mail the user already answered', async () => {
      const gid = await sarahAsks(ago(30));
      await userReplies(gid, ago(10));
      await classify(gid);

      await runEmailMagics(db, uid, { extractor: replyStub });

      expect(await cards()).toHaveLength(0);
    });

    it('the closing flag reaches the to-do a confirm creates', async () => {
      const gid = await sarahAsks();
      await classify(gid);
      await runEmailMagics(db, uid, { extractor: replyStub });
      const p = await db
        .selectFrom('proposals')
        .select('id')
        .where('proposed_by_user_id', '=', uid)
        .executeTakeFirstOrThrow();

      const res = await confirmProposal(db, { id: p.id, resolvedByUserId: uid });
      expect(res.ok).toBe(true);
      const t = await db
        .selectFrom('tasks')
        .select(['id', 'closes_on_reply'])
        .where('source_raw_context', '=', `gmail:${gid}`)
        .executeTakeFirstOrThrow();
      expect(t.closes_on_reply).toBe(1);

      await userReplies(gid);
      expect((await taskRow(t.id)).status).toBe('done');
    });
  });
});

describe('answeredSince', () => {
  const m = (at: string, ...labelIds: string[]) => ({ internalDate: at, labelIds });

  it('needs a sent message after the latest ask', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    expect(answeredSince([m('2026-10-30T10:00:00Z', 'INBOX')], now)).toBe(false);
    expect(
      answeredSince([m('2026-10-30T10:00:00Z', 'INBOX'), m('2026-10-30T11:00:00Z', 'SENT')], now),
    ).toBe(true);
    expect(
      answeredSince(
        [m('2026-10-30T09:00:00Z', 'INBOX'), m('2026-10-30T10:00:00Z', 'SENT'), m('2026-10-30T11:00:00Z', 'INBOX')],
        now,
      ),
    ).toBe(false);
  });

  it('ignores drafts and trashed replies', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    const ask = m('2026-10-30T10:00:00Z', 'INBOX');
    expect(answeredSince([ask, m('2026-10-30T11:00:00Z', 'SENT', 'DRAFT')], now)).toBe(false);
    expect(answeredSince([ask, m('2026-10-30T11:00:00Z', 'SENT', 'TRASH')], now)).toBe(false);
  });

  it('ignores an automatic reply', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    const ask = m('2026-10-30T10:00:00Z', 'INBOX');
    const auto = { ...m('2026-10-30T11:00:00Z', 'SENT'), autoReply: true };
    expect(answeredSince([ask, auto], now)).toBe(false);
  });

  it('a sent message to someone else is a forward, not an answer', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    const ask = { ...m('2026-10-30T10:00:00Z', 'INBOX'), from: 'sarah@example.com', replyTo: 'help@school.org' };
    const sent = (to: string[]) => ({ ...m('2026-10-30T11:00:00Z', 'SENT'), to });
    expect(answeredSince([ask, sent(['bob@example.com'])], now)).toBe(false);
    expect(answeredSince([ask, sent(['Sarah <sarah@example.com>'])], now)).toBe(true);
    expect(answeredSince([ask, sent(['help@school.org'])], now)).toBe(true); // her Reply-To
    expect(answeredSince([ask, sent([])], now)).toBe(true); // recipients not known
  });

  it('compares instants, not text', () => {
    // 10:30 -04:00 is 14:30Z, after the 12:00Z ask, though it sorts before it.
    const ask = m('2026-10-30T12:00:00Z', 'INBOX');
    const reply = m('2026-10-30T10:30:00-04:00', 'SENT');
    expect(answeredSince([ask, reply], Date.parse('2026-10-30T13:00:00Z'))).toBe(true);
  });
});
