/**
 * ADR 0232 — personal first, fan-out next.
 *
 * An event made in the 1:1 chat is one copy on the asker's own calendar. It
 * reaches a group only if the user names the group, or says yes to an offer —
 * and an offer is only ever a sentence: it never shares anything by itself.
 * A group chat still fans out, and each member's copy lands on THEIR calendar.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR 0295 — guests are read from the calendar; stand in for that read (and
// for the video link on it, and for asking the calendar for a new one).
const providerGuests = vi.hoisted(() => ({ emails: [] as string[], videoCallLink: null as string | null }));
const videoCalls = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('@/services/events/guests.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/events/guests.service.js')>()),
  providerGuestEmails: vi.fn(async () => providerGuests.emails),
  providerEventPeople: vi.fn(async () => ({
    guests: providerGuests.emails,
    organizer: null,
    videoCallLink: providerGuests.videoCallLink,
  })),
  addVideoCall: vi.fn(async (_db: unknown, a: { eventId: string }) => {
    videoCalls.asked.push(a.eventId);
    return { ok: true, kind: 'google_meet', link: 'https://meet.google.com/new-link', already: false };
  }),
}));

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { getPendingFanout } from '@/services/bot/pending-fanout.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const soon = (days = 5): string => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T19:00:00-04:00`;
};

describe('personal first, fan-out next (ADR 0232)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let personalId: string;
  let familyId: string;

  const run = (name: string, args: Record<string, unknown>, groupId = personalId, actor = john) =>
    applyToolCall(db, {
      groupId,
      actorUserId: actor,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      tzOffset: '-04:00',
      call: { name, args } as never,
    });

  const copies = (title: string) =>
    db
      .selectFrom('events')
      .select(['owner_user_id', 'group_id', 'google_calendar_id'])
      .where('title', '=', title)
      .execute();

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Rao');
    // A live Google connection: the calendar named in a reply is only true when
    // the event can reach it.
    await db
      .updateTable('users')
      .set({
        refresh_token_scopes: 'openid https://www.googleapis.com/auth/calendar',
        google_connected_at: new Date().toISOString(),
      })
      .where('id', '=', john)
      .execute();
    personalId = (await ensurePersonalGroup(db, john)).id;
    familyId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true })).id;
    await addMember(db, familyId, priya);
  });
  afterEach(async () => closeTestDb(db));

  describe('the default is personal', () => {
    it('a 1:1 event is ONE copy on the asker\'s own calendar — nobody else gets it', async () => {
      const res = await run('create_event', { title: 'Dentist', startsAt: soon() });
      expect(res.summary).toMatch(/added to your primary calendar/i);
      const rows = await copies('Dentist');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_user_id: john, group_id: personalId, google_calendar_id: 'primary' });
    });

    it('a group-chat event still fans out, and each member\'s copy lands on THEIR calendar', async () => {
      await db.updateTable('users').set({ default_calendar_id: 'priya-own-cal' }).where('id', '=', priya).execute();
      await run('create_event', { title: 'Soccer', startsAt: soon() }, familyId);
      const rows = await copies('Soccer');
      expect(rows.map((r) => r.owner_user_id).sort()).toEqual([priya, john].sort());
      const by = Object.fromEntries(rows.map((r) => [r.owner_user_id, r.google_calendar_id]));
      expect(by[john]).toBe('primary');
      expect(by[priya]).toBe('priya-own-cal');
    });

    it('naming a calendar is for that event only: the group remembers nothing', async () => {
      await run('create_event', { title: 'Team sync', startsAt: soon(), calendar: 'family' }, familyId);
      const g = await db.selectFrom('groups').select('default_calendar_id').where('id', '=', familyId).executeTakeFirstOrThrow();
      expect(g.default_calendar_id).toBeNull();
    });
  });

  // ADR 0232 addendum 2026-10-25: an event is created in the chat it was asked
  // in. A group name from the model (the field is gone from the schema; these
  // send it anyway) never moves it.
  describe('a group name from the 1:1', () => {
    it('a real group named by the model does not take the event: one personal copy', async () => {
      const res = await run('create_event', { title: 'Family dinner', startsAt: soon(), withGroupName: 'Doe Family' });
      expect(res.data).not.toMatchObject({ created: false });
      const rows = await copies('Family dinner');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_user_id: john, group_id: personalId });
    });

    it('a group that does not exist is created personally, and no group is mentioned', async () => {
      const res = await run('create_event', { title: 'Lost', startsAt: soon(), withGroupName: 'No Such Group' });
      expect(res.summary).not.toMatch(/no group is called/);
      expect(res.summary).toMatch(/added to your primary calendar/i);
      expect((res.data as { candidates?: unknown } | undefined)?.candidates).toBeUndefined();
      const rows = await copies('Lost');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_user_id: john, group_id: personalId });
    });

    // Prod 2026-10-12: "Add to calendar move Car on Thursday at 8 AM" arrived
    // four times as withGroupName "/personal" (the log line read `group
    // "/personal" did not resolve — nothing was created`), and the refusal
    // carried all seven of the asker's chats, which the bot read back as
    // calendars.
    describe('prod: withGroupName "/personal" on "Move Car"', () => {
      const chats = ['ChordTester', 'UWS Mazaa', 'John and Ben'];
      beforeEach(async () => {
        for (const name of chats) {
          const g = await createGroup(db, { name, kind: 'group', createdBy: john, nameIsCustom: true });
          await addMember(db, g.id, priya);
        }
      });

      it.each(['/personal', 'Personal', 'personal calendar', 'my own default calendar', 'just me'])(
        '%s means the asker: one personal copy, no question, no list of chats',
        async (withGroupName) => {
          const res = await run('create_event', { title: 'Move Car', startsAt: soon(), withGroupName });
          expect(res.summary).toMatch(/added to your primary calendar/i);
          expect(res.summary).not.toMatch(/no group is called/);
          expect(JSON.stringify(res)).not.toMatch(/ChordTester|UWS Mazaa|John and Ben|Doe Family/);
          const rows = await copies('Move Car');
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ owner_user_id: john, group_id: personalId, google_calendar_id: 'primary' });
        },
      );

      it('calendar "/personal" is the primary calendar, not a calendar that could not be found', async () => {
        const res = await run('create_event', { title: 'Move Car', startsAt: soon(), calendar: '/personal' });
        expect(res.summary).toMatch(/added to your primary calendar/i);
        expect(res.summary).not.toMatch(/could not find a calendar/);
      });

      it('a made-up group name never brings the chat roster back', async () => {
        const res = await run('create_event', { title: 'Move Car', startsAt: soon(), withGroupName: 'Errands' });
        expect(JSON.stringify(res)).not.toMatch(/ChordTester|UWS Mazaa|John and Ben|Doe Family/);
        expect(await copies('Move Car')).toHaveLength(1);
      });
    });

    it('a near miss of a group name is neither used nor offered', async () => {
      const res = await run('create_event', { title: 'Brunch', startsAt: soon(), withGroupName: 'Family' });
      expect((res.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
      const rows = await copies('Brunch');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_id).toBe(personalId);
    });

    it('the asker\'s own name is not a group: it is just personal', async () => {
      await run('create_event', { title: 'Haircut', startsAt: soon(), withGroupName: 'John Doe' });
      const rows = await copies('Haircut');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_id).toBe(personalId);
    });

    it('is ignored inside a shared group chat (events there already reach every member)', async () => {
      const other = (await createGroup(db, { name: 'Soccer Team', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      await run('create_event', { title: 'Practice', startsAt: soon(), withGroupName: 'Soccer Team' }, familyId);
      expect((await copies('Practice')).every((r) => r.group_id === familyId)).toBe(true);
      expect(other).toBeTruthy();
    });
  });

  describe('the offer', () => {
    it('a personal event naming a group member OFFERS that group — and shares nothing', async () => {
      const res = await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      const data = res.data as { fanoutSuggestion?: { groups: string[]; instruction: string } };
      expect(data.fanoutSuggestion?.groups).toEqual(['Doe Family']);
      expect(data.fanoutSuggestion?.instruction).toMatch(/Do NOT share it unless they say yes/);
      // Still exactly one copy, still personal.
      const rows = await copies('Dinner with Priya');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_id).toBe(personalId);
      expect((await getPendingFanout(db, personalId, john))?.groups).toEqual(['Doe Family']);
    });

    it('no member named, no offer', async () => {
      const res = await run('create_event', { title: 'Dentist', startsAt: soon() });
      expect((res.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
      expect(await getPendingFanout(db, personalId, john)).toBeNull();
    });

    it('the asker\'s own name is no signal', async () => {
      const res = await run('create_event', { title: 'John checkup', startsAt: soon() });
      expect((res.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
    });

    it('matches a whole word only — "Priyanka" is not Priya', async () => {
      const res = await run('create_event', { title: 'Lunch with Priyanka', startsAt: soon() });
      expect((res.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
    });

    it('a managed family member (a child on the roster) counts as someone named', async () => {
      await createPersona(db, { groupId: familyId, name: 'Aarav', householdRole: 'child', managedBy: john });
      const res = await run('create_event', { title: 'Aarav soccer game', startsAt: soon() });
      expect((res.data as { fanoutSuggestion?: { groups: string[] } }).fanoutSuggestion?.groups).toEqual(['Doe Family']);
    });

    it('a person in several of the asker\'s groups gets ALL of them offered, to ask which', async () => {
      const friends = (await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      await addMember(db, friends, priya);
      const res = await run('create_event', { title: 'Drinks with Priya', startsAt: soon() });
      const groups = (res.data as { fanoutSuggestion: { groups: string[] } }).fanoutSuggestion.groups;
      expect(groups.sort()).toEqual(['Doe Family', 'Friends']);
    });

    it('never offers a group the asker is not in', async () => {
      const stranger = await createUser(db, 'stranger', 'Zed Quill');
      await createGroup(db, { name: 'Quill Club', kind: 'group', createdBy: stranger });
      const res = await run('create_event', { title: 'Coffee with Zed', startsAt: soon() });
      expect((res.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
    });

    it('is not made inside a shared group chat, or for a repeating event', async () => {
      const inGroup = await run('create_event', { title: 'Dinner with Priya', startsAt: soon() }, familyId);
      expect((inGroup.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
      const repeating = await run('create_event', {
        title: 'Yoga with Priya',
        startsAt: soon(),
        repeat: { frequency: 'weekly' },
      });
      expect((repeating.data as { fanoutSuggestion?: unknown } | undefined)?.fanoutSuggestion).toBeUndefined();
    });

    it('reaches the next turn: a plain "yes" has the offer in its system prompt', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      const trigger = await insertMessage(db, { groupId: personalId, senderId: john, body: 'yes' });
      const messages = await buildLlmContext(db, {
        groupId: personalId,
        isPersonal: true,
        triggerMessageId: trigger.id,
        triggeringUserId: john,
        attachments: [],
        useNativeTools: true,
      });
      const sys = String(messages[0]?.content);
      expect(sys).toContain('You just offered to put the event "Dinner with Priya"');
      expect(sys).toContain('"Doe Family"');
      expect(sys).toContain('call share_event');
      // ...and a shared group chat never sees it.
      const gTrigger = await insertMessage(db, { groupId: familyId, senderId: john, body: 'yes' });
      const groupMessages = await buildLlmContext(db, {
        groupId: familyId,
        isPersonal: false,
        triggerMessageId: gTrigger.id,
        triggeringUserId: john,
        attachments: [],
        useNativeTools: true,
      });
      expect(String(groupMessages[0]?.content)).not.toContain('You just offered');
    });
  });

  describe('share_event (the yes)', () => {
    it('moves the offered event onto the group: every member gets a copy, the personal original is gone', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      const res = await run('share_event', {});
      expect(res.data).toMatchObject({ ok: true, group: 'Doe Family' });
      const rows = await copies('Dinner with Priya');
      expect(rows.map((r) => r.owner_user_id).sort()).toEqual([priya, john].sort());
      expect(new Set(rows.map((r) => r.group_id))).toEqual(new Set([familyId]));
      // The offer is spent: a second "yes" shares nothing.
      expect((await run('share_event', {})).data).toMatchObject({ ok: false, reason: 'nothing_pending' });
      expect(await copies('Dinner with Priya')).toHaveLength(2);
    });

    it('with several groups offered it asks which, and shares to the one named', async () => {
      const friends = (await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      await addMember(db, friends, priya);
      await run('create_event', { title: 'Drinks with Priya', startsAt: soon() });
      expect((await run('share_event', {})).data).toMatchObject({ ok: false, reason: 'which_group' });
      const res = await run('share_event', { withGroupName: 'Friends' });
      expect(res.data).toMatchObject({ ok: true, group: 'Friends' });
      expect(new Set((await copies('Drinks with Priya')).map((r) => r.group_id))).toEqual(new Set([friends]));
    });

    it('refuses when nothing was offered — it never shares on its own', async () => {
      await run('create_event', { title: 'Dentist', startsAt: soon() });
      expect((await run('share_event', {})).data).toMatchObject({ ok: false, reason: 'nothing_pending' });
      expect(await copies('Dentist')).toHaveLength(1);
    });

    it('refuses an event with invited guests, and leaves it exactly where it is', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      providerGuests.emails = ['guest@example.com'];
      try {
        expect((await run('share_event', {})).data).toMatchObject({ ok: false, reason: 'has_guests' });
      } finally {
        providerGuests.emails = [];
      }
      expect(await copies('Dinner with Priya')).toHaveLength(1);
    });

    // Bug (2026-11-10 audit): share_event re-created the event from title,
    // times and location only, and resolved a fresh calendar - so the calendar
    // the user picked, the ADR 0162 context note, the zone, free/busy and the
    // provenance were all dropped on the way to the family.
    it('the shared copy keeps everything the original had: calendar, note, zone, free/busy, provenance', async () => {
      const now = new Date().toISOString();
      await db
        .insertInto('calendar_sources')
        .values({
          id: 'cs-family',
          user_id: john,
          provider: 'google',
          google_calendar_id: 'family-cal@group.calendar.google.com',
          summary: 'Family',
          access_role: 'owner',
          is_primary: 0,
          selected_in_google: 1,
          counts_for_busy_auto: 1,
          counts_for_busy_override: null,
          first_seen_at: now,
          last_seen_at: now,
        })
        .execute();
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      await db
        .updateTable('events')
        .set({
          google_calendar_id: 'family-cal@group.calendar.google.com',
          description: 'Context: "Dinner with Priya Friday" — John',
          start_tz: 'America/Los_Angeles',
          end_tz: 'America/Los_Angeles',
          transparency: 'transparent',
          source_raw_context: 'chat:m_original',
        })
        .where('title', '=', 'Dinner with Priya')
        .execute();
      expect((await run('share_event', {})).data).toMatchObject({ ok: true });
      const rows = await db
        .selectFrom('events')
        .select(['owner_user_id', 'group_id', 'google_calendar_id', 'description', 'start_tz', 'end_tz', 'transparency', 'source_raw_context'])
        .where('title', '=', 'Dinner with Priya')
        .execute();
      expect(rows).toHaveLength(2);
      const mine = rows.find((r) => r.owner_user_id === john)!;
      expect(mine).toMatchObject({
        group_id: familyId,
        google_calendar_id: 'family-cal@group.calendar.google.com',
        description: 'Context: "Dinner with Priya Friday" — John',
        start_tz: 'America/Los_Angeles',
        end_tz: 'America/Los_Angeles',
        transparency: 'transparent',
        source_raw_context: 'chat:m_original',
      });
      // The other member's copy carries the same zone and note, on her own calendar.
      expect(rows.find((r) => r.owner_user_id === priya)).toMatchObject({
        start_tz: 'America/Los_Angeles',
        description: 'Context: "Dinner with Priya Friday" — John',
        google_calendar_id: 'primary',
      });
    });

    it('an all-day event stays all-day', async () => {
      const day = soon().slice(0, 10);
      await run('create_event', { title: 'Priya visiting', startsAt: `${day}T00:00:00` });
      // Stored with an offset, so only the flag says it is all-day.
      await db
        .updateTable('events')
        .set({ all_day: 1, starts_at: `${day}T00:00:00-04:00` })
        .where('title', '=', 'Priya visiting')
        .execute();
      expect((await run('share_event', {})).data).toMatchObject({ ok: true });
      const rows = await db
        .selectFrom('events')
        .select(['all_day', 'group_id'])
        .where('title', '=', 'Priya visiting')
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.all_day === 1 && r.group_id === familyId)).toBe(true);
    });

    it('a calendar the user can no longer write to falls back, and the reply says so', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      await db
        .updateTable('events')
        .set({ google_calendar_id: 'gone-cal@group.calendar.google.com' })
        .where('title', '=', 'Dinner with Priya')
        .execute();
      const res = await run('share_event', {});
      expect(res.data).toMatchObject({ ok: true });
      expect(res.summary).toMatch(/can no longer be written to/);
      const mine = await db
        .selectFrom('events')
        .select('google_calendar_id')
        .where('title', '=', 'Dinner with Priya')
        .where('owner_user_id', '=', john)
        .executeTakeFirstOrThrow();
      expect(mine.google_calendar_id).toBe('primary');
    });

    it('an event for a family member stays theirs on the group', async () => {
      const here = await createPersona(db, { groupId: personalId, name: 'Aarav', householdRole: 'child', managedBy: john });
      const there = await createPersona(db, { groupId: familyId, name: 'Aarav', householdRole: 'child', managedBy: john });
      await run('create_event', { title: 'Aarav soccer game', startsAt: soon() });
      await db
        .updateTable('events')
        .set({ assignee_persona_id: here.id, title: 'Aarav — Aarav soccer game' })
        .where('title', '=', 'Aarav soccer game')
        .execute();
      expect((await run('share_event', {})).data).toMatchObject({ ok: true });
      const rows = await db
        .selectFrom('events')
        .select(['group_id', 'assignee_persona_id', 'title', 'owner_user_id'])
        .where('title', 'like', '%soccer game')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        group_id: familyId,
        assignee_persona_id: there.id,
        title: 'Aarav — Aarav soccer game',
        owner_user_id: john,
      });
    });

    it('a video call cannot move with it: a new one is asked for, and the reply says the old link changed', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      providerGuests.videoCallLink = 'https://meet.google.com/old-link';
      videoCalls.asked = [];
      try {
        const res = await run('share_event', {});
        expect(res.data).toMatchObject({ ok: true });
        const mine = await db
          .selectFrom('events')
          .select('id')
          .where('title', '=', 'Dinner with Priya')
          .where('owner_user_id', '=', john)
          .executeTakeFirstOrThrow();
        expect(videoCalls.asked).toEqual([mine.id]);
        expect(res.summary).toContain('https://meet.google.com/new-link');
        expect(res.summary).toMatch(/old video link .*old-link.* no longer works/);
      } finally {
        providerGuests.videoCallLink = null;
      }
    });

    it('says the event is gone if it was deleted before the yes', async () => {
      await run('create_event', { title: 'Dinner with Priya', startsAt: soon() });
      await db.deleteFrom('events').where('title', '=', 'Dinner with Priya').execute();
      expect((await run('share_event', {})).data).toMatchObject({ ok: false, reason: 'event_gone' });
    });

    it('is personal-chat only', async () => {
      expect((await run('share_event', {}, familyId)).data).toMatchObject({ ok: false, reason: 'personal_only' });
    });
  });
});
