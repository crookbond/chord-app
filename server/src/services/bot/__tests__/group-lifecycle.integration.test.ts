/**
 * ADR 0259 - leaving or deleting a whole chat, from the Messages list and by asking.
 *
 * The bot path shares `leaveGroupAs` / `deleteGroupAs` with the routes, so what
 * these pin is the part that is the bot's own: nothing happens until the card
 * is tapped, the chat is fixed by exact name BEFORE the card exists, an owner-only
 * delete is refused up front, and only the asker's tap counts.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { buildToolDefs, PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import {
  createGroup,
  deleteGroupAs,
  ensurePersonalGroup,
  getMemberRole,
  joinGroupByCode,
  leaveGroupAs,
} from '@/services/groups.service.js';
import { confirmProposal, listProposalsForGroup } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let priya: string;
let personal: string;
let soccer: string;
let bookClub: string;

const exists = async (id: string) =>
  !!(await db.selectFrom('groups').select('id').where('id', '=', id).executeTakeFirst());

async function propose(actor: string, groupId: string, name: string, groupName: string) {
  return applyToolCall(db, {
    groupId,
    actorUserId: actor,
    call: { name, args: { groupName } } as never,
    mode: 'propose',
    emit: () => {},
  } as never);
}

async function stagedArgs(groupId: string) {
  const [p] = await listProposalsForGroup(db, groupId, { status: 'pending' });
  return JSON.parse(p!.argsJson) as { groupName: string; groupId: string; forUserId: string };
}

async function commit(actor: string, groupId: string, name: string, args: unknown) {
  return applyToolCall(db, {
    groupId,
    actorUserId: actor,
    call: { name, args } as never,
    mode: 'commit',
    emit: () => {},
  } as never);
}

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  priya = await createUser(db, 'priya', 'Priya');
  personal = (await ensurePersonalGroup(db, john)).id;
  const s = await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: john, nameIsCustom: true });
  soccer = s.id;
  await joinGroupByCode(db, priya, s.invite_code);
  // Priya owns this one; John only belongs.
  const b = await createGroup(db, { name: 'Book Club', kind: 'group', createdBy: priya, nameIsCustom: true });
  bookClub = b.id;
  await joinGroupByCode(db, john, b.invite_code);
});

afterEach(async () => closeTestDb(db));

describe('the shared rules', () => {
  it('a personal chat can be neither left nor deleted', async () => {
    expect(await leaveGroupAs(db, personal, john)).toEqual({ ok: false, reason: 'personal' });
    expect(await deleteGroupAs(db, personal, john)).toEqual({ ok: false, reason: 'personal' });
  });

  it('only the owner deletes; a member can leave', async () => {
    expect(await deleteGroupAs(db, bookClub, john)).toEqual({ ok: false, reason: 'not_owner' });
    expect(await leaveGroupAs(db, bookClub, john)).toMatchObject({ ok: true });
    expect(await getMemberRole(db, bookClub, john)).toBeNull();
  });

  it('a stranger is told nothing about the chat', async () => {
    const stranger = await createUser(db, 'stranger');
    expect(await leaveGroupAs(db, soccer, stranger)).toEqual({ ok: false, reason: 'not_member' });
    expect(await deleteGroupAs(db, soccer, stranger)).toEqual({ ok: false, reason: 'not_member' });
  });
});

describe('leave_group / delete_group as bot tools', () => {
  it('are offered only from the personal chat', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('leave_group')).toBe(true);
    expect(PERSONAL_ONLY_TOOL_NAMES.has('delete_group')).toBe(true);
    expect(toolSchemas.leave_group).toBeDefined();
  });

  it('refuses from inside a shared chat, even if the model asks anyway', async () => {
    const out = await propose(john, soccer, 'delete_group', 'Soccer');
    expect(out.data).toMatchObject({ ok: false, reason: 'personal_chat_only' });
    expect(await exists(soccer)).toBe(true);
    expect(await listProposalsForGroup(db, soccer, { status: 'pending' })).toHaveLength(0);
  });

  it('leaving stages a card and does nothing until it is confirmed', async () => {
    const staged = await propose(john, personal, 'leave_group', 'soccer');
    expect(staged.summary).toContain('awaiting confirmation');
    // Nothing has happened yet.
    expect(await getMemberRole(db, soccer, john)).toBe('owner');

    const args = await stagedArgs(personal);
    // The chat is fixed by id, under its real name, for this asker only.
    expect(args).toEqual({ groupName: 'Soccer', groupId: soccer, forUserId: john });

    const done = await commit(john, personal, 'leave_group', args);
    expect(done.data).toMatchObject({ ok: true, groupName: 'Soccer' });
    expect(await getMemberRole(db, soccer, john)).toBeNull();
    // John owned it, so it passed to the member who was left.
    expect(await getMemberRole(db, soccer, priya)).toBe('owner');
  });

  it('deleting is refused up front when the asker does not own the chat', async () => {
    const out = await propose(john, personal, 'delete_group', 'Book Club');
    expect(out.data).toMatchObject({ ok: false, reason: 'not_owner', groupName: 'Book Club' });
    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(0);
    expect(await exists(bookClub)).toBe(true);
  });

  it('deleting stages a card, and the tap removes the chat for everyone', async () => {
    await propose(john, personal, 'delete_group', 'Soccer');
    expect(await exists(soccer)).toBe(true);
    const args = await stagedArgs(personal);
    const done = await commit(john, personal, 'delete_group', args);
    expect(done.data).toMatchObject({ ok: true });
    expect(await exists(soccer)).toBe(false);
  });

  it('a name that matches nothing, or only part of a name, comes back as a question', async () => {
    const none = await propose(john, personal, 'leave_group', 'Chess');
    expect(none.data).toMatchObject({ ok: false, reason: 'not_found', candidates: [] });
    const near = await propose(john, personal, 'leave_group', 'Soc');
    expect(near.data).toMatchObject({ ok: false, reason: 'not_found', candidates: ['Soccer'] });
    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(0);
  });

  it('only the person who asked can confirm', async () => {
    await propose(john, personal, 'delete_group', 'Soccer');
    const args = await stagedArgs(personal);
    const byPriya = await commit(priya, personal, 'delete_group', args);
    expect(byPriya.data).toMatchObject({ ok: false, reason: 'not_the_asker' });
    expect(await exists(soccer)).toBe(true);
  });

  it('a card tapped after ownership moved on is refused by the same rule as the route', async () => {
    await propose(john, personal, 'delete_group', 'Soccer');
    const args = await stagedArgs(personal);
    // John hands the chat over before tapping.
    await leaveGroupAs(db, soccer, john);
    const done = await commit(john, personal, 'delete_group', args);
    expect(done.data).toMatchObject({ ok: false, reason: 'not_member' });
    expect(await exists(soccer)).toBe(true);
  });

  // The tests above commit the tool directly. A real tap goes through
  // confirmProposal, which commits inside its own transaction — and
  // leaveGroup / deleteGroup used to open a second one, which Kysely refuses,
  // so neither card could ever be confirmed.
  it('a leave card confirmed the way a tap confirms it really leaves', async () => {
    await propose(john, personal, 'leave_group', 'Soccer');
    const [p] = await listProposalsForGroup(db, personal, { status: 'pending' });
    const r = await confirmProposal(db, { id: p!.id, resolvedByUserId: john });
    expect(r).toMatchObject({ ok: true });
    expect(await getMemberRole(db, soccer, john)).toBeNull();
  });

  it('a delete card confirmed the way a tap confirms it really deletes', async () => {
    await propose(john, personal, 'delete_group', 'Soccer');
    const [p] = await listProposalsForGroup(db, personal, { status: 'pending' });
    const r = await confirmProposal(db, { id: p!.id, resolvedByUserId: john });
    expect(r).toMatchObject({ ok: true });
    expect(await exists(soccer)).toBe(false);
  });

  it('never offers the model the ids it must not choose', () => {
    for (const name of ['leave_group', 'delete_group']) {
      const def = buildToolDefs().find((d) => d.name === name);
      const props = (def?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props)).toEqual(['groupName']);
    }
  });
});
