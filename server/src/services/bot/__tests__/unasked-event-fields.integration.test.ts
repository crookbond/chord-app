/**
 * ADR 0319 addendum — `allDay` has to agree with the time it arrived with.
 *
 * `createEvent` reads `input.allDay ?? <floating-midnight sniff>`, so the
 * field OVERRIDES that sniff: `true` on a timed start files a 3pm meeting as
 * an all-day, non-blocking row, invisible to free/busy and pushed to Google as
 * all-day. It is a plain optional boolean on the tool schema, and ADR 0229's
 * addendum records that models fill those in with invented values.
 *
 * It cannot simply be ignored on a conversational turn, which was this fix's
 * first shape and was wrong: `applyToolCall` runs `normalizeDatetimes` over
 * every call, which stamps the user's offset onto the floating midnight the
 * prompt asks an all-day event to be written as — so by the time the sniff
 * runs the value no longer looks all-day, and the field is the model's ONLY
 * way to say "all day". Pinned below, because it is the reason for the shape.
 *
 * So the rule is agreement: honoured at midnight, dropped when it contradicts
 * the start.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('create_event allDay (ADR 0319 addendum)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  /** A plainly TIMED start — 3pm, with a real offset. */
  const timed = (days = 3): string => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T15:00:00+00:00`;
  };
  /** The floating midnight the prompt asks an all-day event to arrive as. */
  const floatingMidnight = (days = 3): string => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T00:00:00`;
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
        invite_code: 'XALLD',
        ingest_email: 'fam-allday@chord.app',
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

  const row = async (title: string) =>
    db
      .selectFrom('events')
      .select(['all_day', 'transparency', 'starts_at'])
      .where('group_id', '=', groupId)
      .where('title', '=', title)
      .executeTakeFirstOrThrow();

  it('the reported case: a filled-in allDay does not turn a 3pm meeting into an all-day free block', async () => {
    await create({ title: 'Meeting with Sarah', startsAt: timed(), allDay: true }, 'turn-1');

    const r = await row('Meeting with Sarah');
    expect(r.all_day).toBe(0);
    // An all-day row is free (ADR 0040); a 3pm meeting has to keep blocking.
    expect(r.transparency).not.toBe('transparent');
  });

  it('a genuine all-day request still works — the field is the only way to say it', async () => {
    // The shape a real turn produces: the prompt asks for floating midnight,
    // `normalizeDatetimes` stamps the offset on, and the field carries the
    // intent the sniff can no longer see.
    await create({ title: 'Sports day', startsAt: floatingMidnight(), allDay: true }, 'turn-1');

    const r = await row('Sports day');
    expect(r.all_day).toBe(1);
    expect(r.transparency).toBe('transparent');
    // Pins WHY the field is needed: the stored start is no longer floating.
    expect(r.starts_at).toMatch(/T00:00:00\+00:00$/);
  });

  /**
   * A before-and-after matrix over every (start shape x flag x caller)
   * combination found this: the guard's first shape excluded `Z`, which
   * silently stopped a UTC-zone user's all-day event from being all-day. The
   * question the guard asks is whether the model contradicted itself — about
   * the time it wrote, not about which zone that instant lands in.
   */
  it("a midnight written as Z is still midnight on its own clock", async () => {
    const d = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await create({ title: 'Inset day', startsAt: `${d}T00:00:00Z`, allDay: true }, 'turn-1');

    const r = await row('Inset day');
    expect(r.all_day).toBe(1);
    expect(r.transparency).toBe('transparent');
  });

  it('a timed start with no allDay at all is a timed event', async () => {
    await create({ title: 'Haircut', startsAt: timed(4) }, 'turn-1');
    expect((await row('Haircut')).all_day).toBe(0);
  });

  it('a contradicting allDay: false falls back to the start, changing nothing', async () => {
    // Already timed, so the sniff and the field agree — the point is that a
    // dropped `false` cannot flip a timed event either.
    await create({ title: 'Dentist', startsAt: timed(5), allDay: false }, 'turn-1');
    expect((await row('Dentist')).all_day).toBe(0);
  });

  it('an .ics import is taken as given — it carries no turnId (ADR 0093)', async () => {
    // `ingest/ics/pipeline.ts` sends allDay beside an externalUid, with no
    // turnId because nobody is in a conversation. Its value is trusted even
    // against a timed-looking start, which is the case the field was added for.
    await create(
      { title: 'Half term', startsAt: timed(6), allDay: true, externalUid: 'uid-allday-1' },
      null,
    );
    expect((await row('Half term')).all_day).toBe(1);
  });
});
