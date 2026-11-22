/**
 * ADR 0234 — a family plan comes with a chat. The first person to accept finds
 * a group already waiting with the owner in it; later ones join the same one;
 * ending a seat takes the person out; and the owner can post or forward an
 * email into it from chat or from the reader.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import { ensureFamilyGroup, familyGroupIdFor } from '@/services/family-group.service.js';
import {
  acceptFamilyInvite,
  addFamilyMember,
  getFamilyOverview,
  leaveFamily,
  removeFamilyMember,
  updateFamilyMember,
} from '@/services/family-plan.service.js';
import { shareEmailThreadToGroup } from '@/services/group-share.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { isTrusted } from '@/services/trust.service.js';
import { suggestTripShareGroups } from '@/services/trips/share-suggestion.js';
import { createTrip } from '@/services/trips.service.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('the family chat (ADR 0234)', () => {
  let db: Kysely<DB>;
  let owner: string;
  let priya: string;
  let aarav: string;

  const invite = async (name: string, chordinator = false): Promise<string> => {
    const r = await addFamilyMember(db, owner, { name, email: `${name.toLowerCase()}@example.com`, chordinator, invite: true });
    return (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
  };
  const members = async (groupId: string): Promise<string[]> =>
    (await db.selectFrom('group_members').select('user_id').where('group_id', '=', groupId).execute())
      .map((m) => m.user_id)
      .sort();
  const familyGroups = () => db.selectFrom('groups').selectAll().where('family_owner_id', '=', owner).execute();

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Rao');
    aarav = await createUser(db, 'aarav', 'Aarav Doe');
    await db.updateTable('users').set({ first_name: 'John', last_name: 'Doe' }).where('id', '=', owner).execute();
  });
  afterEach(async () => closeTestDb(db));

  describe('the roster', () => {
    it('has no chat until someone has accepted', async () => {
      await invite('Priya');
      expect(await familyGroups()).toHaveLength(0);
      expect((await getFamilyOverview(db, owner)).groupId).toBeNull();
    });

    it('the first acceptance creates the chat with both of them in it, named for the family', async () => {
      const accepted = await acceptFamilyInvite(db, priya, await invite('Priya'));
      expect(accepted.ok).toBe(true);
      const [g] = await familyGroups();
      expect(g).toMatchObject({ name: 'Doe Family', kind: 'group', name_is_custom: 1 });
      expect((accepted as { groupId: string }).groupId).toBe(g!.id);
      expect(await members(g!.id)).toEqual([owner, priya].sort());
      // Greeted, so it is not an empty chat in the list.
      const msgs = await db.selectFrom('messages').select(['sender_id', 'body']).where('group_id', '=', g!.id).execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.sender_id).toBeNull();
      // The person is on the group's roster, so the bot can assign things to them.
      const persona = await db.selectFrom('personas').select('id').where('group_id', '=', g!.id).where('member_user_id', '=', priya).execute();
      expect(persona).toHaveLength(1);
    });

    it('a second person joins the SAME chat rather than making another', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      await acceptFamilyInvite(db, aarav, await invite('Aarav'));
      const groups = await familyGroups();
      expect(groups).toHaveLength(1);
      expect(await members(groups[0]!.id)).toEqual([owner, priya, aarav].sort());
    });

    it('both sides see the chat on the family overview', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const [g] = await familyGroups();
      expect((await getFamilyOverview(db, owner)).groupId).toBe(g!.id);
      expect(await getFamilyOverview(db, priya)).toMatchObject({ role: 'member', groupId: g!.id });
    });

    it('a Chordinator is still a Chordinator, and still lands in the chat', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya', true));
      expect(await isTrusted(db, owner, priya, 'task')).toBe(true);
      expect(await familyGroupIdFor(db, priya)).not.toBeNull();
    });

    it('toggling Chordinator later changes trust but not membership of the chat', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya', true));
      const [row] = await db.selectFrom('family_members').select('id').where('user_id', '=', priya).execute();
      await updateFamilyMember(db, owner, row!.id, { chordinator: false });
      expect(await isTrusted(db, owner, priya, 'task')).toBe(false);
      const [g] = await familyGroups();
      expect(await members(g!.id)).toContain(priya);
    });

    it('removing a seated member takes them out of the chat; the others stay', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      await acceptFamilyInvite(db, aarav, await invite('Aarav'));
      const [row] = await db.selectFrom('family_members').select('id').where('user_id', '=', priya).execute();
      await removeFamilyMember(db, owner, row!.id);
      const [g] = await familyGroups();
      expect(await members(g!.id)).toEqual([owner, aarav].sort());
      expect(await familyGroupIdFor(db, priya)).toBeNull();
    });

    it('leaving the plan takes the member out of the chat', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      expect((await leaveFamily(db, priya)).ok).toBe(true);
      const [g] = await familyGroups();
      expect(await members(g!.id)).toEqual([owner]);
    });

    it('a member who leaves and is invited back returns to the SAME chat, history intact', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      await acceptFamilyInvite(db, aarav, await invite('Aarav'));
      const [before] = await familyGroups();
      const history = await db.selectFrom('messages').select('id').where('group_id', '=', before!.id).execute();
      for (let round = 0; round < 2; round++) {
        expect((await leaveFamily(db, priya)).ok).toBe(true);
        await acceptFamilyInvite(db, priya, await invite('Priya'));
      }
      const groups = await familyGroups();
      expect(groups.map((g) => g.id)).toEqual([before!.id]);
      expect(await members(before!.id)).toEqual([owner, priya, aarav].sort());
      expect(
        await db.selectFrom('messages').select('id').where('group_id', '=', before!.id).execute(),
      ).toEqual(history);
    });

    it('the owner renewing the plan leaves the chat and its members alone', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const [before] = await familyGroups();
      await db
        .updateTable('users')
        .set({
          subscription_period_started_at: new Date().toISOString(),
          subscription_current_period_end: new Date(Date.now() + 30 * DAY).toISOString(),
        })
        .where('id', '=', owner)
        .execute();
      await ensureFamilyGroup(db, owner);
      expect((await familyGroups()).map((g) => g.id)).toEqual([before!.id]);
      expect(await members(before!.id)).toEqual([owner, priya].sort());
    });

    it('two requests creating the chat at once still make exactly one', async () => {
      const [a, b] = await Promise.all([ensureFamilyGroup(db, owner), ensureFamilyGroup(db, owner)]);
      expect(a.id).toBe(b.id);
      expect(await familyGroups()).toHaveLength(1);
    });
  });

  describe('trips are offered to the family chat first', () => {
    const trip = (groupId: string) =>
      createTrip(db, {
        groupId,
        createdBy: owner,
        name: 'Denver',
        destination: 'DEN',
        startDate: day(20),
        endDate: day(25),
        participantIds: [],
      });

    it('with a family chat AND other groups, only the family chat is offered', async () => {
      const personal = (await ensurePersonalGroup(db, owner)).id;
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const soccer = (await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: owner, nameIsCustom: true })).id;
      await addMember(db, soccer, aarav);
      const t = await trip(personal);
      const offered = await suggestTripShareGroups(db, owner, t.id);
      expect(offered.map((o) => o.name)).toEqual(['Doe Family']);
    });

    it('without a family chat, two groups and no name still offers nothing', async () => {
      const personal = (await ensurePersonalGroup(db, owner)).id;
      for (const n of ['Soccer', 'Book club']) {
        const g = (await createGroup(db, { name: n, kind: 'group', createdBy: owner, nameIsCustom: true })).id;
        await addMember(db, g, priya);
      }
      const t = await trip(personal);
      expect(await suggestTripShareGroups(db, owner, t.id)).toEqual([]);
    });
  });

  describe('posting and forwarding into the chat', () => {
    let personalId: string;
    let familyId: string;

    const call = (
      name: string,
      args: Record<string, unknown>,
      groupId = personalId,
      actor = owner,
      mode: 'commit' | 'propose' = 'commit',
    ) =>
      applyToolCall(db, {
        groupId,
        actorUserId: actor,
        provenance: null,
        turnId: `turn-${Math.random()}`,
        mode,
        call: { name, args } as never,
      });
    // What a bot turn does: stage the card (ADR 0234 addendum).
    const stage = (name: string, args: Record<string, unknown>, groupId = personalId, actor = owner) =>
      call(name, args, groupId, actor, 'propose');
    const proposalOf = (res: Awaited<ReturnType<typeof call>>): string =>
      (res.data as { proposalId: string }).proposalId;
    // The asker's tap on the card.
    const tap = (proposalId: string, by = owner) => confirmProposal(db, { id: proposalId, resolvedByUserId: by });
    // Stage, then tap: how a post really reaches a group now.
    const postViaCard = async (name: string, args: Record<string, unknown>) => {
      const staged = await stage(name, args);
      const id = (staged.data as { proposalId?: string } | undefined)?.proposalId;
      if (!id) return { ok: false, summary: staged.summary };
      const out = await tap(id);
      return { ok: out.ok, summary: out.ok ? out.summary : '' };
    };
    const chat = (groupId: string) =>
      db
        .selectFrom('messages')
        .select(['sender_id', 'body'])
        .where('group_id', '=', groupId)
        .where('sender_id', 'is not', null)
        .orderBy('created_at', 'asc')
        .execute();

    const seedThread = async (userId = owner): Promise<string> => {
      const now = new Date().toISOString();
      const earlier = new Date(Date.now() - 3600_000).toISOString();
      const threadId = newId('et');
      const gid = newId('gt');
      await db
        .insertInto('email_threads')
        .values({
          id: threadId,
          user_id: userId,
          gmail_thread_id: gid,
          subject: 'Field trip Friday',
          snippet: '',
          from_name: 'Ms Chen',
          from_email: 'chen@school.org',
          last_message_at: now,
          created_at: earlier,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: userId,
          thread_id: threadId,
          gmail_thread_id: gid,
          gmail_message_id: newId('gm'),
          from_name: 'Ms Chen',
          from_email: 'chen@school.org',
          to_emails: JSON.stringify(['john@example.com']),
          cc_emails: JSON.stringify([]),
          subject: 'Field trip Friday',
          snippet: 'The bus leaves',
          body_text: 'The bus leaves at 8:15 sharp.\n\nOn Mon, Ms Chen wrote:\n> Permission slips are due Thursday.',
          body_html: null,
          attachments_json: JSON.stringify([{ filename: 'slip.pdf', mimeType: 'application/pdf', size: 10, partId: '2' }]),
          internal_date: now,
          created_at: now,
        })
        .execute();
      return threadId;
    };

    beforeEach(async () => {
      personalId = (await ensurePersonalGroup(db, owner)).id;
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      familyId = (await familyGroups())[0]!.id;
    });

    it('both tools are registered and personal-chat only', () => {
      for (const name of ['message_group', 'share_email_with_group']) {
        expect(toolSchemas).toHaveProperty(name);
        expect(PERSONAL_ONLY_TOOL_NAMES.has(name as never)).toBe(true);
      }
    });

    // Bug (2026-11-10 audit): the bot posted straight into the family chat
    // with no card, so a wrong guess about the group or the words was already
    // in front of everyone - and deleting it hides it for the poster only.
    it('message_group stages a card naming the group and the exact text, and posts NOTHING', async () => {
      const staged = await stage('message_group', { body: 'Dinner is at 6' });
      expect(staged.summary).toMatch(/awaiting confirmation/);
      expect(staged.card).toMatchObject({ title: 'Post to Doe Family', subtitle: 'Dinner is at 6' });
      expect(staged.card?.buttons?.[0]).toMatchObject({ label: 'Post' });
      expect(await chat(familyId)).toEqual([]);
      const row = await db
        .selectFrom('proposals')
        .select(['tool_name', 'args_json', 'status'])
        .where('id', '=', proposalOf(staged))
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ tool_name: 'message_group', status: 'pending' });
      expect(JSON.parse(row.args_json)).toMatchObject({ groupId: familyId, forUserId: owner, groupName: 'Doe Family' });
    });

    it('message_group with no name posts, as the user, to the family chat once they tap Post', async () => {
      const staged = await stage('message_group', { body: 'Dinner is at 6' });
      expect((await tap(proposalOf(staged))).ok).toBe(true);
      expect(await chat(familyId)).toEqual([{ sender_id: owner, body: 'Dinner is at 6' }]);
    });

    it('a group post never runs without a card, and never on someone else\'s tap', async () => {
      // Straight to commit with no pinned group: nothing is posted.
      expect((await call('message_group', { body: 'hi' })).data).toMatchObject({ ok: false, reason: 'needs_confirmation' });
      // A group id the model typed is thrown away at staging.
      const theirs = (await createGroup(db, { name: 'Neighbours', kind: 'group', createdBy: priya, nameIsCustom: true })).id;
      const staged = await stage('message_group', { body: 'hi', groupId: theirs, forUserId: priya });
      expect(JSON.parse(
        (await db.selectFrom('proposals').select('args_json').where('id', '=', proposalOf(staged)).executeTakeFirstOrThrow()).args_json,
      )).toMatchObject({ groupId: familyId, forUserId: owner });
      // A card pinned to the asker does nothing for anyone else.
      const other = await call('message_group', { body: 'hi', groupId: familyId, groupName: 'Doe Family', forUserId: owner }, personalId, priya);
      expect(other.data).toMatchObject({ ok: false, reason: 'not_the_asker' });
      expect(await chat(familyId)).toEqual([]);
      expect(await chat(theirs)).toEqual([]);
    });

    it('message_group can name any group the user is in, and nothing else', async () => {
      const soccer = (await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: owner, nameIsCustom: true })).id;
      expect((await postViaCard('message_group', { groupName: 'soccer', body: 'Running late' })).ok).toBe(true);
      expect(await chat(soccer)).toHaveLength(1);
      // A group the user is not in is as good as not existing: no card at all.
      const theirs = (await createGroup(db, { name: 'Neighbours', kind: 'group', createdBy: priya, nameIsCustom: true })).id;
      const out = await stage('message_group', { groupName: 'Neighbours', body: 'hi' });
      expect(out.data).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await chat(theirs)).toHaveLength(0);
    });

    it('with no family chat and no name it asks rather than picking a group', async () => {
      const lone = await createUser(db, 'lone', 'Lone Wolf');
      const lonePersonal = (await ensurePersonalGroup(db, lone)).id;
      await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: lone, nameIsCustom: true });
      const out = await stage('message_group', { body: 'hi' }, lonePersonal, lone);
      expect(out.data).toMatchObject({ ok: false, reason: 'no_family_group' });
    });

    it('is refused inside a shared group', async () => {
      for (const run of [call, stage]) {
        const out = await run('message_group', { body: 'hi' }, familyId);
        expect(out.data).toMatchObject({ ok: false, reason: 'personal_only' });
      }
      expect(await chat(familyId)).toHaveLength(0);
    });

    it('share_email_with_group posts the sender, subject and newest message without its quoted history', async () => {
      const threadId = await seedThread();
      const out = await postViaCard('share_email_with_group', { threadId, note: 'FYI' });
      expect(out.ok).toBe(true);
      const [m] = await chat(familyId);
      expect(m!.sender_id).toBe(owner);
      expect(m!.body).toContain('FYI');
      expect(m!.body).toContain('Field trip Friday');
      expect(m!.body).toContain('Ms Chen');
      expect(m!.body).toContain('The bus leaves at 8:15 sharp.');
      expect(m!.body).not.toContain('Permission slips are due Thursday');
      // Attachments are named, not sent.
      expect(m!.body).toContain('slip.pdf');
    });

    it('will not share a thread that is not the user\'s own, and posts nothing', async () => {
      const theirs = await seedThread(priya);
      const out = await stage('share_email_with_group', { threadId: theirs });
      expect(out.data).toMatchObject({ ok: false, reason: 'thread_not_found' });
      expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(0);
      expect(await chat(familyId)).toHaveLength(0);
    });

    it('share_email_with_group stages a card showing which email goes where, and posts NOTHING until the tap', async () => {
      const threadId = await seedThread();
      const staged = await stage('share_email_with_group', { threadId, note: 'FYI', threadSubject: 'Made up' });
      expect(staged.card).toMatchObject({ title: 'Share with Doe Family: Field trip Friday' });
      expect(staged.card?.subtitle).toContain('Ms Chen <chen@school.org>');
      expect(staged.card?.subtitle).toContain('The bus leaves at 8:15 sharp.');
      expect(staged.card?.subtitle).toContain('slip.pdf');
      expect(staged.card?.subtitle).toContain('Your note: FYI');
      expect(staged.card?.buttons?.[0]).toMatchObject({ label: 'Share' });
      expect(await chat(familyId)).toEqual([]);
    });

    it('the tap shares the message the card showed, not a reply that arrived after', async () => {
      const threadId = await seedThread();
      const staged = await stage('share_email_with_group', { threadId });
      const later = new Date(Date.now() + 60_000).toISOString();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: owner,
          thread_id: threadId,
          gmail_thread_id: (await db.selectFrom('email_threads').select('gmail_thread_id').where('id', '=', threadId).executeTakeFirstOrThrow()).gmail_thread_id,
          gmail_message_id: newId('gm'),
          from_name: 'Coach Ray',
          from_email: 'ray@school.org',
          to_emails: JSON.stringify(['john@example.com']),
          cc_emails: JSON.stringify([]),
          subject: 'Re: Field trip Friday',
          snippet: 'Private reply',
          body_text: 'Private reply meant only for you.',
          body_html: null,
          attachments_json: JSON.stringify([]),
          internal_date: later,
          created_at: later,
        })
        .execute();
      expect((await tap(proposalOf(staged))).ok).toBe(true);
      const [m] = await chat(familyId);
      expect(m!.body).toContain('The bus leaves at 8:15 sharp.');
      expect(m!.body).not.toContain('Private reply');
    });

    it('will not share into a group the user is not in', async () => {
      const outsider = await createUser(db, 'outsider', 'Out Sider');
      const threadId = await seedThread(outsider);
      const out = await shareEmailThreadToGroup(db, outsider, familyId, threadId);
      expect(out).toEqual({ ok: false, reason: 'not_member' });
      expect(await chat(familyId)).toHaveLength(0);
    });
  });

  // ADR 0299 addendum — family members without an account are in the chat too.
  describe('people without an account', () => {
    const personas = async (groupId: string) =>
      db
        .selectFrom('personas')
        .select(['name', 'household_role', 'is_managed', 'managed_by', 'member_user_id', 'linked_person_id'])
        .where('group_id', '=', groupId)
        .orderBy('name')
        .execute();

    it('a child added to the roster is in an existing family chat, looked after by the owner', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const familyId = (await familyGroups())[0]!.id;
      await addFamilyMember(db, owner, { name: 'Ben', relationship: 'son' });
      const ben = (await personas(familyId)).find((p) => p.name === 'Ben');
      expect(ben).toMatchObject({ household_role: 'child', is_managed: 1, managed_by: owner, member_user_id: null });
      expect(ben?.linked_person_id).toBeTruthy();
    });

    it('children already on the roster join the chat when it is created, once', async () => {
      await addFamilyMember(db, owner, { name: 'Ben', relationship: 'son' });
      await addFamilyMember(db, owner, { name: 'Ben', relationship: 'son' });
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const familyId = (await familyGroups())[0]!.id;
      expect((await personas(familyId)).filter((p) => p.name === 'Ben')).toHaveLength(1);
    });

    it('when that person later gets an account, the persona becomes theirs instead of a second one', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const familyId = (await familyGroups())[0]!.id;
      await addFamilyMember(db, owner, { name: 'Aarav', relationship: 'son' });
      await acceptFamilyInvite(db, aarav, await invite('Aarav'));
      const rows = (await personas(familyId)).filter((p) => p.name.startsWith('Aarav'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ member_user_id: aarav, is_managed: 0, managed_by: null });
    });

    it('removing them from the roster takes them out of the chat', async () => {
      await acceptFamilyInvite(db, priya, await invite('Priya'));
      const familyId = (await familyGroups())[0]!.id;
      const added = await addFamilyMember(db, owner, { name: 'Ben', relationship: 'son' });
      if (!added.ok) throw new Error('add failed');
      await removeFamilyMember(db, owner, added.member.id);
      expect((await personas(familyId)).map((p) => p.name)).not.toContain('Ben');
    });

    it('without a family chat they stay on the roster and in People only', async () => {
      await addFamilyMember(db, owner, { name: 'Ben', relationship: 'son' });
      expect(await familyGroups()).toHaveLength(0);
      expect(await db.selectFrom('personas').select('id').where('name', '=', 'Ben').execute()).toHaveLength(0);
    });
  });
});
