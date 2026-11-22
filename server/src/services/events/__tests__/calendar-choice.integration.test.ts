/**
 * Prod 2026-11-17. A user with three calendars (the Google login's, a work
 * Outlook set as the default, and an attached RudderStack Gmail) wrote:
 *   1. "From Rudderstack calendar - send a calendar invite for 2p EST to
 *      arthur@optizent.com. add google meet"   (at 4:33 PM, so 2pm was over)
 *   2. "On Rudderstack Calendar- add to calendar invite for 2p EST add google meet"
 *   3. "For tomorrow"
 * and got three meetings and three invitations: Outlook (2pm today, past),
 * RudderStack (2pm today) and Outlook (2pm tomorrow). The model never passed
 * `calendar`, and the name finder missed "From ... calendar".
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'google-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { chooseEventCalendar } from '@/services/events/calendar-choice.js';
import { gmailCalendarKey } from '@/services/gmail-calendar/ids.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { calendarNamesSaidIn } from '@/utils/calendar-mention.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ARTHUR = 'arthur@optizent.com';
const MSG_1 = 'From Rudderstack calendar - send a calendar invite for 2p EST to arthur@optizent.com. add google meet';

type Env = { GMAIL_PROVIDER: string; OUTLOOK_CALENDAR_ENABLED: boolean };
const saved: Env = { GMAIL_PROVIDER: env.GMAIL_PROVIDER, OUTLOOK_CALENDAR_ENABLED: env.OUTLOOK_CALENDAR_ENABLED };

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let outlookCal: string;
let rudderCal: string;
let rudderAccount: string;

async function account(provider: 'outlook' | 'gmail', email: string, calKey: (id: string) => string) {
  const id = newId('ema');
  const now = new Date().toISOString();
  const cal = calKey(id);
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider,
      email_address: email,
      display_name: 'John',
      preset_key: null,
      auth_ciphertext: null,
      auth_iv: null,
      auth_tag: null,
      sync_cursor: null,
      synced_at: null,
      status: 'ok',
      calendar_enabled: 1,
      calendar_default_id: cal,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await upsertCalendarSource(db, userId, {
    provider: provider === 'outlook' ? 'outlook' : 'google',
    googleCalendarId: cal,
    summary: provider === 'outlook' ? 'Calendar' : email,
    accessRole: 'owner',
    isPrimary: false,
    selectedInGoogle: true,
    isChordTarget: false,
  });
  return { id, cal };
}

/** One email in that mailbox between the user and someone. */
async function mailWith(accountId: string | null, other: string) {
  const now = new Date().toISOString();
  const thread = newId('emt');
  const gid = newId('g');
  await db
    .insertInto('email_threads')
    .values({ id: thread, user_id: userId, account_id: accountId, gmail_thread_id: gid, subject: 'Re: Partnerships', snippet: 'x', from_email: other, from_name: 'Arthur', last_message_at: now, created_at: now, updated_at: now, is_unread: 0 })
    .execute();
  await db
    .insertInto('email_messages')
    .values({ id: newId('emm'), user_id: userId, thread_id: thread, gmail_message_id: newId('gm'), gmail_thread_id: gid, subject: 'Re: Partnerships', snippet: 'x', from_email: other, from_name: 'Arthur', to_emails: JSON.stringify(['jdoe@rudderstack.com']), cc_emails: JSON.stringify([]), is_unread: 0, internal_date: now, created_at: now })
    .execute();
}

async function say(body: string): Promise<string> {
  const id = newId('msg');
  await db
    .insertInto('messages')
    .values({ id, group_id: groupId, sender_id: userId, kind: 'text', body, created_at: new Date().toISOString(), mentions_bot: 0, chord_visible: 1, mentions_others: 0, auto_mirror: 0, is_proactive: 0 })
    .execute();
  return id;
}

const tomorrowAt = (hhmm: string) => {
  const d = new Date(Date.parse(`${svWall(new Date(), TZ).slice(0, 10)}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${d}T${hhmm}:00${offsetForLocalDatetime(TZ, `${d}T${hhmm}:00`)}`;
};

async function create(args: Record<string, unknown>, said: string) {
  const messageId = await say(said);
  return applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: `chat:${messageId}`,
    triggeringMessageId: messageId,
    turnId: newId('turn'),
    tz: TZ,
    call: { name: 'create_event', args } as never,
  });
}

beforeEach(async () => {
  Object.assign(env as unknown as Env, { GMAIL_PROVIDER: 'real', OUTLOOK_CALENDAR_ENABLED: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [], value: [] }), text: async () => '{}' }) as unknown as Response));
  db = await openTestDb();
  userId = await createUser(db, 'john');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  const outlook = await account('outlook', 'john@neuralads.ai', (id) => outlookCalendarKey(id, 'cal1'));
  const rudder = await account('gmail', 'jdoe@rudderstack.com', (id) => gmailCalendarKey(id, 'jdoe@rudderstack.com'));
  outlookCal = outlook.cal;
  rudderCal = rudder.cal;
  rudderAccount = rudder.id;
  await db
    .updateTable('users')
    .set({
      refresh_token_scopes: 'https://www.googleapis.com/auth/calendar',
      default_calendar_id: outlookCal,
      last_tz: TZ,
      google_calendar_synced_at: new Date().toISOString(),
    })
    .where('id', '=', userId)
    .execute();
});

afterEach(async () => {
  await settleBackgroundWork();
  Object.assign(env as unknown as Env, saved);
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

describe('which calendar a chat event goes on', () => {
  it('"From Rudderstack calendar" names the calendar', async () => {
    expect(calendarNamesSaidIn(MSG_1)).toContain('Rudderstack');
    const c = await chooseEventCalendar(db, { userId, said: [MSG_1], invitees: [ARTHUR] });
    expect(c).toMatchObject({ calendarId: rudderCal, why: 'named' });
  });

  it('with no calendar named, the mailbox the user writes to the guest from', async () => {
    await mailWith(rudderAccount, ARTHUR);
    const c = await chooseEventCalendar(db, { userId, said: ['send a calendar invite for 2p EST to arthur@optizent.com'], invitees: [ARTHUR] });
    expect(c).toMatchObject({ calendarId: rudderCal, why: 'people' });
  });

  it('"invite Arthur" by name: his address from People, then his mailbox', async () => {
    await mailWith(rudderAccount, ARTHUR);
    const now = new Date().toISOString();
    await db
      .insertInto('people')
      .values({ id: newId('per'), owner_user_id: userId, display_name: 'Arthur Baker', notes: null, email: ARTHUR, created_at: now, updated_at: now })
      .execute();
    const r = await create(
      { title: 'Call with Arthur', startsAt: tomorrowAt('14:00'), invitees: ['Arthur Baker'] },
      'send a calendar invite to Arthur Baker for 2pm tomorrow',
    );
    expect((r.data as { created?: boolean } | undefined)?.created).not.toBe(false);
    const ev = await db.selectFrom('events').select('google_calendar_id').executeTakeFirstOrThrow();
    expect(ev.google_calendar_id).toBe(rudderCal);
  });

  it('no mail with them: the calendar earlier meetings with them are on', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: groupId,
        created_by: userId,
        owner_user_id: userId,
        title: 'Earlier call',
        starts_at: tomorrowAt('09:00'),
        google_calendar_id: rudderCal,
        guest_emails: JSON.stringify([ARTHUR]),
        created_at: now,
      } as never)
      .execute();
    const c = await chooseEventCalendar(db, { userId, said: ['invite arthur@optizent.com at 2'], invitees: [ARTHUR] });
    expect(c).toMatchObject({ calendarId: rudderCal, why: 'people' });
  });

  it('a Google Meet with no other evidence leaves out the Outlook calendar', async () => {
    const c = await chooseEventCalendar(db, { userId, said: ['invite x@y.com'], invitees: ['x@y.com'], callKind: 'google_meet' });
    // Two Google calendars can host it: asked between those two only.
    expect(c.ask?.map((a) => a.calendarId).sort()).toEqual(['primary', rudderCal].sort());
  });

  it('guests, several mailbox calendars, nothing to go on: ask', async () => {
    const r = await create(
      { title: 'Meeting with Rudderstack', startsAt: tomorrowAt('14:00'), invitees: ['stranger@elsewhere.com'] },
      'send a calendar invite for 2pm tomorrow to stranger@elsewhere.com',
    );
    expect(r.data).toMatchObject({ created: false, reason: 'which_calendar' });
    expect(await db.selectFrom('events').select('id').execute()).toHaveLength(0);
  });

  it('no guests: the default, nobody asked', async () => {
    const c = await chooseEventCalendar(db, { userId, said: ['dentist tomorrow at 2'], invitees: [] });
    expect(c).toMatchObject({ calendarId: outlookCal, why: 'default' });
    expect(c.ask).toBeUndefined();
  });
});

describe('a meeting with guests that has already started', () => {
  it('2pm today, asked at 4:33pm, is refused and asked about', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 2 * 3600_000);
    const startsAt = `${svWall(earlier, TZ).slice(0, 16)}:00${offsetForLocalDatetime(TZ, svWall(earlier, TZ).slice(0, 19))}`;
    // Only meaningful when two hours ago is still today where the user is.
    if (svWall(earlier, TZ).slice(0, 10) !== svWall(now, TZ).slice(0, 10)) return;
    const r = await create({ title: 'Meeting with Rudderstack', startsAt, invitees: [ARTHUR] }, MSG_1);
    expect(r.data).toMatchObject({ created: false, reason: 'past' });
  });
});

describe('a correction is the same meeting', () => {
  it('"For tomorrow" after making it does not make a second meeting', async () => {
    const first = await create({ title: 'Meeting with Rudderstack', startsAt: tomorrowAt('14:00'), invitees: [ARTHUR], calendar: 'Rudderstack' }, MSG_1);
    expect((first.data as { created?: boolean } | undefined)?.created).not.toBe(false);
    const madeId = (await db.selectFrom('events').select('id').executeTakeFirstOrThrow()).id;
    const again = await create({ title: 'Meeting with Rudderstack', startsAt: tomorrowAt('15:00'), invitees: [ARTHUR] }, 'For tomorrow');
    expect(again.data).toMatchObject({ created: false, reason: 'same_meeting', eventId: madeId });
    expect(await db.selectFrom('events').select('id').execute()).toHaveLength(1);
    // Asked once: a real second meeting goes through when they say so.
    const second = await create({ title: 'Meeting with Rudderstack', startsAt: tomorrowAt('16:00'), invitees: [ARTHUR] }, 'yes, a separate one');
    expect((second.data as { created?: boolean } | undefined)?.created).not.toBe(false);
  });
});
