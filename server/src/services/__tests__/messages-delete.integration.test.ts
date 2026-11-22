/**
 * ADR 0242 — deleting chat messages by selection, or clearing the chat.
 * Personal chat: the rows are removed. Shared chat: for the caller only.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeleteMessagesRequest } from '@chord/kernel';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup, listGroupsForUser } from '@/services/groups.service.js';
import {
  deleteMessages,
  listMessages,
  recentDeletableMessageIds,
} from '@/services/messages.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { searchHits } from '@/services/search.service.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('deleting chat messages (ADR 0242)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let shared: string;
  let personal: string;
  let clock = Date.now() - 3_600_000;

  /** Insert with a strictly increasing timestamp so "newest" is unambiguous. */
  const post = async (
    groupId: string,
    senderId: string | null,
    body: string,
    opts: { hidden?: boolean; replyTo?: string } = {},
  ): Promise<string> => {
    const m = await insertMessage(db, {
      groupId,
      senderId: senderId ?? john,
      body,
      chordVisible: opts.hidden ? 0 : 1,
    });
    clock += 1000;
    await db
      .updateTable('messages')
      .set({
        sender_id: senderId,
        created_at: new Date(clock).toISOString(),
        reply_to_id: opts.replyTo ?? null,
        kind: senderId ? 'text' : 'bot',
      })
      .where('id', '=', m.id)
      .execute();
    return m.id;
  };
  /** Every row in the chat, whoever can see it. */
  const rows = async (groupId: string): Promise<string[]> =>
    (await db.selectFrom('messages').select('id').where('group_id', '=', groupId).orderBy('created_at').execute()).map(
      (r) => r.id,
    );
  /** What one member's chat screen shows. */
  const view = async (groupId: string, userId: string): Promise<string[]> =>
    (await listMessages(db, { groupId, viewerId: userId })).map((m) => m.id);

  beforeEach(async () => {
    // Posts are stamped in the past, so a "clear chat" done now covers them.
    clock = Date.now() - 3_600_000;
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Rao');
    shared = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: john })).id;
    await addMember(db, shared, priya);
    personal = (await ensurePersonalGroup(db, john)).id;
  });
  afterEach(async () => closeTestDb(db));

  describe('in the personal chat the messages are really removed', () => {
    it('removes only the ones named', async () => {
      const a = await post(personal, john, 'one');
      const b = await post(personal, null, 'two');
      const c = await post(personal, john, 'three');
      const out = await deleteMessages(db, { groupId: personal, userId: john, ids: [a, b] });
      expect(out).toMatchObject({ forEveryone: true, deleted: 2, skipped: 0 });
      expect(out.deletedIds.sort()).toEqual([a, b].sort());
      expect(await rows(personal)).toEqual([c]);
    });

    it('takes the hidden bot reply with the message it answered', async () => {
      const ask = await post(personal, john, '@Chord add milk');
      const receipt = await post(personal, null, 'added', { hidden: true, replyTo: ask });
      const other = await post(personal, john, 'keep me');
      const otherReceipt = await post(personal, null, 'ok', { hidden: true, replyTo: other });
      const out = await deleteMessages(db, { groupId: personal, userId: john, ids: [ask] });
      expect(out.deleted).toBe(1);
      expect(out.deletedIds.sort()).toEqual([ask, receipt].sort());
      expect(await rows(personal)).toEqual([other, otherReceipt]);
    });

    it('clearing empties it, hidden rows included', async () => {
      const ask = await post(personal, john, 'q');
      await post(personal, null, 'hidden', { hidden: true, replyTo: ask });
      await post(personal, null, 'briefing');
      const out = await deleteMessages(db, { groupId: personal, userId: john, all: true });
      expect(out).toMatchObject({ forEveryone: true, deleted: 2 });
      expect(await rows(personal)).toEqual([]);
    });

    it('clears more messages than one statement takes', async () => {
      const now = Date.now();
      const many = Array.from({ length: 2500 }, (_, i) => ({
        id: `m_bulk_${i}`,
        group_id: personal,
        sender_id: john,
        kind: 'text' as const,
        body: `n${i}`,
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 0,
        created_at: new Date(now + i).toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      }));
      for (let i = 0; i < many.length; i += 500) {
        await db.insertInto('messages').values(many.slice(i, i + 500)).execute();
      }
      const out = await deleteMessages(db, { groupId: personal, userId: john, all: true });
      expect(out.deleted).toBe(2500);
      expect(await rows(personal)).toEqual([]);
    });

    it('leaves a posted file in Attachments', async () => {
      await db
        .insertInto('attachments')
        .values({
          id: 'a_keep',
          scope_kind: 'group',
          scope_id: personal,
          uploaded_by: john,
          filename: 'form.pdf',
          mime_type: 'application/pdf',
          size: 10,
          path: 'x/form.pdf',
          summary: null,
          extracted_text: null,
          image_meta: null,
          pinned: 0,
          indexed_at: null,
          created_at: new Date().toISOString(),
        })
        .execute();
      const m = await insertMessage(db, { groupId: personal, senderId: john, body: 'form.pdf', attachmentId: 'a_keep' });
      await deleteMessages(db, { groupId: personal, userId: john, ids: [m.id] });
      expect(await rows(personal)).toEqual([]);
      expect(await db.selectFrom('attachments').select('id').where('id', '=', 'a_keep').execute()).toHaveLength(1);
    });
  });

  describe('in a shared chat the delete is for the caller only', () => {
    it("removes any chosen message from their view and nobody else's", async () => {
      const mine = await post(shared, john, 'mine');
      const hers = await post(shared, priya, 'hers');
      const bot = await post(shared, null, 'from Chord', { replyTo: hers });
      const kept = await post(shared, priya, 'still here');
      const out = await deleteMessages(db, { groupId: shared, userId: john, ids: [mine, hers, bot] });
      expect(out).toMatchObject({ forEveryone: false, deleted: 3, skipped: 0 });
      expect(await view(shared, john)).toEqual([kept]);
      expect(await view(shared, priya)).toEqual([mine, hers, bot, kept]);
      expect(await rows(shared)).toEqual([mine, hers, bot, kept]);
    });

    it('the bot still reads what one member deleted for themselves', async () => {
      const hers = await post(shared, priya, 'dinner is at 7');
      await deleteMessages(db, { groupId: shared, userId: john, ids: [hers] });
      expect((await listMessages(db, { groupId: shared, visibleOnly: false })).map((m) => m.id)).toEqual([hers]);
    });

    it('does not reach into another chat by id', async () => {
      const elsewhere = await post(personal, john, 'private');
      const out = await deleteMessages(db, { groupId: shared, userId: john, ids: [elsewhere] });
      expect(out).toMatchObject({ deleted: 0, skipped: 1 });
      expect(await view(personal, john)).toEqual([elsewhere]);
    });

    it('deleting the same message twice counts once', async () => {
      const hers = await post(shared, priya, 'hers');
      await deleteMessages(db, { groupId: shared, userId: john, ids: [hers] });
      const again = await deleteMessages(db, { groupId: shared, userId: john, ids: [hers] });
      expect(again).toMatchObject({ deleted: 0, skipped: 1 });
    });

    it("clearing empties the caller's view, keeps everyone else's, and later messages still show", async () => {
      const a = await post(shared, john, 'a');
      const b = await post(shared, priya, 'b');
      const out = await deleteMessages(db, { groupId: shared, userId: john, all: true });
      expect(out).toMatchObject({ forEveryone: false, deleted: 2, deletedIds: [] });
      expect(await view(shared, john)).toEqual([]);
      expect(await view(shared, priya)).toEqual([a, b]);

      clock = Date.now() + 5_000;
      const later = await post(shared, priya, 'new one');
      expect(await view(shared, john)).toEqual([later]);
      expect(await rows(shared)).toEqual([a, b, later]);
    });

    it("the chat list preview, unread count and search follow the caller's view", async () => {
      const old = await post(shared, priya, 'old lasagna plan');
      const newest = await post(shared, priya, 'newest lasagna plan');
      const row = async (userId: string) => (await listGroupsForUser(db, userId)).find((g) => g.id === shared)!;
      expect(await row(john)).toMatchObject({ last_message_preview: 'newest lasagna plan' });
      expect(Number((await row(john)).unread_count)).toBe(2);

      await deleteMessages(db, { groupId: shared, userId: john, ids: [newest] });
      expect(await row(john)).toMatchObject({ last_message_preview: 'old lasagna plan' });
      expect(Number((await row(john)).unread_count)).toBe(1);
      expect(await row(priya)).toMatchObject({ last_message_preview: 'newest lasagna plan' });

      const find = async (userId: string) =>
        (
          await searchHits(db, { userId, groupId: shared, crossGroup: false, query: 'lasagna', types: ['message'] })
        ).hits.map((h) => h.entityId);
      expect(await find(john)).toEqual([old]);
      expect((await find(priya)).sort()).toEqual([old, newest].sort());

      await deleteMessages(db, { groupId: shared, userId: john, all: true });
      expect((await row(john)).last_message_preview).toBeNull();
      expect(Number((await row(john)).unread_count)).toBe(0);
      expect(await find(john)).toEqual([]);
    });
  });

  describe('the request shape', () => {
    it('takes ids or all, never both and never neither', () => {
      expect(DeleteMessagesRequest.safeParse({ ids: ['m1'] }).success).toBe(true);
      expect(DeleteMessagesRequest.safeParse({ all: true }).success).toBe(true);
      expect(DeleteMessagesRequest.safeParse({}).success).toBe(false);
      expect(DeleteMessagesRequest.safeParse({ ids: [] }).success).toBe(false);
      expect(DeleteMessagesRequest.safeParse({ ids: ['m1'], all: true }).success).toBe(false);
    });
  });

  describe('the delete_messages bot tool', () => {
    it('"the last 2" skips the request itself and what the asker already deleted', async () => {
      const old = await post(shared, john, 'old');
      const mine = await post(shared, john, 'mine');
      const hers = await post(shared, priya, 'hers');
      const gone = await post(shared, priya, 'already deleted by john');
      await deleteMessages(db, { groupId: shared, userId: john, ids: [gone] });
      const ask = await post(shared, john, '@Chord delete the last 2 messages');
      expect(
        await recentDeletableMessageIds(db, { groupId: shared, userId: john, count: 2, exceptId: ask }),
      ).toEqual([mine, hers]);
      expect(await view(shared, john)).toContain(old);
    });

    it('stages a card and deletes nothing until it is confirmed', async () => {
      const a = await post(personal, john, 'a');
      const b = await post(personal, john, 'b');
      const ask = await post(personal, john, 'delete the last message');
      const staged = await applyToolCall(db, {
        groupId: personal,
        actorUserId: john,
        call: { name: 'delete_messages', args: { scope: 'last' } },
        mode: 'propose',
        triggeringMessageId: ask,
        emit: () => {},
      } as never);
      expect(staged.summary).toContain('awaiting confirmation');
      expect(await rows(personal)).toEqual([a, b, ask]);

      const [proposal] = await listProposalsForGroup(db, personal, { status: 'pending' });
      const args = JSON.parse(proposal!.argsJson) as { messageIds: string[]; forUserId: string };
      expect(args.messageIds).toEqual([b]);
      expect(args.forUserId).toBe(john);

      // A message arriving before the tap must not change what gets deleted.
      const later = await post(personal, john, 'later');
      const events: unknown[] = [];
      const done = await applyToolCall(db, {
        groupId: personal,
        actorUserId: john,
        call: { name: 'delete_messages', args },
        mode: 'commit',
        emit: (_ch: string, ev: string, data: unknown) => events.push([ev, data]),
      } as never);
      expect(done.data).toEqual({ deleted: 1, forEveryone: true });
      expect(await rows(personal)).toEqual([a, ask, later]);
      expect(events).toEqual([['messages.deleted', { groupId: personal, ids: [b] }]]);
    });

    it('in a shared chat only the asker can confirm, and nobody else is told', async () => {
      const a = await post(shared, priya, 'a');
      const ask = await post(shared, john, '@Chord clear this chat');
      await applyToolCall(db, {
        groupId: shared,
        actorUserId: john,
        call: { name: 'delete_messages', args: { scope: 'all' } },
        mode: 'propose',
        triggeringMessageId: ask,
        emit: () => {},
      } as never);
      const [proposal] = await listProposalsForGroup(db, shared, { status: 'pending' });
      const args = JSON.parse(proposal!.argsJson);

      const byPriya = await applyToolCall(db, {
        groupId: shared,
        actorUserId: priya,
        call: { name: 'delete_messages', args },
        mode: 'commit',
        emit: () => {},
      } as never);
      expect(byPriya.data).toMatchObject({ deleted: 0, reason: 'not_the_asker' });
      expect(await view(shared, priya)).toEqual([a, ask]);

      const events: unknown[] = [];
      const byJohn = await applyToolCall(db, {
        groupId: shared,
        actorUserId: john,
        call: { name: 'delete_messages', args },
        mode: 'commit',
        emit: (_ch: string, ev: string) => events.push(ev),
      } as never);
      expect(byJohn.data).toEqual({ deleted: 2, forEveryone: false });
      expect(await view(shared, john)).toEqual([]);
      expect(await view(shared, priya)).toEqual([a, ask]);
      expect(events).toEqual([]);
    });

    it('with nothing to delete it says so instead of staging an empty card', async () => {
      const ask = await post(shared, john, 'delete the last 3');
      const out = await applyToolCall(db, {
        groupId: shared,
        actorUserId: john,
        call: { name: 'delete_messages', args: { scope: 'last', count: 3 } },
        mode: 'propose',
        triggeringMessageId: ask,
        emit: () => {},
      } as never);
      expect(out.data).toMatchObject({ deleted: 0, reason: 'nothing_to_delete' });
      expect(await listProposalsForGroup(db, shared, { status: 'pending' })).toHaveLength(0);
    });
  });
});
