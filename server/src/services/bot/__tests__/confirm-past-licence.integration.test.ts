/**
 * ADR 0319 addendum — `confirmPast` is the user's answer, not the model's.
 *
 * ADR 0100 refuses a past `create_event` / `update_event` and has the bot read
 * the date back; `confirmPast: true` is how the user's "yes, I mean last
 * March" comes back. Nothing enforced the middle step: the flag is an optional
 * boolean, and ADR 0229's addendum records that models through OpenRouter fill
 * every optional field — so the one switch that turns ADR 0100's guard off
 * could arrive on a first attempt, filing a stale-year event silently instead
 * of asking about it. The same bug class as `repeat` (0229), the mail search
 * filters (0279) and `videoCall` (0319).
 *
 * The shape here is the reported one: "add dinner Friday" said on a Saturday,
 * or a date carrying last year, with `confirmPast` filled in beside it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('confirmPast needs a question behind it (ADR 0319 addendum)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  /** A plain past instant, the stale-year / passed-weekday shape. */
  const dayOffset = (days: number): string => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T19:00:00+00:00`;
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: userId, username: 'ro', display_name: 'Ro', created_at: now, shadow: 0 })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Fam',
        kind: 'group',
        invite_code: 'XCONF',
        ingest_email: 'fam-conf@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const create = (args: Record<string, unknown>, turnId: string | null) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      tzOffset: '+00:00',
      call: { name: 'create_event', args } as never,
    });

  const update = (args: Record<string, unknown>, turnId: string | null) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      tzOffset: '+00:00',
      call: { name: 'update_event', args } as never,
    });

  const eventCount = async () =>
    (await db.selectFrom('events').select('id').where('group_id', '=', groupId).execute()).length;

  const startOf = async (id: string) =>
    (await db.selectFrom('events').select('starts_at').where('id', '=', id).executeTakeFirst())
      ?.starts_at;

  describe('create_event', () => {
    it('the reported case: confirmPast on a first attempt is refused, and nothing is written', async () => {
      const res = await create(
        { title: 'Dinner with the Shahs', startsAt: dayOffset(-2), confirmPast: true },
        'turn-1',
      );

      expect(res.data).toMatchObject({ created: false, reason: 'past' });
      expect(await eventCount()).toBe(0);
      // And the model is sent back to ADR 0100's instruction, not told it worked.
      expect(res.summary).toContain('already passed');
      expect(res.summary).toContain('ask whether they meant it');
    });

    it('a retry inside the SAME turn is still refused — the loop cannot answer its own question', async () => {
      const startsAt = dayOffset(-2);
      await create({ title: 'Dinner', startsAt }, 'turn-1');
      const res = await create({ title: 'Dinner', startsAt, confirmPast: true }, 'turn-1');

      expect(res.data).toMatchObject({ created: false, reason: 'past' });
      expect(await eventCount()).toBe(0);
    });

    it("ADR 0100's flow still works: refused, then confirmed in the next turn", async () => {
      const startsAt = dayOffset(-2);
      await create({ title: 'Dinner', startsAt }, 'turn-1');
      const res = await create({ title: 'Dinner', startsAt, confirmPast: true }, 'turn-2');

      expect(res.data).not.toMatchObject({ created: false });
      expect(await eventCount()).toBe(1);
    });

    it('confirms the day that was asked about, not any past day', async () => {
      await create({ title: 'Dinner', startsAt: dayOffset(-2) }, 'turn-1');
      // A different past date was never put to the user.
      const res = await create(
        { title: 'Dinner', startsAt: dayOffset(-400), confirmPast: true },
        'turn-2',
      );

      expect(res.data).toMatchObject({ created: false, reason: 'past' });
      expect(await eventCount()).toBe(0);
    });

    it('the confirmed day survives a write that fails first time round', async () => {
      // A confirmed past date whose call is then refused for an unrelated
      // reason comes back in the same breath; asking twice for one answer is
      // the nag ADR 0100 was written against.
      const startsAt = dayOffset(-2);
      await create({ title: 'Dinner', startsAt }, 'turn-1');
      await create({ title: 'Dinner', startsAt, confirmPast: true }, 'turn-2');
      const res = await create({ title: 'Dinner again', startsAt, confirmPast: true }, 'turn-3');

      expect(res.data).not.toMatchObject({ created: false });
    });

    it('leaves the exemptions alone: no turnId files history as before', async () => {
      await create({ title: 'Imported', startsAt: dayOffset(-30), confirmPast: true }, null);
      expect(await eventCount()).toBe(1);
    });

    it('leaves the exemptions alone: an externalUid-stamped call files history', async () => {
      await create({ title: 'From .ics', startsAt: dayOffset(-30), externalUid: 'uid-conf-1' }, 'turn-1');
      expect(await eventCount()).toBe(1);
    });

    it('a future date with confirmPast filled in is unaffected', async () => {
      await create({ title: 'Picnic', startsAt: dayOffset(4), confirmPast: true }, 'turn-1');
      expect(await eventCount()).toBe(1);
    });
  });

  describe('update_event', () => {
    const seed = async (): Promise<string> => {
      await create({ title: 'Dentist', startsAt: dayOffset(4) }, null);
      const row = await db
        .selectFrom('events')
        .select('id')
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      return row.id;
    };

    it('a confirmPast nobody asked for does not move the event', async () => {
      const id = await seed();
      const before = await startOf(id);
      const res = await update({ eventId: id, startsAt: dayOffset(-2), confirmPast: true }, 'turn-1');

      expect(res.data).toMatchObject({ updated: false, reason: 'past' });
      expect(await startOf(id)).toBe(before);
    });

    it('moves it once the refusal has been answered in a later turn', async () => {
      const id = await seed();
      const past = dayOffset(-2);
      await update({ eventId: id, startsAt: past }, 'turn-1');
      const res = await update({ eventId: id, startsAt: past, confirmPast: true }, 'turn-2');

      expect(res.data).toMatchObject({ updated: true });
      expect((await startOf(id))?.slice(0, 10)).toBe(past.slice(0, 10));
    });

    it("a create_event refusal licenses the same day on update_event — one question, one answer", async () => {
      // The user is asked about the DATE, not about which tool will write it.
      const id = await seed();
      const past = dayOffset(-2);
      await create({ title: 'Dentist', startsAt: past }, 'turn-1');
      const res = await update({ eventId: id, startsAt: past, confirmPast: true }, 'turn-2');

      expect(res.data).toMatchObject({ updated: true });
    });
  });

  it('a past date confirmed in one chat does not license it in another', async () => {
    const otherGroup = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('groups')
      .values({
        id: otherGroup,
        name: 'Other',
        kind: 'group',
        invite_code: 'XCONF2',
        ingest_email: 'other-conf@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: otherGroup, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();

    const startsAt = dayOffset(-2);
    await create({ title: 'Dinner', startsAt }, 'turn-1');

    const res = await applyToolCall(db, {
      groupId: otherGroup,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-2',
      tzOffset: '+00:00',
      call: { name: 'create_event', args: { title: 'Dinner', startsAt, confirmPast: true } } as never,
    });

    expect(res.data).toMatchObject({ created: false, reason: 'past' });
  });
});
