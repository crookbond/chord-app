import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { createGroup } from '@/services/groups.service.js';
import { createList, addItem } from '@/services/lists.service.js';
import { createSave } from '@/services/saves.service.js';
import { createTask } from '@/services/tasks.service.js';
import {
  recordPendingInvitees,
} from '@/services/bot/pending-invites.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('buildLlmContext', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('includes source-surface guidance for bridged turns', async () => {
    const userId = newId('u');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'alice',
        display_name: 'Alice',
        created_at: now,
        shadow: 0,
      })
      .execute();
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: userId,
    });
    const triggerMessageId = newId('m');
    await db
      .insertInto('messages')
      .values({
        id: triggerMessageId,
        group_id: group.id,
        sender_id: userId,
        kind: 'text',
        body: '@Chord tell the local group dinner is at 7',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 1,
        created_at: now,
        source: 'telegram',
        external_message_id: 'tg-1',
        chord_visible: 0,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      })
      .execute();

    const messages = await buildLlmContext(db, {
      groupId: group.id,
      isPersonal: false,
      triggerMessageId,
      triggeringUserId: userId,
      attachments: [],
      useNativeTools: false,
      sourceSurface: { platform: 'telegram' },
    });

    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).toContain(
      'This turn came from the telegram bridge',
    );
    expect(String(messages[0]?.content)).toContain(
      'If the user says "the Chord group", "the group in the app", or "the local group", they mean the native Chord group. Use relay target="chord" for that.',
    );
  });

  describe('bare attachment upload (no tool calls)', () => {
    async function setupAttachmentTrigger(body: string) {
      const userId = newId('u');
      const now = new Date().toISOString();
      await db
        .insertInto('users')
        .values({
          id: userId,
          username: 'alice',
          display_name: 'Alice',
          created_at: now,
          shadow: 0,
        })
        .execute();
      const group = await createGroup(db, {
        name: 'Family',
        kind: 'group',
        createdBy: userId,
      });
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: group.id,
          sender_id: userId,
          kind: 'file',
          body,
          attachment_id: newId('a'),
          reply_to_id: null,
          mentions_bot: 1,
          created_at: now,
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      return { groupId: group.id, triggerMessageId, triggeringUserId: userId };
    }

    // prod incident: an event-invitation photo sent with no caption via
    // WhatsApp — the deterministic auto-filer correctly created the
    // calendar event, but the bot's own turn ALSO called find_events (a
    // read-only tool, so bot.service.ts's silent-autofile suppression never
    // engaged) and replied quoting an unrelated existing event, making it
    // look like the upload had been ignored.
    it('tells the model to call no tool when the attachment has no caption', async () => {
      const { groupId, triggerMessageId, triggeringUserId } =
        await setupAttachmentTrigger('@Chord');

      const messages = await buildLlmContext(db, {
        groupId,
        isPersonal: false,
        triggerMessageId,
        triggeringUserId,
        attachments: [],
        useNativeTools: true,
        triggerHasAttachment: true,
        triggerAttachmentIsImage: true,
        triggerIsBareUpload: true,
      });

      expect(String(messages[0]?.content)).toContain('Do not call any tool this turn');
    });

    it('omits that instruction when the attachment carries an instruction', async () => {
      const { groupId, triggerMessageId, triggeringUserId } = await setupAttachmentTrigger(
        '@Chord what does this say?',
      );

      const messages = await buildLlmContext(db, {
        groupId,
        isPersonal: false,
        triggerMessageId,
        triggeringUserId,
        attachments: [],
        useNativeTools: true,
        triggerHasAttachment: true,
        triggerAttachmentIsImage: true,
        triggerIsBareUpload: false,
      });

      expect(String(messages[0]?.content)).not.toContain('Do not call any tool this turn');
    });
  });

  // PR-G — richer trigger context.
  describe('group snapshot + roster (PR-G)', () => {
    async function setupGroupWithMembers() {
      const owner = await createUser(db, 'alice', 'Alice');
      const member = await createUser(db, 'bob', 'Bob');
      const group = await createGroup(db, {
        name: 'Family',
        kind: 'group',
        createdBy: owner,
      });
      await addMember(db, group.id, member);
      return { owner, member, group };
    }

    async function callBuild(groupId: string, uid: string) {
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: groupId,
          sender_id: uid,
          kind: 'text',
          body: '@Chord what do we have going on',
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 1,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      return buildLlmContext(db, {
        groupId,
        isPersonal: false,
        triggerMessageId,
        triggeringUserId: uid,
        attachments: [],
        useNativeTools: false,
      });
    }

    it('lists every group member, marks the speaker with (you, the speaker)', async () => {
      const { owner, group } = await setupGroupWithMembers();
      const messages = await callBuild(group.id, owner);
      const sys = String(messages[0]?.content);
      expect(sys).toContain('Members of this group:');
      expect(sys).toMatch(/Alice.*\(you, the speaker\).*\[owner\]/);
      expect(sys).toContain('- Bob');
    });

    it('omits the snapshot block entirely when the group has no entities', async () => {
      const { owner, group } = await setupGroupWithMembers();
      const messages = await callBuild(group.id, owner);
      expect(String(messages[0]?.content)).not.toContain("Group's record");
    });

    it("includes counts and up to three sample titles per bucket", async () => {
      const { owner, group } = await setupGroupWithMembers();
      // 4 open tasks → count says 4, samples show first 3.
      for (const title of ['pick up milk', 'book dentist', 'pay rent', 'walk dog']) {
        await createTask(db, { groupId: group.id, title, createdBy: owner });
      }
      const list = await createList(db, { groupId: group.id, name: 'Costco', createdBy: owner });
      await addItem(db, list.id, 'eggs');
      await createSave(db, {
        groupId: group.id,
        kind: 'link',
        title: 'Best ramen in Seattle',
        url: 'https://example.com/ramen',
        tags: [],
        createdBy: owner,
      });

      const sys = String((await callBuild(group.id, owner))[0]?.content);
      expect(sys).toContain("Group's record");
      expect(sys).toMatch(/Tasks \(4 open\):/);
      // listTasks returns most-recent-first, so samples are the latest 3
      // inserted: walk dog, pay rent, book dentist. "pick up milk" was
      // first and falls off the sample window even though the count is 4.
      const snapshot = sys.split("Group's record")[1] ?? '';
      const tasksLine = snapshot.split('\n').find((l) => l.startsWith('Tasks ')) ?? '';
      expect(tasksLine).toContain('"walk dog"');
      expect(tasksLine).toContain('"pay rent"');
      expect(tasksLine).toContain('"book dentist"');
      expect(tasksLine).not.toContain('"pick up milk"');
      expect(sys).toMatch(/Lists \(1\):/);
      expect(sys).toContain('"Costco"');
      expect(sys).toMatch(/Saves \(1\):/);
      expect(sys).toContain('"Best ramen in Seattle"');
    });

    it('clips long titles to keep the snapshot terse', async () => {
      const { owner, group } = await setupGroupWithMembers();
      const longTitle = 'a'.repeat(200);
      await createTask(db, { groupId: group.id, title: longTitle, createdBy: owner });
      const sys = String((await callBuild(group.id, owner))[0]?.content);
      // Scope the clip assertion to the snapshot block — the cross-group
      // personal context block (ADR 0020) renders the full title and
      // doesn't go through the snapshot's clip helper.
      const snapshot = sys.split("Group's record")[1]?.split('\n\n')[0] ?? '';
      expect(snapshot).toContain('a'.repeat(59) + '…');
      expect(snapshot).not.toContain('a'.repeat(100));
    });

    it('done tasks do not inflate the open-task count', async () => {
      const { owner, group } = await setupGroupWithMembers();
      const t1 = await createTask(db, { groupId: group.id, title: 'open', createdBy: owner });
      const t2 = await createTask(db, { groupId: group.id, title: 'closed', createdBy: owner });
      await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', t2.id).execute();
      void t1;
      const sys = String((await callBuild(group.id, owner))[0]?.content);
      expect(sys).toMatch(/Tasks \(1 open\)/);
      expect(sys).toContain('"open"');
      expect(sys).not.toContain('"closed"');
    });

    it('personal chats skip the roster but keep the snapshot', async () => {
      const owner = await createUser(db, 'solo', 'Solo');
      const group = await createGroup(db, {
        name: 'Solo personal',
        kind: 'personal',
        createdBy: owner,
      });
      await createTask(db, { groupId: group.id, title: 'me-task', createdBy: owner });
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: group.id,
          sender_id: owner,
          kind: 'text',
          body: '@Chord status?',
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 1,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: true,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: false,
      });
      const sys = String(messages[0]?.content);
      expect(sys).not.toContain('Members of this group:');
      expect(sys).toContain("Group's record");
      expect(sys).toContain('"me-task"');
    });

    it('surfaces the weather/briefing location in a 1:1, with the raw signals', async () => {
      const owner = await createUser(db, 'ro', 'Ro');
      const group = await createGroup(db, {
        name: 'Ro personal',
        kind: 'personal',
        createdBy: owner,
      });
      await db
        .updateTable('users')
        .set({
          weather_place: 'Barcelona',
          weather_place_source: 'user',
          last_tz: 'Europe/Madrid',
          weather_ip_place: 'San Jose',
        })
        .where('id', '=', owner)
        .execute();
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: group.id,
          sender_id: owner,
          kind: 'text',
          body: '@Chord what is my location?',
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 1,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: true,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: false,
      });
      const sys = String(messages[0]?.content);
      expect(sys).toContain('USER LOCATION');
      expect(sys).toContain('In use: Barcelona — the user set this');
      expect(sys).toContain('San Jose from the IP address');
      expect(sys).toContain('Madrid from the device timezone');
    });

    it('does not surface the location block in a shared group', async () => {
      const owner = await createUser(db, 'sh', 'Sh');
      const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });
      await db
        .updateTable('users')
        .set({ weather_place: 'Barcelona', weather_place_source: 'user' })
        .where('id', '=', owner)
        .execute();
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: group.id,
          sender_id: owner,
          kind: 'text',
          body: '@Chord where am I?',
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 1,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: false,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: false,
      });
      expect(String(messages[0]?.content)).not.toContain('USER LOCATION');
    });
  });

  // ADR 0166 — a pending invitee's email must be answerable on a later turn,
  // not just the turn create_event/update_event returned unresolvedInvitees.
  describe('pending invitees reminder (ADR 0166)', () => {
    async function setupPersonal() {
      const owner = await createUser(db, 'ro', 'Ro');
      const group = await createGroup(db, { name: 'Ro', kind: 'personal', createdBy: owner });
      const triggerMessageId = newId('m');
      await db
        .insertInto('messages')
        .values({
          id: triggerMessageId,
          group_id: group.id,
          sender_id: owner,
          kind: 'text',
          body: "Karl is at karl@media.example",
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 0,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();
      return { owner, group, triggerMessageId };
    }

    it('surfaces a pending invitee so a later turn can resolve it', async () => {
      const { owner, group, triggerMessageId } = await setupPersonal();
      await recordPendingInvitees(db, group.id, owner, 'evt_123', 'Meet Karl', ['Karl Dale']);

      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: true,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: true,
      });

      const sys = String(messages[0]?.content);
      expect(sys).toContain('Invitees still waiting on an email address');
      expect(sys).toContain('"Karl Dale" for event "Meet Karl" (id evt_123)');
      expect(sys).toContain('call update_event');
    });

    it('says nothing when there is no pending invitee', async () => {
      const { owner, group, triggerMessageId } = await setupPersonal();
      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: true,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: true,
      });
      expect(String(messages[0]?.content)).not.toContain('Invitees still waiting');
    });

    it('clears once the invitee is recorded as resolved', async () => {
      const { owner, group, triggerMessageId } = await setupPersonal();
      await recordPendingInvitees(db, group.id, owner, 'evt_123', 'Meet Karl', ['Karl Dale']);
      await recordPendingInvitees(db, group.id, owner, 'evt_123', 'Meet Karl', []);

      const messages = await buildLlmContext(db, {
        groupId: group.id,
        isPersonal: true,
        triggerMessageId,
        triggeringUserId: owner,
        attachments: [],
        useNativeTools: true,
      });
      expect(String(messages[0]?.content)).not.toContain('Invitees still waiting');
    });
  });
});
