/**
 * ADR 0229 — a repeat nobody asked for is ignored.
 *
 * Prod, 2026-10-09: "add lunch tomorrow at noon to my Outlook calendar". The
 * model attached a repeat anyway — weekdays on a non-weekly frequency — and
 * the tool reply read "a repeat pattern was attempted but could not be
 * stored: weekdays only applies to a weekly repeat". That was the third
 * sighting. All three specs happened to contradict themselves, which is the
 * only reason validation caught them: the same habit with a VALID spec
 * (`{ frequency: "daily" }`) would have made a daily series of a one-time
 * lunch, and nothing checked for that.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const LUNCH_REQUEST = '@Chord add lunch tomorrow at noon to my Outlook calendar';

/** A date `days` ahead, as YYYY-MM-DD. */
const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** That local time in New York on that date, with the date's own offset. */
const at = (date: string, time: string): string => {
  const probe = new Date(`${date}T12:00:00Z`);
  const ny = probe.toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });
  const off = Number(/GMT([+-]\d+)/.exec(ny)![1]!);
  return `${date}T${time}:00${off < 0 ? '-' : '+'}${String(Math.abs(off)).padStart(2, '0')}:00`;
};

describe('a repeat nobody asked for (ADR 0229)', () => {
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

  const say = async (body: string): Promise<string> =>
    (await insertMessage(db, { groupId, senderId: userId, body })).id;

  const call = (name: string, args: Record<string, unknown>, triggeringMessageId?: string) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: TZ,
      tzOffset: '-04:00',
      call: { name, args } as never,
      ...(triggeringMessageId ? { triggeringMessageId } : {}),
    });

  const events = (title: string) =>
    db.selectFrom('events').selectAll().where('owner_user_id', '=', userId).where('title', '=', title).execute();
  const seriesCount = async () => (await db.selectFrom('event_series').select('id').execute()).length;

  it('the prod case: a self-contradictory repeat on a one-time lunch is ignored quietly', async () => {
    const day = inDays(1);
    const res = await call(
      'create_event',
      { title: 'Lunch', startsAt: at(day, '12:00'), repeat: { frequency: 'daily', weekdays: ['SA'] } },
      await say(LUNCH_REQUEST),
    );

    expect(res.card).toMatchObject({ kind: 'event', title: 'Lunch' });
    expect(await events('Lunch')).toHaveLength(1);
    expect(await seriesCount()).toBe(0);
    expect(res.summary).toContain('one-off, does not repeat');
    // The reply the user saw talked about a repeat they never mentioned.
    expect(res.summary).not.toMatch(/could not be stored|weekdays only applies/);
    expect(res.summary).toMatch(/do not mention repeating/);
  });

  it('a VALID made-up repeat on the same one-time lunch does not create a series', async () => {
    const day = inDays(1);
    const res = await call(
      'create_event',
      { title: 'Lunch', startsAt: at(day, '12:00'), repeat: { frequency: 'daily' } },
      await say(LUNCH_REQUEST),
    );

    const rows = await events('Lunch');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.series_id).toBeNull();
    expect(await seriesCount()).toBe(0);
    expect(res.summary).toContain('one-off, does not repeat');
    expect(res.summary).not.toMatch(/repeats daily/);
  });

  it('a repeat asked for with a plural day name is kept', async () => {
    const day = inDays(2);
    const res = await call(
      'create_event',
      { title: 'Soccer', startsAt: at(day, '16:00'), repeat: { frequency: 'weekly' } },
      await say('@Chord soccer practice on Tuesdays at 4'),
    );
    expect(res.summary).toMatch(/repeats weekly/);
    expect(await seriesCount()).toBe(1);
  });

  it('"yes" to a pattern proposed a moment ago keeps the repeat', async () => {
    // The trigger itself says nothing about repeating; the exchange before it does.
    await say('@Chord piano lessons every other Thursday at 5');
    await say('I can do every 2 weeks on Thursday. Does that work?');
    const day = inDays(3);
    const res = await call(
      'create_event',
      { title: 'Piano', startsAt: at(day, '17:00'), repeat: { frequency: 'weekly', interval: 2 } },
      await say('yes that works'),
    );
    expect(res.summary).toMatch(/repeats every 2 weeks/);
    expect(await seriesCount()).toBe(1);
  });

  it('repeat wording from an older conversation does not count', async () => {
    const old = await say('@Chord make swim a weekly thing');
    await db
      .updateTable('messages')
      .set({ created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() })
      .where('id', '=', old)
      .execute();
    const day = inDays(1);
    await call(
      'create_event',
      { title: 'Lunch', startsAt: at(day, '12:00'), repeat: { frequency: 'weekly' } },
      await say(LUNCH_REQUEST),
    );
    expect(await seriesCount()).toBe(0);
    expect(await events('Lunch')).toHaveLength(1);
  });

  it('with no message to read, a repeat is taken as given', async () => {
    // Ingest, a confirmed proposal, a scripted call: no signal either way.
    const day = inDays(2);
    const res = await call('create_event', {
      title: 'Standup',
      startsAt: at(day, '09:00'),
      repeat: { frequency: 'daily' },
    });
    expect(res.summary).toMatch(/repeats daily/);
    expect(await seriesCount()).toBe(1);
  });

  describe('fields the model filled that nobody asked for', () => {
    // 2026-10-24, gpt-4.1-mini through OpenRouter (served by Azure), four tries
    // out of four: the model fills every optional field, so "every Tuesday"
    // came with a week-of-month, a count of 1 and an end date. Validation
    // refused it ("monthlyWeek only applies to a monthly repeat") and the bot
    // asked about a monthly pattern nobody mentioned.
    const SWIM = 'add Maya swim class every Tuesday at 4pm';
    const nextTuesday = (): string => {
      for (let d = 1; d <= 7; d++) {
        const date = inDays(d);
        if (new Date(`${date}T12:00:00Z`).getUTCDay() === 2) return date;
      }
      throw new Error('unreachable');
    };
    const rule = async () => (await db.selectFrom('event_series').select('rrule').executeTakeFirstOrThrow()).rrule;

    it('the test-run case: "every Tuesday" with monthlyWeek, count 1 and an until before the start', async () => {
      const day = nextTuesday();
      const res = await call(
        'create_event',
        {
          title: 'Maya swim class',
          startsAt: at(day, '16:00'),
          endsAt: at(day, '17:00'),
          location: '',
          calendar: '',
          invitees: [],
          confirmPast: false,
          allDay: false,
          repeat: { count: 1, frequency: 'weekly', interval: 1, monthlyWeek: 1, until: inDays(0), weekdays: ['TU'] },
        },
        await say(SWIM),
      );

      expect(res.summary).not.toMatch(/cannot repeat|monthlyWeek/);
      expect(res.summary).toMatch(/repeats weekly/);
      expect(await rule()).toBe('FREQ=WEEKLY;BYDAY=TU');
      expect((await events('Maya swim class')).length).toBeGreaterThan(4);
    });

    it('a made-up count or end date is dropped (count 52, until a year out)', async () => {
      const day = nextTuesday();
      await call(
        'create_event',
        {
          title: 'Maya swim class',
          startsAt: at(day, '16:00'),
          repeat: { count: 52, frequency: 'weekly', interval: 1, monthlyWeek: 1, until: inDays(370), weekdays: ['TU'] },
        },
        await say(SWIM),
      );
      expect(await rule()).toBe('FREQ=WEEKLY;BYDAY=TU');
    });

    it('an end the user stated is kept', async () => {
      const day = nextTuesday();
      const until = inDays(60);
      await call(
        'create_event',
        {
          title: 'Maya swim class',
          startsAt: at(day, '16:00'),
          repeat: { count: 1, frequency: 'weekly', monthlyWeek: 1, until, weekdays: ['TU'] },
        },
        await say(`${SWIM} until ${until}`),
      );
      expect(await rule()).toBe(`FREQ=WEEKLY;BYDAY=TU;UNTIL=${until.replace(/-/g, '')}`);
    });

    it('"make lunch weekly" with the same filled-in fields converts the one-off', async () => {
      const day = inDays(2);
      await call('create_event', { title: 'Lunch', startsAt: at(day, '12:00'), endsAt: at(day, '13:00') });
      const res = await call(
        'update_event',
        { titleContains: 'Lunch', repeat: { count: 1, frequency: 'weekly', interval: 1, monthlyWeek: 1, until: inDays(0) } },
        await say('@Chord make lunch weekly'),
      );
      expect(res.summary).toMatch(/now repeats weekly/);
      expect(await rule()).toMatch(/^FREQ=WEEKLY;BYDAY=[A-Z]{2}$/);
    });
  });

  describe('editing', () => {
    const day = inDays(2);
    beforeEach(async () => {
      await call('create_event', { title: 'Lunch', startsAt: at(day, '12:00'), endsAt: at(day, '13:00') });
    });

    it('"move lunch to 1pm" with a made-up repeat moves it and leaves it a one-off', async () => {
      const res = await call(
        'update_event',
        { titleContains: 'Lunch', startsAt: at(day, '13:00'), endsAt: at(day, '14:00'), repeat: { frequency: 'daily' } },
        await say('@Chord move lunch to 1pm'),
      );
      expect(res.data).toMatchObject({ updated: true });
      const rows = await events('Lunch');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.starts_at).toBe(at(day, '13:00'));
      expect(rows[0]!.series_id).toBeNull();
      expect(await seriesCount()).toBe(0);
      expect(res.summary).not.toMatch(/repeats/);
    });

    it('a repeat-only edit nobody asked for changes nothing and says not to mention it', async () => {
      const res = await call(
        'update_event',
        { titleContains: 'Lunch', repeat: { frequency: 'weekly' } },
        await say('@Chord is lunch still on?'),
      );
      expect(res.data).toMatchObject({ updated: false });
      expect(res.summary).toMatch(/do not mention repeating/);
      expect(await seriesCount()).toBe(0);
    });

    it('"make lunch weekly" still turns it into a series', async () => {
      const res = await call(
        'update_event',
        { titleContains: 'Lunch', repeat: { frequency: 'weekly' } },
        await say('@Chord make lunch weekly'),
      );
      expect(res.summary).toMatch(/now repeats weekly/);
      expect(await seriesCount()).toBe(1);
    });

    it('a made-up repeat cannot rewrite how an existing series repeats', async () => {
      await call(
        'update_event',
        { titleContains: 'Lunch', repeat: { frequency: 'weekly' } },
        await say('@Chord make lunch weekly'),
      );
      const before = await db.selectFrom('event_series').select('rrule').executeTakeFirstOrThrow();
      const later = await say('@Chord rename lunch to Team lunch');
      await db
        .updateTable('messages')
        .set({ created_at: new Date(Date.now() + 3_600_000).toISOString() })
        .where('id', '=', later)
        .execute();
      await call(
        'update_event',
        { titleContains: 'Lunch', title: 'Team lunch', repeat: { frequency: 'daily' }, scope: 'all' },
        later,
      );
      const after = await db.selectFrom('event_series').select(['rrule', 'title']).executeTakeFirstOrThrow();
      expect(after.rrule).toBe(before.rrule);
      expect(after.title).toBe('Team lunch');
    });
  });
});
