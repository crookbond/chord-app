/**
 * ADR 0214 — the email capabilities chat was missing: compose, forward, undo a
 * queued send, read a thread, the briefing's email section, and the
 * per-channel briefing mute.
 *
 * Pinned here: compose/forward STAGE rather than send (only the confirm path
 * reaches the outbox, like reply_to_email), the commit reuses the composer's
 * draft + outbox path (so undo works on it), and everything is personal-only.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { listBriefingChannels } from '@/services/connectors/briefing-channels.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { flushDueSends } from '@/services/email/outbox.service.js';
import { getGmailApi } from '@/services/google/gmail-api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const SIX = [
  'compose_email',
  'forward_email',
  'cancel_email_send',
  'read_email',
  'set_email_digest',
  'set_briefing_channel',
] as const;

describe('email actions from chat (ADR 0214)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let sharedId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    sharedId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
    // 'mock' = Chord may send from the primary Gmail, without a real token.
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const call = (name: string, args: Record<string, unknown>, mode: 'propose' | 'commit', groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode,
      call: { name, args } as never,
    });

  const seedThread = async (owner = userId, subject = 'Field trip Friday'): Promise<string> => {
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 3600_000).toISOString();
    const threadId = newId('et');
    const gid = newId('gt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: owner,
        gmail_thread_id: gid,
        subject,
        snippet: '',
        from_name: 'Ms Chen',
        from_email: 'chen@school.org',
        last_message_at: now,
        created_at: earlier,
        updated_at: now,
      })
      .execute();
    const msg = (id: string, at: string, body: string) =>
      db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: owner,
          thread_id: threadId,
          gmail_thread_id: gid,
          gmail_message_id: id,
          from_name: 'Ms Chen',
          from_email: 'chen@school.org',
          to_emails: JSON.stringify(['ro@example.com']),
          cc_emails: JSON.stringify([]),
          subject,
          snippet: body.slice(0, 40),
          body_text: body,
          body_html: null,
          attachments_json: '[]',
          internal_date: at,
          created_at: at,
        })
        .execute();
    await msg(`${gid}_1`, earlier, 'Permission slips are due Thursday.');
    await msg(
      `${gid}_2`,
      now,
      'The bus leaves at 8:15 sharp.\n\nOn Mon, Ms Chen wrote:\n> Permission slips are due Thursday.',
    );
    return threadId;
  };

  const queued = () =>
    db
      .selectFrom('email_drafts')
      .select(['id', 'kind', 'thread_id', 'to_emails', 'subject', 'send_after', 'include_attachments'])
      .where('user_id', '=', userId)
      .execute();

  it('every one of the six is registered and personal-chat only', () => {
    for (const name of SIX) {
      expect(toolSchemas).toHaveProperty(name);
      expect(PERSONAL_ONLY_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  describe('compose_email', () => {
    const args = { to: ['coach@team.org'], subject: 'Out Saturday', body: 'We will miss Saturday.' };

    it('stages a card and queues nothing', async () => {
      const res = await call('compose_email', args, 'propose');
      expect(res.summary).toContain('awaiting confirmation');
      expect(res.card).toMatchObject({ kind: 'email', title: 'New email: Out Saturday' });
      expect(res.card?.meta).toContain('coach@team.org');
      const [p] = await listProposalsForGroup(db, personalId);
      expect(p).toMatchObject({ toolName: 'compose_email', status: 'pending' });
      expect(await queued()).toHaveLength(0);
    });

    it('on confirm, goes into the outbox with an undo window', async () => {
      const res = await call('compose_email', args, 'commit');
      expect(res.data).toMatchObject({ sent: true });
      const rows = await queued();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'new', subject: 'Out Saturday', to_emails: ['coach@team.org'] });
      expect(rows[0].send_after).not.toBeNull();
    });

    it('carries the signature in the queued body, since the send adds none', async () => {
      await db
        .updateTable('users')
        .set({ email_signature: 'John\nSent from Chord' })
        .where('id', '=', userId)
        .execute();
      await call('compose_email', args, 'commit');
      const [row] = await db.selectFrom('email_drafts').select('body').where('user_id', '=', userId).execute();
      expect(row.body).toBe('We will miss Saturday.\n\n-- \nJohn\nSent from Chord');
    });

    it('rejects a name where an address belongs', () => {
      expect(toolSchemas.compose_email.safeParse({ ...args, to: ['Coach Dave'] }).success).toBe(false);
    });

    it('says so, and sends nothing, when no mailbox can send', async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      const res = await call('compose_email', args, 'commit');
      expect(res.data).toMatchObject({ sent: false, reason: 'no_mailbox' });
      expect(await queued()).toHaveLength(0);
    });
  });

  describe('forward_email', () => {
    it('stages a card naming the email from the thread, not from the model', async () => {
      const threadId = await seedThread();
      const res = await call(
        'forward_email',
        { threadId, to: ['dad@example.com'], threadSubject: 'Something else entirely' },
        'propose',
      );
      expect(res.card?.title).toBe('Forward: Field trip Friday');
      const [p] = await listProposalsForGroup(db, personalId);
      expect(JSON.parse(p.argsJson).threadSubject).toBe('Field trip Friday');
      expect(await queued()).toHaveLength(0);
    });

    it('on confirm, queues a forward of that thread with its attachments', async () => {
      const threadId = await seedThread();
      await call('forward_email', { threadId, to: ['dad@example.com'], note: 'FYI' }, 'commit');
      const [row] = await queued();
      expect(row).toMatchObject({ kind: 'forward', thread_id: threadId, include_attachments: 1 });
    });

    it('the card shows the email and pins that message, ignoring what the model typed', async () => {
      // Owner: "forward from X to Y - show the mail preview in bot, confirm
      // that's the email and forward".
      const threadId = await seedThread();
      const res = await call(
        'forward_email',
        {
          threadId,
          to: ['dad@example.com'],
          messageId: 'not-a-real-message',
          previewBody: 'Wire $5,000 now',
        },
        'propose',
      );
      const newest = await db
        .selectFrom('email_messages')
        .select('id')
        .where('thread_id', '=', threadId)
        .orderBy('internal_date', 'desc')
        .executeTakeFirstOrThrow();
      const [p] = await listProposalsForGroup(db, personalId);
      const args = JSON.parse(p.argsJson);
      expect(args.messageId).toBe(newest.id);
      expect(args.previewFrom).toBe('Ms Chen <chen@school.org>');
      expect(args.previewBody).toContain('The bus leaves at 8:15 sharp.');
      expect(res.card?.subtitle).toContain('Ms Chen <chen@school.org>');
      expect(res.card?.subtitle).toContain('The bus leaves at 8:15 sharp.');
      expect(res.card?.subtitle).not.toContain('Wire $5,000');
    });

    it('a confirmed forward sends the message the card showed, even if a newer one arrived', async () => {
      const threadId = await seedThread();
      await call('forward_email', { threadId, to: ['dad@example.com'] }, 'propose');
      const [p] = await listProposalsForGroup(db, personalId);
      const shown = JSON.parse(p.argsJson);

      // A reply lands between staging the card and the tap.
      const later = new Date(Date.now() + 60_000).toISOString();
      const thread = await db
        .selectFrom('email_threads')
        .select('gmail_thread_id')
        .where('id', '=', threadId)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: userId,
          thread_id: threadId,
          gmail_thread_id: thread.gmail_thread_id,
          gmail_message_id: `${thread.gmail_thread_id}_3`,
          from_name: 'Coach',
          from_email: 'coach@school.org',
          to_emails: JSON.stringify([]),
          cc_emails: JSON.stringify([]),
          subject: 'Field trip Friday',
          snippet: 'Unrelated',
          body_text: 'A newer message nobody saw on the card.',
          attachments_json: '[]',
          internal_date: later,
          created_at: later,
        })
        .execute();

      await call('forward_email', shown, 'commit');
      const draft = await db
        .selectFrom('email_drafts')
        .select(['id', 'forward_message_id'])
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(draft.forward_message_id).toBe(shown.messageId);

      // Due now; the outbox sends it.
      await db
        .updateTable('email_drafts')
        .set({ send_after: new Date(Date.now() - 1000).toISOString() })
        .where('id', '=', draft.id)
        .execute();
      (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
      try {
        const api = await getGmailApi(db, userId);
        const before = Number((await api.getProfile()).historyId);
        expect(await flushDueSends(db)).toBe(1);
        const sent = await api.getMessage(`m_sent_${before + 1}`, 'full');
        const raw = Buffer.from(sent!.payload!.body!.data!, 'base64url').toString('utf8');
        expect(raw).toContain('The bus leaves at 8:15 sharp.');
        expect(raw).not.toContain('A newer message nobody saw on the card.');
      } finally {
        (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
      }
    });

    it('cannot forward someone else’s thread', async () => {
      const other = await createUser(db, 'someone');
      const threadId = await seedThread(other);
      const res = await call('forward_email', { threadId, to: ['x@example.com'] }, 'commit');
      expect(res.data).toMatchObject({ sent: false, reason: 'thread_not_found' });
      expect(await queued()).toHaveLength(0);
    });
  });

  describe('cancel_email_send', () => {
    it('stops the latest queued message, then says honestly that nothing is left', async () => {
      await call('compose_email', { to: ['a@b.org'], subject: 'Oops', body: 'x' }, 'commit');
      const first = await call('cancel_email_send', {}, 'commit');
      expect(first.data).toMatchObject({ cancelled: true, subject: 'Oops' });
      // Back in Drafts: the row stays, the send time is gone.
      expect((await queued())[0].send_after).toBeNull();

      const second = await call('cancel_email_send', {}, 'commit');
      expect(second.data).toMatchObject({ cancelled: false, reason: 'already_sent' });
    });
  });

  describe('the chat hold (EMAIL_CHAT_UNDO_SECONDS)', () => {
    const setEnv = (k: 'EMAIL_UNDO_SECONDS' | 'EMAIL_CHAT_UNDO_SECONDS', v: number) => {
      (env as Record<string, unknown>)[k] = v;
    };
    let prior: { app: number; chat: number };
    beforeEach(() => {
      prior = { app: env.EMAIL_UNDO_SECONDS, chat: env.EMAIL_CHAT_UNDO_SECONDS };
    });
    afterEach(() => {
      setEnv('EMAIL_UNDO_SECONDS', prior.app);
      setEnv('EMAIL_CHAT_UNDO_SECONDS', prior.chat);
    });

    it('holds a chat-sent email for a minute, not the composer’s few seconds', async () => {
      setEnv('EMAIL_UNDO_SECONDS', 8);
      setEnv('EMAIL_CHAT_UNDO_SECONDS', 60);
      const before = Date.now();
      await call('compose_email', { to: ['a@b.org'], subject: 'Hi', body: 'x' }, 'commit');
      const heldFor = Date.parse((await queued())[0].send_after as string) - before;
      expect(heldFor).toBeGreaterThan(55_000);
      expect(heldFor).toBeLessThan(65_000);
    });

    it('a chat hold of 0 sends on confirm instead of waiting in the outbox', async () => {
      setEnv('EMAIL_CHAT_UNDO_SECONDS', 0);
      await call('compose_email', { to: ['a@b.org'], subject: 'Now', body: 'x' }, 'commit');
      expect((await queued()).filter((r) => r.send_after !== null)).toHaveLength(0);
    });

    it('the outbox stays on when only the composer’s hold is 0, so chat mail is not stranded', async () => {
      const { logger } = await import('@/config/logging.js');
      const { startOutboxScheduler } = await import('@/services/email/outbox.service.js');
      const info = vi.spyOn(logger, 'info');
      try {
        setEnv('EMAIL_UNDO_SECONDS', 0);
        setEnv('EMAIL_CHAT_UNDO_SECONDS', 60);
        startOutboxScheduler(db).stop();
        expect(info.mock.calls.some(([m]) => String(m).startsWith('outbox scheduler off'))).toBe(false);

        info.mockClear();
        setEnv('EMAIL_CHAT_UNDO_SECONDS', 0);
        startOutboxScheduler(db).stop();
        expect(info.mock.calls.some(([m]) => String(m).startsWith('outbox scheduler off'))).toBe(true);
      } finally {
        info.mockRestore();
      }
    });
  });

  describe('read_email', () => {
    it('returns the newest messages with quoted history folded away', async () => {
      const threadId = await seedThread();
      const res = await call('read_email', { threadId }, 'commit');
      expect(res.data).toMatchObject({ found: true, subject: 'Field trip Friday', messageCount: 2 });
      const msgs = (res.data as { messages: { body: string }[] }).messages;
      expect(msgs.map((m) => m.body)).toEqual([
        'Permission slips are due Thursday.',
        'The bus leaves at 8:15 sharp.',
      ]);
    });

    it('limits to the newest N', async () => {
      const threadId = await seedThread();
      const res = await call('read_email', { threadId, maxMessages: 1 }, 'commit');
      expect((res.data as { messages: unknown[] }).messages).toHaveLength(1);
    });

    it('does not read in a shared group, or another user’s mail', async () => {
      const threadId = await seedThread();
      expect((await call('read_email', { threadId }, 'commit', sharedId)).data).toMatchObject({ found: false });
      const other = await createUser(db, 'someone');
      const theirs = await seedThread(other);
      expect((await call('read_email', { threadId: theirs }, 'commit')).data).toMatchObject({ found: false });
    });
  });

  // ADR 0215 — the chat equivalent of the swipe.
  describe('trash_email', () => {
    const labels = async (threadId: string) =>
      (
        await db
          .selectFrom('email_threads')
          .select(['gmail_label_ids', 'is_archived'])
          .where('id', '=', threadId)
          .executeTakeFirstOrThrow()
      );

    it('stages a card naming the email from the thread, and trashes nothing yet', async () => {
      const threadId = await seedThread();
      const res = await call('trash_email', { threadId, threadSubject: 'Wrong one' }, 'propose');
      expect(res.card?.title).toBe('Trash: Field trip Friday');
      expect((await labels(threadId)).gmail_label_ids).not.toContain('TRASH');
    });

    it('on confirm, moves the thread to Trash through the swipe’s path', async () => {
      const threadId = await seedThread();
      const res = await call('trash_email', { threadId }, 'commit');
      expect(res.data).toMatchObject({ trashed: true });
      const row = await labels(threadId);
      expect(row.gmail_label_ids).toContain('TRASH');
      expect(row.is_archived).toBe(1);
    });

    it('cannot trash someone else’s thread, and is personal-only', async () => {
      const other = await createUser(db, 'someone');
      const theirs = await seedThread(other);
      const res = await call('trash_email', { threadId: theirs }, 'commit');
      expect(res.data).toMatchObject({ trashed: false, reason: 'not_found' });
      expect((await labels(theirs)).gmail_label_ids).not.toContain('TRASH');
      expect(PERSONAL_ONLY_TOOL_NAMES.has('trash_email')).toBe(true);
    });
  });

  // Prod, 13 Oct: "Make my email Job Offer as unread", "Label my previous email
  // to FYI" and "Mark my previous email as read" all got a refusal or a made-up
  // answer, because chat had no tool that could do any of them.
  describe('update_email', () => {
    const row = (threadId: string) =>
      db
        .selectFrom('email_threads')
        .select(['is_unread', 'is_archived', 'chord_label_ids', 'gmail_label_ids'])
        .where('id', '=', threadId)
        .executeTakeFirstOrThrow();

    it('marks an email unread, then read, through the same path as the swipe', async () => {
      const threadId = await seedThread(userId, 'Job Offer');
      const unread = await call('update_email', { threadIds: [threadId], markRead: false }, 'commit');
      expect(unread.data).toMatchObject({
        changed: 1,
        results: [{ threadId, ok: true, subject: 'Job Offer', isUnread: true }],
      });
      expect((await row(threadId)).is_unread).toBe(1);

      const read = await call('update_email', { threadIds: [threadId], markRead: true }, 'commit');
      expect(read.data).toMatchObject({ changed: 1, results: [{ ok: true, isUnread: false }] });
      expect((await row(threadId)).is_unread).toBe(0);
    });

    it('adds and removes a Chord label', async () => {
      const threadId = await seedThread();
      const added = await call('update_email', { threadIds: [threadId], addLabels: ['FYI'] }, 'commit');
      expect(added.data).toMatchObject({ results: [{ ok: true, labels: ['FYI'] }] });
      expect((await row(threadId)).chord_label_ids).toEqual(['FYI']);

      await call('update_email', { threadIds: [threadId], removeLabels: ['fyi'] }, 'commit');
      expect((await row(threadId)).chord_label_ids).toEqual([]);
    });

    it('archives several emails in one call', async () => {
      const ids = [await seedThread(), await seedThread(), await seedThread()];
      const res = await call('update_email', { threadIds: ids, archive: true }, 'commit');
      expect(res.data).toMatchObject({ changed: 3 });
      for (const id of ids) expect((await row(id)).is_archived).toBe(1);
    });

    it('names a thread it could not change instead of claiming it', async () => {
      const mine = await seedThread();
      const theirs = await seedThread(await createUser(db, 'someone'));
      const res = await call('update_email', { threadIds: [mine, theirs], markRead: false }, 'commit');
      expect(res.data).toMatchObject({
        changed: 1,
        results: [
          { threadId: mine, ok: true },
          { threadId: theirs, ok: false, reason: 'not_found' },
        ],
      });
      expect((res.data as { instruction?: string }).instruction).toMatch(/could not be changed/);
      expect((await row(theirs)).is_unread).toBe(0);
    });

    it('does nothing when asked for nothing, and only in the personal chat', async () => {
      const threadId = await seedThread();
      expect((await call('update_email', { threadIds: [threadId] }, 'commit')).data).toMatchObject({
        changed: 0,
        reason: 'empty',
      });
      const shared = await call('update_email', { threadIds: [threadId], markRead: false }, 'commit', sharedId);
      expect(shared.data).toMatchObject({ changed: 0 });
      expect((await row(threadId)).is_unread).toBe(0);
      expect(PERSONAL_ONLY_TOOL_NAMES.has('update_email')).toBe(true);
    });
  });

  // "Mark all my email read", "everything from X", "all the school emails",
  // "every email with an attachment": update_email only takes ids from one page
  // of search (at most 25), and search cannot ask for unread mail, so these
  // changed a handful of whatever search returned.
  describe('update_emails_matching', () => {
    const seedMail = async (o: {
      subject: string;
      fromName: string;
      fromEmail: string;
      unread?: boolean;
      attachments?: boolean;
      categoryId?: string;
      body?: string;
      owner?: string;
    }): Promise<string> => {
      const owner = o.owner ?? userId;
      const at = new Date(Date.now() - 3600_000).toISOString();
      const threadId = newId('et');
      const gid = newId('gt');
      await db
        .insertInto('email_threads')
        .values({
          id: threadId,
          user_id: owner,
          gmail_thread_id: gid,
          subject: o.subject,
          snippet: '',
          from_name: o.fromName,
          from_email: o.fromEmail,
          is_unread: o.unread ? 1 : 0,
          gmail_label_ids: JSON.stringify(o.unread ? ['INBOX', 'UNREAD'] : ['INBOX']),
          category_id: o.categoryId ?? null,
          last_message_at: at,
          created_at: at,
          updated_at: at,
        })
        .execute();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: owner,
          thread_id: threadId,
          gmail_thread_id: gid,
          gmail_message_id: `${gid}_1`,
          from_name: o.fromName,
          from_email: o.fromEmail,
          to_emails: JSON.stringify(['ro@example.com']),
          cc_emails: JSON.stringify([]),
          subject: o.subject,
          snippet: '',
          body_text: o.body ?? 'Hello.',
          body_html: null,
          is_unread: o.unread ? 1 : 0,
          gmail_label_ids: JSON.stringify(o.unread ? ['INBOX', 'UNREAD'] : ['INBOX']),
          attachments_json: o.attachments ? JSON.stringify([{ filename: 'form.pdf', mimeType: 'application/pdf', size: 1 }]) : '[]',
          internal_date: at,
          created_at: at,
        })
        .execute();
      return threadId;
    };
    const state = (id: string) =>
      db
        .selectFrom('email_threads')
        .select(['is_unread', 'is_archived', 'chord_label_ids'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    /** Stage the card, then tap it, the way a confirm does. */
    const proposeThenConfirm = async (args: Record<string, unknown>) => {
      const staged = await call('update_emails_matching', args, 'propose');
      const [p] = await listProposalsForGroup(db, personalId);
      return { staged, committed: p ? await call('update_emails_matching', JSON.parse(p.argsJson), 'commit') : null };
    };

    it('"mark all my email read" stages a card with the real count, and changes nothing until tapped', async () => {
      const unread = [
        await seedMail({ subject: 'Job Offer', fromName: 'Acme HR', fromEmail: 'hr@acme.com', unread: true }),
        await seedMail({ subject: 'Picture day', fromName: 'Ms Chen', fromEmail: 'chen@school.org', unread: true }),
        await seedMail({ subject: 'Sale', fromName: 'Shop', fromEmail: 'deals@shop.com', unread: true }),
      ];
      const alreadyRead = await seedMail({ subject: 'Old', fromName: 'Shop', fromEmail: 'deals@shop.com' });
      const someoneElses = await seedMail({
        subject: 'Theirs',
        fromName: 'Shop',
        fromEmail: 'deals@shop.com',
        unread: true,
        owner: await createUser(db, 'other'),
      });

      const staged = await call('update_emails_matching', { all: true, markRead: true }, 'propose');
      expect(staged.card?.title).toBe('Mark read: 3 emails');
      for (const id of unread) expect((await state(id)).is_unread).toBe(1);

      const [p] = await listProposalsForGroup(db, personalId);
      // Only the unread ones are on the card: marking read touches nothing else.
      expect(JSON.parse(p.argsJson).threadIds.sort()).toEqual([...unread].sort());
      const done = await call('update_emails_matching', JSON.parse(p.argsJson), 'commit');
      expect(done.data).toMatchObject({ changed: 3, failed: 0 });
      for (const id of unread) expect((await state(id)).is_unread).toBe(0);
      expect((await state(alreadyRead)).is_unread).toBe(0);
      expect((await state(someoneElses)).is_unread).toBe(1);
    });

    it('archives everything from one person, and only them', async () => {
      const chen = [
        await seedMail({ subject: 'Field trip', fromName: 'Ms Chen', fromEmail: 'chen@school.org' }),
        await seedMail({ subject: 'Spelling list', fromName: 'Ms Chen', fromEmail: 'chen@school.org' }),
      ];
      const coach = await seedMail({ subject: 'Practice moved', fromName: 'Coach Bob', fromEmail: 'bob@team.org' });

      const { staged, committed } = await proposeThenConfirm({ from: 'chen@school.org', archive: true });
      expect(staged.card?.title).toBe('Archive: 2 emails');
      expect(committed?.data).toMatchObject({ changed: 2 });
      for (const id of chen) expect((await state(id)).is_archived).toBe(1);
      expect((await state(coach)).is_archived).toBe(0);
    });

    it('"school" means the School category, not every email that says school', async () => {
      const school = newId('cat');
      await db
        .insertInto('email_categories')
        .values({ id: school, user_id: userId, parent_id: null, title: 'School', updated_at: new Date().toISOString() })
        .execute();
      const filed = await seedMail({
        subject: 'Picture day Thursday',
        fromName: 'PTA',
        fromEmail: 'pta@lincoln.edu',
        unread: true,
        categoryId: school,
      });
      const promo = await seedMail({
        subject: 'Back to school sale',
        fromName: 'Shop',
        fromEmail: 'deals@shop.com',
        unread: true,
        body: 'Everything for school, 30% off.',
      });

      const { staged, committed } = await proposeThenConfirm({ about: 'school', markRead: true });
      expect(staged.card?.title).toBe('Mark read: 1 email');
      expect(committed?.data).toMatchObject({ changed: 1 });
      expect((await state(filed)).is_unread).toBe(0);
      expect((await state(promo)).is_unread).toBe(1);
    });

    it('labels every email with an attachment', async () => {
      const withFile = await seedMail({ subject: 'Permission slip', fromName: 'Ms Chen', fromEmail: 'chen@school.org', attachments: true });
      const plain = await seedMail({ subject: 'Hi', fromName: 'Ms Chen', fromEmail: 'chen@school.org' });

      const { committed } = await proposeThenConfirm({ hasAttachment: true, addLabels: ['Docs'] });
      expect(committed?.data).toMatchObject({ changed: 1 });
      expect((await state(withFile)).chord_label_ids).toEqual(['Docs']);
      expect((await state(plain)).chord_label_ids).toEqual([]);
    });

    it('says so instead of staging a card when nothing matches or no filter was given', async () => {
      await seedMail({ subject: 'Hi', fromName: 'Ms Chen', fromEmail: 'chen@school.org' });
      expect((await call('update_emails_matching', { from: 'nobody@nowhere.com', archive: true }, 'propose')).data).toMatchObject({
        matched: 0,
      });
      expect((await call('update_emails_matching', { archive: true }, 'propose')).data).toMatchObject({
        matched: 0,
        reason: 'no_filter',
      });
      expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
    });

    it('is personal-chat only, and only the asker can apply it', async () => {
      const id = await seedMail({ subject: 'Hi', fromName: 'Ms Chen', fromEmail: 'chen@school.org', unread: true });
      expect((await call('update_emails_matching', { all: true, markRead: true }, 'propose', sharedId)).data).toMatchObject({
        reason: 'personal_only',
      });
      const tapped = await call(
        'update_emails_matching',
        { markRead: true, threadIds: [id], forUserId: 'u_someone_else' },
        'commit',
      );
      expect(tapped.data).toMatchObject({ changed: 0, reason: 'not_the_asker' });
      expect((await state(id)).is_unread).toBe(1);
      expect(PERSONAL_ONLY_TOOL_NAMES.has('update_emails_matching')).toBe(true);
    });
  });

  describe('set_email_digest', () => {
    const digest = async () =>
      (await db.selectFrom('users').select('email_digest_enabled').where('id', '=', userId).executeTakeFirstOrThrow())
        .email_digest_enabled;

    it('turns the briefing’s email section off and back on', async () => {
      await call('set_email_digest', { enabled: false }, 'commit');
      expect(Number(await digest())).toBe(0);
      await call('set_email_digest', { enabled: true }, 'commit');
      expect(Number(await digest())).toBe(1);
    });

    it('refuses in a shared group', async () => {
      const res = await call('set_email_digest', { enabled: false }, 'commit', sharedId);
      expect(res.data).toMatchObject({ ok: false });
      expect(Number(await digest())).toBe(1);
    });
  });

  describe('set_briefing_channel', () => {
    it('mutes the only WhatsApp chat without being told which', async () => {
      await bindChannel(db, 'whatsapp', 'whatsapp:+13475550001', personalId, 'whatsapp');
      const res = await call('set_briefing_channel', { muted: true }, 'commit');
      expect(res.data).toMatchObject({ ok: true, muted: true });
      expect((await listBriefingChannels(db, userId))[0].optedOut).toBe(true);
    });

    it('asks which chat when there are several, then takes the named one', async () => {
      await bindChannel(db, 'whatsapp', 'whatsapp:+13475550001', personalId, 'whatsapp');
      await bindChannel(db, 'whatsapp', 'whatsapp:+13475550002', sharedId, 'whatsapp');
      const unsure = await call('set_briefing_channel', { muted: true }, 'commit');
      expect(unsure.data).toMatchObject({ ok: false, reason: 'ambiguous' });
      expect((await listBriefingChannels(db, userId)).every((c) => !c.optedOut)).toBe(true);

      const named = await call('set_briefing_channel', { muted: true, groupName: 'family' }, 'commit');
      expect(named.data).toMatchObject({ ok: true, groupName: 'Family' });
      const after = await listBriefingChannels(db, userId);
      expect(after.find((c) => c.groupName === 'Family')?.optedOut).toBe(true);
      expect(after.find((c) => c.groupName !== 'Family')?.optedOut).toBe(false);
    });

    it('says when no WhatsApp chat is connected', async () => {
      const res = await call('set_briefing_channel', { muted: true }, 'commit');
      expect(res.data).toMatchObject({ ok: false, reason: 'no_channels' });
    });
  });
});
