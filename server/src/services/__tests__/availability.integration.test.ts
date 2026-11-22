/**
 * "Plan for a given day needs to start at time question is asked." Prod,
 * Sunday 25 October 2026 at 7:40 PM New York: /plan listed the 9 AM cleaning
 * and the noon meeting as still ahead and called everything else free. Today's
 * availability line now covers only what is left of the day, and a time
 * earlier today is never called free.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { renderAvailability, userAvailability } from '@/services/availability.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { getSkill } from '@/services/bot/skills/index.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
// Sun 25 Oct 2026, 7:40 PM EDT.
const NOW = Date.parse('2026-10-25T19:40:00-04:00');
const block = (from: string, to: string) => ({
  startMs: Date.parse(`2026-10-25T${from}:00-04:00`),
  endMs: Date.parse(`2026-10-25T${to}:00-04:00`),
});

describe('today is the rest of today', () => {
  it('leaves out the morning and says where today starts', () => {
    const text = renderAvailability([block('09:00', '10:00'), block('12:00', '13:00'), block('20:30', '21:30')], {
      tz: TZ,
      nowMs: NOW,
      days: 2,
    });
    const [today, tomorrow] = text.split('\n');
    expect(today).toBe('Sun, Oct 25 (rest of today, from 7:40 PM): busy 8:30 PM–9:30 PM');
    expect(today).not.toContain('9:00 AM');
    expect(today).not.toContain('12:00 PM');
    expect(tomorrow).toBe('Mon, Oct 26: nothing scheduled');
  });

  it('an event running through now starts "now"', () => {
    const text = renderAvailability([block('19:00', '20:00')], { tz: TZ, nowMs: NOW, days: 1 });
    expect(text).toBe('Sun, Oct 25 (rest of today, from 7:40 PM): busy now–8:00 PM');
  });

  it('the plan-my-day skill plans from the current time', () => {
    const skill = getSkill('plan_my_day')!;
    expect(skill.instructions).toContain('starts at the user\'s current local time');
    expect(skill.finish).toContain('starting at the current time');
  });
});

describe('a time asked about earlier today', () => {
  let db: Kysely<DB>;
  let userId: string;
  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('is past, not free', async () => {
    const avail = await userAvailability(db, userId, {
      nowMs: NOW,
      askedSlots: [
        { day: '2026-10-25', minutes: 15 * 60 },
        { day: '2026-10-25', minutes: 20 * 60 + 30 },
      ],
    });
    expect(avail.askedSlotsText).toContain('Sun, Oct 25 at 3:00 PM: ALREADY PAST (it is now 7:40 PM)');
    expect(avail.askedSlotsText).toContain('Sun, Oct 25 at 8:30 PM: FREE');
  });
});
