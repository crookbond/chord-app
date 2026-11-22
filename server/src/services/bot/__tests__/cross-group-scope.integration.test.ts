/**
 * ADR 0032 — strict per-group scope for bot reads.
 *
 * In a group chat the bot may only reason over items tagged with that
 * group's id. Items created (or synced) in another group the user
 * happens to belong to must never appear, even when the asker is the
 * same user.
 *
 * These tests cover both halves of the defense:
 *   - pre-filter:  find_events SQL scopes to the current group.
 *   - post-filter: scrubCrossGroupLeak drops any payload entry whose
 *                  groupId field doesn't match the call's groupId.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { applyToolCall, __testing } from '@/services/bot/executor.js';
import { createEvent, getEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addImportantDate, createPerson } from '@/services/people.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const { scrubCrossGroupLeak } = __testing;

describe('find_events strict per-group scope (pre-filter)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it("only returns events tagged with the calling group, not other groups the user is in", async () => {
    const uid = await createUser(db, 'alice');
    const here = await createGroup(db, { name: 'Here', kind: 'group', createdBy: uid });
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: uid });

    await createEvent(db, {
      groupId: here.id,
      title: 'In-scope dinner',
      startsAt: '2026-06-01T18:00:00Z',
      createdBy: uid,
    });
    await createEvent(db, {
      groupId: other.id,
      title: 'OTHER GROUP appointment',
      startsAt: '2026-06-01T10:00:00Z',
      createdBy: uid,
    });

    const result = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'find_events',
        args: { startDate: '2026-06-01', endDate: '2026-06-30' },
      },
    });

    const events = (result.data as { events: { title: string; groupId: string }[] }).events;
    expect(events.map((e) => e.title)).toEqual(['In-scope dinner']);
    // belt and suspenders: every returned event is tagged with the calling group
    for (const e of events) expect(e.groupId).toBe(here.id);
  });
});

describe('scrubCrossGroupLeak (post-filter)', () => {
  it('drops array entries whose groupId field differs from the call group', () => {
    const out = scrubCrossGroupLeak(
      {
        summary: 'demo',
        data: {
          events: [
            { id: 'e1', groupId: 'g-here', title: 'ok' },
            { id: 'e2', groupId: 'g-other', title: 'LEAK' },
            { id: 'e3', groupId: 'g-here', title: 'ok2' },
          ],
        },
      },
      'g-here',
    );
    const events = (out.data as { events: { id: string }[] }).events;
    expect(events.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('walks nested objects', () => {
    const out = scrubCrossGroupLeak(
      {
        summary: 'demo',
        data: {
          group: {
            saves: [
              { id: 's1', groupId: 'g-here' },
              { id: 's2', groupId: 'g-bad' },
            ],
            tasks: [
              { id: 't1', groupId: 'g-bad' },
              { id: 't2' /* no groupId — left alone */ },
            ],
          },
        },
      },
      'g-here',
    );
    const data = out.data as {
      group: { saves: { id: string }[]; tasks: { id: string }[] };
    };
    expect(data.group.saves.map((s) => s.id)).toEqual(['s1']);
    expect(data.group.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('leaves payloads without any groupId fields untouched (identity)', () => {
    const result = {
      summary: 'demo',
      data: { tasks: [{ id: 't1', title: 'x' }] },
    };
    const out = scrubCrossGroupLeak(result, 'g-here');
    expect(out).toBe(result);
  });

  it('handles missing/null data', () => {
    expect(scrubCrossGroupLeak({ summary: 'a' }, 'g').data).toBeUndefined();
    expect(scrubCrossGroupLeak({ summary: 'a', data: null }, 'g').data).toBeNull();
  });
});

describe('personal-chat block: owner-scoped people + important dates', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function setupUserWithPeople(): Promise<{ uid: string; groupId: string }> {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
    const mom = await createPerson(db, { ownerUserId: uid, displayName: 'Mom', notes: 'no nuts' });
    await addImportantDate(db, {
      personId: mom.id,
      kind: 'birthday',
      date: '0000-05-20',
      recurs: true,
    });
    return { uid, groupId: g.id };
  }

  async function seedTriggerMessage(
    db: Kysely<DB>,
    groupId: string,
    senderId: string,
  ): Promise<string> {
    const id = newId('m');
    const now = new Date().toISOString();
    await db
      .insertInto('messages')
      .values({
        id,
        group_id: groupId,
        sender_id: senderId,
        kind: 'text',
        body: 'hi',
        attachment_id: null,
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
    return id;
  }

  it('inlines people + important days in a personal (1:1) chat', async () => {
    const { uid, groupId } = await setupUserWithPeople();
    const triggerId = await seedTriggerMessage(db, groupId, uid);
    const ctx = await buildLlmContext(db, {
      groupId,
      isPersonal: true,
      triggerMessageId: triggerId,
      triggeringUserId: uid,
      attachments: [],
      useNativeTools: false,
    });
    const system = ctx[0].content;
    expect(system).toContain('YOUR_SAVED_PEOPLE');
    expect(system).toContain('Mom');
    expect(system).toContain('birthday');
  });

  it('omits people + important days in a group chat (no group_id tag)', async () => {
    const uid = await createUser(db, 'alice');
    const grp = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    const mom = await createPerson(db, { ownerUserId: uid, displayName: 'Mom' });
    await addImportantDate(db, {
      personId: mom.id,
      kind: 'birthday',
      date: '0000-05-20',
      recurs: true,
    });
    const triggerId = await seedTriggerMessage(db, grp.id, uid);
    const ctx = await buildLlmContext(db, {
      groupId: grp.id,
      isPersonal: false,
      triggerMessageId: triggerId,
      triggeringUserId: uid,
      attachments: [],
      useNativeTools: false,
    });
    const system = ctx[0].content;
    expect(system).not.toContain('YOUR_SAVED_PEOPLE');
    expect(system).not.toContain('Mom');
  });
});

describe('delete_event cross-group conflict resolution (owner-scoped)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // The conflict nudge (renderEventConflictNudge) computes conflicts across ALL
  // the user's groups (owner-scoped, no groupId). When the bot is then asked to
  // "drop one", the event it must remove can live in a DIFFERENT group than the
  // one the conversation sits in. delete_event must reach it — otherwise it
  // returns deleted:false and the bot claims a drop that never happened.
  it('deletes the actor own event by id even when it lives in another group', async () => {
    const alice = await createUser(db, 'alice');
    const here = await createGroup(db, { name: 'Here', kind: 'group', createdBy: alice });
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice });

    await createEvent(db, {
      groupId: here.id,
      title: 'Go for brunch',
      startsAt: '2026-06-06T11:00:00Z',
      createdBy: alice,
    });
    const otherEv = await createEvent(db, {
      groupId: other.id,
      title: 'Go for brunch',
      startsAt: '2026-06-06T11:00:00Z',
      createdBy: alice,
    });

    const result = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: alice,
      provenance: null,
      call: { name: 'delete_event', args: { eventId: otherEv.id } },
    });

    expect((result.data as { deleted: boolean }).deleted).toBe(true);
    expect(await getEvent(db, otherEv.id)).toBeNull();
  });

  it('widens a titleContains match to the actor own copies when none match in-group', async () => {
    const alice = await createUser(db, 'alice');
    const here = await createGroup(db, { name: 'Here', kind: 'group', createdBy: alice });
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice });

    await createEvent(db, {
      groupId: other.id,
      title: 'Dentist appointment',
      startsAt: '2026-06-06T09:00:00Z',
      createdBy: alice,
    });

    const result = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: alice,
      provenance: null,
      call: { name: 'delete_event', args: { titleContains: 'dentist' } },
    });

    expect((result.data as { deleted: boolean }).deleted).toBe(true);
  });

  it('returns candidates (deleted:false) when multiple match — no destructive guess', async () => {
    const alice = await createUser(db, 'alice');
    const here = await createGroup(db, { name: 'Here', kind: 'group', createdBy: alice });
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice });

    // Both live outside the conversation group, so the single-delete path widens
    // to the owner-scoped pool and finds two — the disambiguation case.
    const a = await createEvent(db, {
      groupId: other.id,
      title: 'Go for brunch',
      startsAt: '2026-06-06T11:00:00Z',
      createdBy: alice,
    });
    const b = await createEvent(db, {
      groupId: other.id,
      title: 'Go for brunch',
      startsAt: '2026-06-07T11:00:00Z',
      createdBy: alice,
    });

    const result = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: alice,
      provenance: null,
      call: { name: 'delete_event', args: { titleContains: 'brunch' } },
    });

    expect((result.data as { deleted: boolean }).deleted).toBe(false);
    expect((result.data as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(await getEvent(db, a.id)).not.toBeNull();
    expect(await getEvent(db, b.id)).not.toBeNull();
  });

  it('refuses to delete another user event across groups (owner guard)', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const here = await createGroup(db, { name: 'Here', kind: 'group', createdBy: alice });
    const bobs = await createGroup(db, { name: 'Bobs', kind: 'group', createdBy: bob });

    const bobEv = await createEvent(db, {
      groupId: bobs.id,
      title: 'Bob private thing',
      startsAt: '2026-06-06T11:00:00Z',
      createdBy: bob,
    });

    const result = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: alice,
      provenance: null,
      call: { name: 'delete_event', args: { eventId: bobEv.id } },
    });

    expect((result.data as { deleted: boolean }).deleted).toBe(false);
    expect(await getEvent(db, bobEv.id)).not.toBeNull();
  });
});
