/**
 * ADR 0318 — inviting someone by email, said in chat. The tools call the same
 * service as the Messages screen; what is pinned here is what only chat has:
 * where the invite goes (direct from the 1:1, this group from a shared chat),
 * that an address the user never typed is refused, and that only the invitee
 * can answer an invite.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { postMessage } from '@/services/messages.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('invite_to_chat / respond_to_chat_invite', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let johnPersonal: string;
  let priyaPersonal: string;

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Shah');
    await db.updateTable('users').set({ email: 'priya@example.com' }).where('id', '=', priya).execute();
    johnPersonal = (await ensurePersonalGroup(db, john)).id;
    priyaPersonal = (await ensurePersonalGroup(db, priya)).id;
  });
  afterEach(async () => closeTestDb(db));

  const call = async (actor: string, groupId: string, name: string, args: Record<string, unknown>, said?: string) => {
    const trigger = said ? await postMessage(db, { groupId, senderId: actor, body: said, mentionsBot: false }) : null;
    return applyToolCall(db, {
      groupId,
      actorUserId: actor,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      triggeringMessageId: trigger?.id ?? null,
      call: { name, args } as never,
    });
  };

  it('are declared, and only answering is personal-only', () => {
    expect(toolSchemas.invite_to_chat).toBeDefined();
    expect(toolSchemas.respond_to_chat_invite).toBeDefined();
    expect(PERSONAL_ONLY_TOOL_NAMES.has('respond_to_chat_invite')).toBe(true);
    expect(PERSONAL_ONLY_TOOL_NAMES.has('invite_to_chat')).toBe(false);
  });

  it('from the 1:1 asks a Chord user to chat; she accepts in her own 1:1', async () => {
    const r = await call(john, johnPersonal, 'invite_to_chat', { email: 'priya@example.com', message: 'hey' }, 'invite priya@example.com and say hey');
    expect(r.data).toMatchObject({ ok: true, status: 'asked', name: 'Priya Shah' });

    // John cannot answer it for her.
    expect((await call(john, johnPersonal, 'respond_to_chat_invite', { accept: true })).data).toMatchObject({ ok: false, reason: 'none' });

    const a = await call(priya, priyaPersonal, 'respond_to_chat_invite', { accept: true, from: 'John' });
    expect(a.data).toMatchObject({ ok: true, accepted: true, from: 'John Doe' });
    const groupId = (a.data as { groupId: string }).groupId;
    const msgs = await db.selectFrom('messages').select(['body', 'sender_id']).where('group_id', '=', groupId).execute();
    expect(msgs).toEqual([{ body: 'hey', sender_id: john }]);
  });

  it('from a shared chat invites into THAT chat', async () => {
    const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true });
    const r = await call(john, family.id, 'invite_to_chat', { email: 'priya@example.com' }, 'add priya@example.com here');
    expect(r.data).toMatchObject({ ok: true, status: 'asked', groupId: family.id });
  });

  it('refuses an address the user never gave', async () => {
    const r = await call(john, johnPersonal, 'invite_to_chat', { email: 'priya@example.com' }, 'invite Priya to chat');
    expect(r.data).toMatchObject({ ok: false, reason: 'unknown_address' });
    expect(await db.selectFrom('chat_invites').selectAll().execute()).toHaveLength(0);
  });

  it('a named group that is not one of theirs is a question, not a guess', async () => {
    const r = await call(john, johnPersonal, 'invite_to_chat', { email: 'priya@example.com', groupName: 'Soccer' }, 'add priya@example.com to Soccer');
    expect(r.data).toMatchObject({ ok: false, reason: 'not_found' });
  });
});
