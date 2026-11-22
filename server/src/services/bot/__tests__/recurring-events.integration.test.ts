/**
 * ADR 0217 — repeating events from chat.
 *
 * Prod, 2026-09-28:
 *   "Add to calendar- recurring- nolan sci oly at 330-530pm weekly"
 *     → one event on Wed Sep 30, and "Added a weekly recurring event".
 *   "This should recur weekly"
 *     → a SECOND one-off event ("Nolan - Science Olympiad"), and
 *       "set to recur weekly".
 * Nothing could store a repeat, and nothing told the model so.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { topUpSeries } from '@/services/events/series.service.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';

/** The Wednesday at least `minDays` ahead, as YYYY-MM-DD. */
function nextWednesday(minDays = 3): string {
  const d = new Date(Date.now() + minDays * 86_400_000);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 3:30pm New York on that date, with that date's own offset. */
const at = (date: string, time: string) => {
  const probe = new Date(`${date}T12:00:00Z`);
  const ny = probe.toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });
  const off = /GMT([+-]\d+)/.exec(ny)![1]!;
  const h = Math.abs(Number(off));
  return `${date}T${time}:00${Number(off) < 0 ? '-' : '+'}${String(h).padStart(2, '0')}:00`;
};

describe('repeating events from chat (ADR 0217)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const call = (
    name: string,
    args: Record<string, unknown>,
    group = groupId,
    triggeringMessageId?: string,
  ) =>
    applyToolCall(db, {
      groupId: group,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: TZ,
      tzOffset: '-04:00',
      call: { name, args } as never,
      ...(triggeringMessageId ? { triggeringMessageId } : {}),
    });

  const rows = (title?: string) =>
    db
      .selectFrom('events')
      .selectAll()
      .where('owner_user_id', '=', userId)
      .$if(!!title, (q) => q.where('title', '=', title!))
      .execute();

  it('"weekly" becomes a real series, and the reply says so', async () => {
    const wed = nextWednesday();
    const res = await call('create_event', {
      title: 'Nolan Sci Oly',
      startsAt: at(wed, '15:30'),
      endsAt: at(wed, '17:30'),
      repeat: { frequency: 'weekly' },
    });

    expect(res.summary).toContain('repeats weekly on Wed');
    const occurrences = await rows('Nolan Sci Oly');
    expect(occurrences.length).toBeGreaterThan(50);
    expect(new Set(occurrences.map((r) => r.series_id)).size).toBe(1);
    // Each occurrence is its own event to an edit or a delete.
    expect(new Set(occurrences.map((r) => r.ical_uid)).size).toBe(occurrences.length);
    // Every one on a Wednesday at 3:30 local, DST or not.
    for (const r of occurrences) {
      const wall = new Date(r.starts_at).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
      expect(wall).toBe('Wed 3:30 PM');
    }
  });

  it('a plain event says it does not repeat', async () => {
    const wed = nextWednesday();
    const res = await call('create_event', { title: 'Dentist', startsAt: at(wed, '10:00') });
    expect(res.summary).toContain('one-off, does not repeat');
  });

  it('"this should recur weekly" turns the existing event into the series, no second event', async () => {
    const wed = nextWednesday();
    const first = await call('create_event', {
      title: 'Nolan Sci Oly',
      startsAt: at(wed, '15:30'),
      endsAt: at(wed, '17:30'),
    });
    const originalId = (await rows('Nolan Sci Oly'))[0]!.id;
    expect(first.summary).toContain('does not repeat');

    const res = await call('update_event', {
      titleContains: 'Sci Oly',
      repeat: { frequency: 'weekly' },
    });

    expect(res.data).toMatchObject({ updated: true, repeats: 'weekly on Wed' });
    const all = await rows();
    expect(all.every((r) => r.title === 'Nolan Sci Oly')).toBe(true);
    expect(all.length).toBeGreaterThan(50);
    // The event the user already had is the first occurrence, not a twin.
    const firstOcc = [...all].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0]!;
    expect(firstOcc.id).toBe(originalId);
  });

  it('asking again with create_event and a repeat converts rather than adds a twin', async () => {
    const wed = nextWednesday();
    await call('create_event', { title: 'Nolan Sci Oly', startsAt: at(wed, '15:30') });
    const res = await call('create_event', {
      title: 'Nolan Sci Oly',
      startsAt: at(wed, '15:30'),
      repeat: { frequency: 'weekly' },
    });
    expect(res.data).toMatchObject({ converted: true });
    const onFirstDay = (await rows()).filter((r) => r.starts_at.startsWith(wed));
    expect(onFirstDay).toHaveLength(1);
  });

  it('a pattern it cannot store is refused, not stored as a one-off', async () => {
    const wed = nextWednesday();
    const res = await call('create_event', {
      title: 'Oops',
      startsAt: at(wed, '15:30'),
      repeat: { frequency: 'daily', weekdays: ['MO'] },
    });
    expect(res.data).toMatchObject({
      created: false,
      reason: 'bad_repeat',
      message: 'weekdays only applies to a weekly repeat',
    });
    expect(await rows('Oops')).toHaveLength(0);
    // Prod, 2026-10: the bot relayed its own internal instruction verbatim
    // ("Tell the user which part could not be stored and offer the nearest
    // pattern") as its reply, because that sentence lived inside `summary`
    // instead of the separate `instruction` field every other refusal uses.
    // Pin both halves of the fix: the model-facing directive moved out of
    // `summary` (nothing a weaker model could mistake for user-facing prose)
    // and into `data.instruction` (where `bot.service.ts` already knows to
    // surface it to the model, separately from the factual `summary`/`message`).
    expect(res.summary).not.toMatch(/tell the user/i);
    expect((res.data as { instruction?: string }).instruction).toMatch(/nearest pattern/i);
  });

  it('a hallucinated repeat on a plain one-time request is dropped, not refused (prod, 2026-10)', async () => {
    // Prod: "Add to personal calendar - Call with AHF at noon tomorrow." -
    // no recurrence word anywhere - and the model still attached a self-
    // contradictory repeat (monthlyWeek on a daily frequency). Refusing the
    // whole event blocked a plain one-time request the user never asked to
    // complicate.
    const trigger = await insertMessage(db, {
      groupId,
      senderId: userId,
      body: '@Chord add call with AHF tomorrow at noon',
    });
    const wed = nextWednesday();
    const res = await call(
      'create_event',
      {
        title: 'Call with AHF',
        startsAt: at(wed, '12:00'),
        repeat: { frequency: 'daily', monthlyWeek: 2 },
      },
      groupId,
      trigger.id,
    );
    // Success here is a real `card` and no refusal shape in `data` (the
    // executor only ever puts `created: false` in `data` - see the refused
    // tests above - never an explicit `created: true` on the happy path).
    expect(res.card).toMatchObject({ kind: 'event', title: 'Call with AHF' });
    expect(res.summary).toContain('one-off, does not repeat');
    // ADR 0229 — an unasked repeat is ignored before it is validated, so the
    // reply has no failure to relay and is told not to bring repeating up.
    expect(res.summary).not.toMatch(/monthlyWeek/);
    expect(res.summary).toMatch(/do not mention repeating/);
    const created = await rows('Call with AHF');
    expect(created).toHaveLength(1);
  });

  it('a made-up modifier on a repeat the message asks for is dropped and the repeat kept', async () => {
    // The same invalid spec, but this time the user's own words say it
    // should recur. This used to refuse and ask, so as not to silently drop
    // a real request (ADR 0217). Since ADR 0229's 2026-10-25 addendum only
    // the modifier nobody asked for goes; the daily repeat they asked for
    // is kept, so the request is honoured instead of refused. Refusing is
    // what made "every Tuesday" fail 4/4 in the 2026-10-24 model run.
    const trigger = await insertMessage(db, {
      groupId,
      senderId: userId,
      body: '@Chord add a daily call with AHF at noon, every day',
    });
    const wed = nextWednesday();
    const res = await call(
      'create_event',
      {
        title: 'Call with AHF',
        startsAt: at(wed, '12:00'),
        repeat: { frequency: 'daily', monthlyWeek: 2 },
      },
      groupId,
      trigger.id,
    );
    expect(res.data).not.toMatchObject({ created: false });
    expect(res.summary).toMatch(/repeats daily/);
    expect((await rows('Call with AHF')).length).toBeGreaterThan(1);
  });

  it('with no trigger message to check (e.g. ingest), keeps refusing rather than guessing', async () => {
    const wed = nextWednesday();
    const res = await call('create_event', {
      title: 'No Trigger',
      startsAt: at(wed, '12:00'),
      repeat: { frequency: 'daily', monthlyWeek: 2 },
    });
    expect(res.data).toMatchObject({ created: false, reason: 'bad_repeat' });
    expect(await rows('No Trigger')).toHaveLength(0);
  });

  describe('editing and deleting a series', () => {
    const makeSeries = async () => {
      const wed = nextWednesday();
      await call('create_event', {
        title: 'Nolan Sci Oly',
        startsAt: at(wed, '15:30'),
        endsAt: at(wed, '17:30'),
        repeat: { frequency: 'weekly' },
      });
      return wed;
    };

    it('a title match finds the series, and an edit without a scope asks first', async () => {
      await makeSeries();
      const res = await call('update_event', { titleContains: 'Sci Oly', title: 'Science Olympiad' });
      expect(res.data).toMatchObject({ updated: false, reason: 'scope_required' });
      expect(res.data).not.toHaveProperty('candidates');
      expect(await rows('Science Olympiad')).toHaveLength(0);
    });

    it('"just this one" moves one occurrence and leaves the rest', async () => {
      const wed = await makeSeries();
      const next = new Date(Date.parse(`${wed}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const res = await call('update_event', {
        titleContains: 'Sci Oly',
        date: next,
        startsAt: at(next, '16:00'),
        endsAt: at(next, '18:00'),
        scope: 'this',
      });
      expect(res.data).toMatchObject({ updated: true });
      const all = await rows('Nolan Sci Oly');
      const moved = all.filter((r) => r.starts_at === at(next, '16:00'));
      expect(moved).toHaveLength(1);
      expect(all.filter((r) => r.starts_at === at(wed, '15:30'))).toHaveLength(1);
    });

    it('"all of them" renames every occurrence and moves the upcoming ones', async () => {
      const wed = await makeSeries();
      const res = await call('update_event', {
        titleContains: 'Sci Oly',
        title: 'Science Olympiad',
        startsAt: at(wed, '16:00'),
        scope: 'all',
      });
      expect(res.data).toMatchObject({ updated: true, scope: 'all' });
      const all = await rows();
      expect(all.every((r) => r.title === 'Science Olympiad')).toBe(true);
      for (const r of all) {
        const t = new Date(r.starts_at).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
        expect(t).toBe('4:00 PM');
      }
      expect(all.length).toBeGreaterThan(50);
    });

    it("changing an all-day series' rule rewrites today's occurrence too", async () => {
      // Today's all-day occurrence is floating midnight. Read as UTC midnight
      // it sat before the New York cutoff, so it was never rewritten: after
      // "make it weekly on <tomorrow's weekday>" today's day stayed on.
      const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      await call('create_event', {
        title: 'Camp',
        startsAt: `${today}T00:00:00`,
        endsAt: `${tomorrow}T00:00:00`,
        allDay: true,
        repeat: { frequency: 'daily' },
      });
      const series = await db.selectFrom('event_series').select(['all_day']).executeTakeFirstOrThrow();
      expect(series.all_day).toBe(1);

      const day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${tomorrow}T12:00:00Z`).getUTCDay()]!;
      const res = await call('update_event', {
        titleContains: 'Camp',
        repeat: { frequency: 'weekly', weekdays: [day] },
        scope: 'all',
      });
      expect(res.data).toMatchObject({ updated: true });
      const camp = await rows('Camp');
      expect(camp.filter((r) => r.starts_at.startsWith(today))).toHaveLength(0);
      expect(camp.filter((r) => r.starts_at.startsWith(tomorrow))).toHaveLength(1);
    });

    it('deleting one occurrence keeps it gone after a top-up', async () => {
      const wed = await makeSeries();
      const before = (await rows()).length;
      const res = await call('delete_event', { titleContains: 'Sci Oly', date: wed, scope: 'this' });
      expect(res.data).toMatchObject({ deleted: true, scope: 'this' });
      await db.updateTable('event_series').set({ materialized_until: null }).execute();
      await topUpSeries(db);
      const after = await rows();
      expect(after).toHaveLength(before - 1);
      expect(after.some((r) => r.starts_at === at(wed, '15:30'))).toBe(false);
    });

    it('deleting all removes the series', async () => {
      await makeSeries();
      const ask = await call('delete_event', { titleContains: 'Sci Oly' });
      expect(ask.data).toMatchObject({ deleted: false, reason: 'scope_required' });
      const res = await call('delete_event', { titleContains: 'Sci Oly', scope: 'all' });
      expect(res.data).toMatchObject({ deleted: true, scope: 'all' });
      expect(await rows()).toHaveLength(0);
      expect(await db.selectFrom('event_series').select('id').execute()).toHaveLength(0);
    });
  });

  it('a family series: every member gets it, and "just this one" moves only that day for both', async () => {
    const spouse = await createUser(db, 'alice');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    await addMember(db, family.id, spouse);
    const wed = nextWednesday();
    await call(
      'create_event',
      { title: 'Swim', startsAt: at(wed, '15:30'), endsAt: at(wed, '16:30'), repeat: { frequency: 'weekly' } },
      family.id,
    );
    const series = await db.selectFrom('event_series').selectAll().execute();
    expect(series).toHaveLength(2);
    expect(new Set(series.map((s) => s.series_uid)).size).toBe(1);

    await call(
      'update_event',
      { titleContains: 'Swim', date: wed, startsAt: at(wed, '17:00'), scope: 'this' },
      family.id,
    );
    const all = await db.selectFrom('events').selectAll().where('title', '=', 'Swim').execute();
    const moved = all.filter((r) => r.starts_at === at(wed, '17:00'));
    expect(moved.map((r) => r.owner_user_id).sort()).toEqual([userId, spouse].sort());
    // Only that day moved, for either of them.
    expect(all.filter((r) => r.starts_at.endsWith('17:00:00' + at(wed, '17:00').slice(19)))).toHaveLength(2);
  });
});
