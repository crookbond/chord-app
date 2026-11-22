/**
 * A past `create_event` is a typo until the user says otherwise.
 *
 * The failure this pins: the model reads "add dinner Friday" on a Saturday, or
 * carries a stale year, and Chord silently files an event nobody will ever
 * attend. Nothing in the product needs the bot to record history, so the write
 * is refused and handed back for confirmation.
 *
 * The exemptions matter as much as the guard: ingest, ICS import and proposal
 * confirm DO file history, and they are identified by carrying no `turnId`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('create_event past-date guard', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  const dayOffset = (days: number): string => {
    const d = new Date(Date.now() + days * 86400000);
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
        invite_code: 'XPAST',
        ingest_email: 'fam-past@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({
        group_id: groupId,
        user_id: userId,
        role: 'owner',
        tier: 'verified',
        joined_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  function create(args: Record<string, unknown>, turnId: string | null) {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      tzOffset: '+00:00',
      call: { name: 'create_event', args },
    });
  }

  function createFromFile(args: Record<string, unknown>, turnId: string | null) {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      tzOffset: '+00:00',
      triggerFromAttachment: true,
      call: { name: 'create_event', args },
    });
  }

  const eventCount = async () =>
    (await db.selectFrom('events').select('id').where('group_id', '=', groupId).execute()).length;

  it('refuses a past start on a bot turn and writes nothing', async () => {
    const res = await create({ title: 'Game night', startsAt: dayOffset(-3) }, 'turn-1');

    expect(res.data).toMatchObject({ created: false, reason: 'past' });
    expect(await eventCount()).toBe(0);
    // The summary is what the model reads back — it has to say the write did
    // not happen, or the bot confirms an event that does not exist.
    expect(res.summary).toContain('already passed');
  });

  it('creates it once the user confirms with confirmPast', async () => {
    const startsAt = dayOffset(-3);
    await create({ title: 'Game night', startsAt }, 'turn-1');
    const res = await create({ title: 'Game night', startsAt, confirmPast: true }, 'turn-2');

    expect(res.data).not.toMatchObject({ created: false });
    expect(await eventCount()).toBe(1);
  });

  it('allows a future start unchanged', async () => {
    await create({ title: 'Picnic', startsAt: dayOffset(3) }, 'turn-1');
    expect(await eventCount()).toBe(1);
  });

  it("allows today's all-day event (floating midnight)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await create({ title: 'Field trip', startsAt: `${today}T00:00:00` }, 'turn-1');
    expect(await eventCount()).toBe(1);
  });

  it('leaves non-conversational callers (no turnId) alone', async () => {
    await create({ title: 'Imported past event', startsAt: dayOffset(-30) }, null);
    expect(await eventCount()).toBe(1);
  });

  it('leaves externalUid-stamped calls alone', async () => {
    await create(
      { title: 'From an .ics', startsAt: dayOffset(-30), externalUid: 'uid-past-1' },
      'turn-1',
    );
    expect(await eventCount()).toBe(1);
  });

  /**
   * ADR 0155 — a past date read from an uploaded file (a school calendar, a
   * term schedule) is history the document states, not a typo. Still no write,
   * but the model is told not to ask — only the future rows become events.
   */
  describe('from a file (ADR 0155)', () => {
    it('refuses a past start silently — no write, and the model is told not to ask', async () => {
      const res = await createFromFile({ title: 'Sept assembly', startsAt: dayOffset(-40) }, 'turn-1');

      expect(res.data).toMatchObject({ created: false, reason: 'past', fromFile: true });
      expect(await eventCount()).toBe(0);
      expect(res.summary).toContain('uploaded file');
      expect(res.summary).toContain('do NOT ask');
      // Must NOT fall back to ADR 0100's "read it back and ask" phrasing.
      expect(res.summary).not.toContain('ask whether they meant it');
    });

    it('still creates a future row from the same file', async () => {
      await createFromFile({ title: 'Winter concert', startsAt: dayOffset(20) }, 'turn-1');
      expect(await eventCount()).toBe(1);
    });

    /**
     * FLIPPED by ADR 0319's addendum, deliberately. This path tells the model
     * NOT to ask, so a `confirmPast` on it has no answer behind it — and a
     * term schedule refused thirty times in one turn would otherwise hand the
     * model thirty licences to file history on the next one, which is the
     * harm ADR 0155 exists to prevent. The user can still record a past date
     * from a document: they say so in a plain message, Chord asks, and that
     * question is what licenses the confirm.
     */
    it('does NOT honour confirmPast from a file — nobody was asked', async () => {
      const startsAt = dayOffset(-40);
      await createFromFile({ title: 'Sept assembly', startsAt }, 'turn-1');
      const res = await createFromFile({ title: 'Sept assembly', startsAt, confirmPast: true }, 'turn-2');

      expect(res.data).toMatchObject({ created: false, reason: 'past', fromFile: true });
      expect(await eventCount()).toBe(0);
    });

    it('update_event: a past move from a file changes nothing and does not ask', async () => {
      await create({ title: 'Recital', startsAt: dayOffset(5) }, null);
      const { id } = await db
        .selectFrom('events')
        .select('id')
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      const before = await db
        .selectFrom('events')
        .select('starts_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      const res = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        turnId: 'turn-1',
        tzOffset: '+00:00',
        triggerFromAttachment: true,
        call: { name: 'update_event', args: { eventId: id, startsAt: dayOffset(-3) } },
      });

      expect(res.data).toMatchObject({ updated: false, reason: 'past', fromFile: true });
      const after = await db
        .selectFrom('events')
        .select('starts_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(after.starts_at).toBe(before.starts_at);
      expect(res.summary).not.toContain('ask whether they meant it');
    });
  });

  /**
   * A reschedule backwards is the same typo — "move it to Friday" said on a
   * Saturday means next Friday. What must NOT trip is an edit that moves
   * nothing: renaming an event that already happened is legitimate.
   */
  describe('update_event', () => {
    // Seeded with turnId null so the create itself is never the thing under
    // test — these cases are about the move.
    async function seedEvent(startsAt: string): Promise<string> {
      await create({ title: 'Dentist', startsAt }, null);
      const row = await db
        .selectFrom('events')
        .select('id')
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      return row.id;
    }

    function update(args: Record<string, unknown>, turnId: string | null) {
      return applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        turnId,
        tzOffset: '+00:00',
        call: { name: 'update_event', args },
      });
    }

    const startOf = async (id: string) =>
      (await db.selectFrom('events').select('starts_at').where('id', '=', id).executeTakeFirst())
        ?.starts_at;

    const day = (iso: string | undefined) => iso?.slice(0, 10);

    it('refuses a move onto a past date and changes nothing', async () => {
      const id = await seedEvent(dayOffset(3));
      const before = await startOf(id);
      const res = await update({ eventId: id, startsAt: dayOffset(-2) }, 'turn-1');

      expect(res.data).toMatchObject({ updated: false, reason: 'past' });
      expect(await startOf(id)).toBe(before);
    });

    it('moves it once the user confirms with confirmPast', async () => {
      const id = await seedEvent(dayOffset(3));
      const past = dayOffset(-2);
      await update({ eventId: id, startsAt: past }, 'turn-1');
      const res = await update({ eventId: id, startsAt: past, confirmPast: true }, 'turn-2');

      expect(res.data).toMatchObject({ updated: true });
      expect(day(await startOf(id))).toBe(day(past));
    });

    it('allows a move to a future date', async () => {
      const id = await seedEvent(dayOffset(3));
      await update({ eventId: id, startsAt: dayOffset(9) }, 'turn-1');
      expect(day(await startOf(id))).toBe(day(dayOffset(9)));
    });

    // The guard is about the date being moved TO. An event that already
    // happened can still be renamed or relocated — nothing moves.
    it('allows editing an already-past event when startsAt is untouched', async () => {
      const id = await seedEvent(dayOffset(-10));
      const before = await startOf(id);
      const res = await update({ eventId: id, title: 'Dentist (was)' }, 'turn-1');

      expect(res.data).toMatchObject({ updated: true });
      expect(await startOf(id)).toBe(before);
    });

    it('leaves non-conversational callers (no turnId) alone', async () => {
      const id = await seedEvent(dayOffset(3));
      await update({ eventId: id, startsAt: dayOffset(-2) }, null);
      expect(day(await startOf(id))).toBe(day(dayOffset(-2)));
    });
  });
});
