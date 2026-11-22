/**
 * ADR 0298 — the user-level block. The blocker stops seeing the blocked
 * person's messages in every shared chat (list, chat-list preview + unread,
 * search), gets no pushes for them, and the block is reversible. The blocked
 * person's view is unchanged.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import {
  blockMember,
  isBlocked,
  listBlockedUsers,
  resolveBlockablePerson,
  unblockUser,
} from '@/services/blocks.service.js';
import { createGroup, ensurePersonalGroup, listGroupsForUser } from '@/services/groups.service.js';
import { listMessages } from '@/services/messages.service.js';
import { selectRecipientTokens } from '@/services/push/push-publisher.js';
import { searchHits } from '@/services/search.service.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('blocking a user (ADR 0298)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let sam: string;
  let family: string;
  let personal: string;
  let clock = Date.now() - 3_600_000;

  const post = async (groupId: string, senderId: string, body: string): Promise<string> => {
    const m = await insertMessage(db, { groupId, senderId, body });
    clock += 1000;
    await db
      .updateTable('messages')
      .set({ created_at: new Date(clock).toISOString() })
      .where('id', '=', m.id)
      .execute();
    return m.id;
  };
  const view = async (groupId: string, userId: string): Promise<string[]> =>
    (await listMessages(db, { groupId, viewerId: userId })).map((m) => m.id);

  const tool = (name: string, args: Record<string, unknown>, actor = john) =>
    applyToolCall(db, { groupId: personal, actorUserId: actor, provenance: null, call: { name, args } as never });

  beforeEach(async () => {
    clock = Date.now() - 3_600_000;
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Rao');
    sam = await createUser(db, 'sam', 'Sam Lee');
    family = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: john })).id;
    await addMember(db, family, priya);
    await addMember(db, family, sam);
    personal = (await ensurePersonalGroup(db, john)).id;
  });
  afterEach(async () => closeTestDb(db));

  it('hides the blocked person from the blocker only, and unblock brings them back', async () => {
    const mine = await post(family, john, 'dinner at 7?');
    const sams = await post(family, sam, 'something abusive');
    const priyas = await post(family, priya, 'works for me');

    await blockMember(db, john, sam);
    expect(await view(family, john)).toEqual([mine, priyas]);
    expect(await view(family, sam)).toEqual([mine, sams, priyas]);
    expect(await view(family, priya)).toEqual([mine, sams, priyas]);

    await unblockUser(db, john, sam);
    expect(await view(family, john)).toEqual([mine, sams, priyas]);
  });

  it('leaves the blocked person out of the chat list preview and unread count', async () => {
    await post(family, priya, 'lunch?');
    await post(family, sam, 'newest from sam');
    const row = async () => (await listGroupsForUser(db, john)).find((g) => g.id === family)!;
    expect(await row()).toMatchObject({ last_message_preview: 'newest from sam' });
    expect(Number((await row()).unread_count)).toBe(2);

    await blockMember(db, john, sam);
    expect(await row()).toMatchObject({ last_message_preview: 'lunch?' });
    expect(Number((await row()).unread_count)).toBe(1);
  });

  it('leaves the blocked person out of search', async () => {
    const p = await post(family, priya, 'lasagna on friday');
    await post(family, sam, 'lasagna is overrated');
    await blockMember(db, john, sam);
    const hits = await searchHits(db, {
      userId: john,
      groupId: family,
      crossGroup: false,
      query: 'lasagna',
      types: ['message'],
    });
    expect(hits.hits.map((h) => h.entityId)).toEqual([p]);
  });

  it('sends the blocker no push for the blocked person, and others still get one', async () => {
    const now = new Date().toISOString();
    for (const u of [john, priya]) {
      await db
        .insertInto('push_tokens')
        .values({ token: `tok-${u}`, user_id: u, platform: 'ios', created_at: now, last_seen_at: now })
        .execute();
    }
    const msg = await insertMessage(db, { groupId: family, senderId: sam, body: 'hey' });
    expect((await selectRecipientTokens(db, family, msg)).sort()).toEqual([`tok-${priya}`, `tok-${john}`].sort());
    await blockMember(db, john, sam);
    expect(await selectRecipientTokens(db, family, msg)).toEqual([`tok-${priya}`]);
  });

  it('only blocks someone the blocker shares a chat with, never themselves', async () => {
    const stranger = await createUser(db, 'stranger', 'Some Stranger');
    expect(await blockMember(db, john, stranger)).toEqual({ ok: false, reason: 'not_found' });
    expect(await blockMember(db, john, 'u_does_not_exist')).toEqual({ ok: false, reason: 'not_found' });
    expect(await blockMember(db, john, john)).toEqual({ ok: false, reason: 'self' });
    expect(await isBlocked(db, john, stranger)).toBe(false);

    const ok = await blockMember(db, john, sam);
    expect(ok).toMatchObject({ ok: true, already: false, user: { userId: sam, name: 'Sam Lee' } });
    expect(await blockMember(db, john, sam)).toMatchObject({ ok: true, already: true });
    expect((await listBlockedUsers(db, john)).map((b) => b.name)).toEqual(['Sam Lee']);
  });

  it('resolves a name exact-or-ask among people who share a chat', async () => {
    const sam2 = await createUser(db, 'samuel', 'Sam Patel');
    await addMember(db, family, sam2);
    await db.updateTable('users').set({ first_name: 'Sam' }).where('id', 'in', [sam, sam2]).execute();
    expect((await resolveBlockablePerson(db, john, 'Sam')).kind).toBe('ambiguous');
    expect(await resolveBlockablePerson(db, john, 'sam lee')).toEqual({
      kind: 'one',
      person: { userId: sam, name: 'Sam Lee' },
    });
    const none = await resolveBlockablePerson(db, john, 'Pri');
    expect(none.kind).toBe('none');
    expect(none.kind === 'none' && none.candidates.map((c) => c.name)).toEqual(['Priya Rao']);
  });

  describe('bot tools', () => {
    it('are personal-chat only', () => {
      for (const t of ['block_user', 'unblock_user', 'list_blocked_users']) {
        expect(PERSONAL_ONLY_TOOL_NAMES.has(t as never)).toBe(true);
      }
    });

    it('block, list and unblock by name through the same service', async () => {
      const blocked = await tool('block_user', { name: 'Sam Lee' });
      expect(blocked.data).toMatchObject({ ok: true, name: 'Sam Lee' });
      expect(await isBlocked(db, john, sam)).toBe(true);

      const listed = await tool('list_blocked_users', {});
      expect(listed.data).toMatchObject({ ok: true, blocked: [{ name: 'Sam Lee' }] });

      const missing = await tool('unblock_user', { name: 'Priya' });
      expect(missing.data).toMatchObject({ ok: false, reason: 'not_found', candidates: ['Sam Lee'] });
      expect(await isBlocked(db, john, sam)).toBe(true);

      const unblocked = await tool('unblock_user', { name: 'sam' });
      expect(unblocked.data).toMatchObject({ ok: true, name: 'Sam Lee' });
      expect(await isBlocked(db, john, sam)).toBe(false);
    });

    it('refuses an unknown name without blocking anyone', async () => {
      const out = await tool('block_user', { name: 'Nobody Here' });
      expect(out.data).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await listBlockedUsers(db, john)).toEqual([]);
    });
  });
});
