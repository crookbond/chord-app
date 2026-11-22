/**
 * ADR 0348 - an email card adds the meeting, and invites no one.
 *
 * Prod, RudderStack mailbox, "Re: APAC plans for Rudderstack":
 *   - Molly (the CEO's assistant) offered "Tuesday ... between 7:00 and 8:00 AM ET".
 *   - Her invitation "Jake Evans // RudderStack: APAC 2027" (Tue 7:00 AM,
 *     guests Sean, Jake and the user) synced onto the RudderStack calendar.
 *   - Jake: "I have accepted the Tuesday invite."
 * Chord staged "APAC plans meeting with Jake", Tue 7:00 AM, inviting Jake,
 * Molly and Sean (who sends: ask). The user tapped ✓, and Chord made its
 * own event and invited all three to a meeting already on their calendars.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guestCalls: Array<{ eventId: string; add?: string[] }> = [];
vi.mock('@/services/events/guests.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  changeEventGuests: vi.fn(async (_db: unknown, args: { eventId: string; add?: string[] }) => {
    guestCalls.push(args);
    return { ok: true, added: args.add ?? [], removed: [], alreadyInvited: [], notInvited: [] };
  }),
}));

import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import {
  retractProposalsCoveredByExistingEvents,
  shouldStageEventProposal,
} from '@/services/event-convergence.service.js';
import { gmailCalendarKey } from '@/services/gmail-calendar/ids.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'jdoe@rudderstack.com';
const JAKE = 'jake.guest@gmail.com';
const MOLLY = 'mmoss@rudderstack.com';
const SEAN = 'sean@rudderstack.com';
const GID = '1a1d3edffb3f341c';

/** Next week's Tuesday-ish slot at 7:00 AM New York, written with its offset. */
function nextWeekAt(hhmm: string): string {
  const day = new Date(Date.parse(`${svWall(new Date(), TZ).slice(0, 10)}T12:00:00Z`) + 5 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `${day}T${hhmm}:00${offsetForLocalDatetime(TZ, `${day}T${hhmm}:00`)}`;
}

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let accountId: string;
let cal: string;
let provenance: string;

const cardArgs = () => ({
  title: 'APAC plans meeting with Jake',
  startsAt: nextWeekAt('07:00'),
  endsAt: nextWeekAt('08:00'),
  invitees: [JAKE, MOLLY, SEAN],
  whoSends: 'ask' as const,
});

async function thread() {
  const now = new Date().toISOString();
  const threadId = newId('emt');
  const gid = `${accountId}:${GID}`;
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      account_id: accountId,
      gmail_thread_id: gid,
      subject: 'Re: APAC plans for Rudderstack',
      snippet: 'I have accepted the Tuesday invite.',
      from_email: JAKE,
      from_name: 'Jake Evans',
      last_message_at: now,
      created_at: now,
      updated_at: now,
      is_unread: 1,
    })
    .execute();
  for (const [from, to, cc, body] of [
    [MOLLY, [JAKE], [SEAN, ME], 'Tuesday next week works best on our side. Would you be available between 7:00 and 8:00 AM ET?'],
    [JAKE, [MOLLY], [SEAN, ME], 'Hi Molly, I have accepted the Tuesday invite. Look forward to it.'],
  ] as const) {
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'Re: APAC plans for Rudderstack',
        snippet: body,
        body_text: body,
        from_email: from,
        from_name: null,
        to_emails: JSON.stringify(to),
        cc_emails: JSON.stringify(cc),
        is_unread: 1,
        internal_date: now,
        created_at: now,
      })
      .execute();
  }
  provenance = `gmail:${gid}`;
}

/** Molly's invitation, as the RudderStack calendar's pull stored it. */
async function mollysInvite() {
  const now = new Date().toISOString();
  await db
    .insertInto('events')
    .values({
      id: newId('e'),
      group_id: groupId,
      created_by: null,
      owner_user_id: userId,
      title: 'Jake Evans // RudderStack: APAC 2027',
      starts_at: nextWeekAt('07:00'),
      ends_at: nextWeekAt('07:30'),
      google_calendar_id: cal,
      gcal_event_id: '139n1dvqla2u6cmqms4h7mji8m',
      ical_uid: '139n1dvqla2u6cmqms4h7mji8m@google.com',
      guest_emails: JSON.stringify([SEAN, JAKE, ME]),
      role: 'attendee',
      created_at: now,
    } as never)
    .execute();
}

async function stageCard() {
  return createProposal(db, {
    groupId,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_event',
    args: cardArgs(),
    provenance,
  });
}

beforeEach(async () => {
  guestCalls.length = 0;
  db = await openTestDb();
  userId = await createUser(db, 'john');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  await db.updateTable('users').set({ last_tz: TZ, email: 'ownertest@gmail.com' }).where('id', '=', userId).execute();
  accountId = newId('ema');
  const now = new Date().toISOString();
  cal = gmailCalendarKey(accountId, ME);
  await db
    .insertInto('email_accounts')
    .values({
      id: accountId,
      user_id: userId,
      provider: 'gmail',
      email_address: ME,
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
    provider: 'google',
    googleCalendarId: cal,
    summary: ME,
    accessRole: 'owner',
    isPrimary: false,
    selectedInGoogle: true,
    isChordTarget: false,
  });
  await thread();
});

afterEach(async () => {
  await settleBackgroundWork();
  await closeTestDb(db);
});

describe('an email meeting card adds the meeting and invites no one', () => {
  it('✓ adds the event and sends no invitation', async () => {
    const card = await stageCard();
    const r = await confirmProposal(db, { id: card.id, resolvedByUserId: userId });
    expect(r.ok).toBe(true);
    expect(guestCalls).toEqual([]);
    const ev = await db
      .selectFrom('events')
      .select(['title'])
      .where('title', '=', 'APAC plans meeting with Jake')
      .executeTakeFirstOrThrow();
    expect(ev.title).toBe('APAC plans meeting with Jake');
    const notice = await db
      .selectFrom('messages')
      .select('body')
      .where('group_id', '=', groupId)
      .where('kind', '=', 'system')
      .executeTakeFirstOrThrow();
    expect(notice.body).toContain('No invitations were sent');
    expect(notice.body).toContain(JAKE);
  });

  it('the ticked box is what invites them', async () => {
    const card = await stageCard();
    const r = await confirmProposal(db, { id: card.id, resolvedByUserId: userId, sendInvites: true });
    expect(r.ok).toBe(true);
    expect(guestCalls).toHaveLength(1);
    expect(guestCalls[0]!.add).toEqual([JAKE, MOLLY, SEAN]);
  });
});

describe("a meeting someone on the thread already sent an invitation for", () => {
  it('stages no card', async () => {
    await mollysInvite();
    const ok = await shouldStageEventProposal(db, userId, cardArgs(), { provenance });
    expect(ok).toBe(false);
  });

  it('withdraws a card staged before the invitation arrived', async () => {
    const card = await stageCard();
    await mollysInvite();
    await retractProposalsCoveredByExistingEvents(db, userId);
    const row = await db.selectFrom('proposals').select('status').where('id', '=', card.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
  });

  it('confirming anyway adds nothing and invites nobody, even with the box ticked', async () => {
    const card = await stageCard();
    await mollysInvite();
    const r = await confirmProposal(db, { id: card.id, resolvedByUserId: userId, sendInvites: true });
    expect(r.ok).toBe(true);
    expect(guestCalls).toEqual([]);
    const made = await db.selectFrom('events').select('id').where('title', '=', 'APAC plans meeting with Jake').execute();
    expect(made).toHaveLength(0);
    const notice = await db
      .selectFrom('messages')
      .select('body')
      .where('group_id', '=', groupId)
      .where('kind', '=', 'system')
      .executeTakeFirstOrThrow();
    expect(notice.body).toContain('already on your calendar');
  });

  it('a different meeting at the same time still gets its card', async () => {
    await mollysInvite();
    const ok = await shouldStageEventProposal(
      db,
      userId,
      { ...cardArgs(), title: 'Call with Kim', invitees: ['kim@elsewhere.com'] },
      { provenance: `gmail:${accountId}:kimthread` },
    );
    expect(ok).toBe(true);
  });
});
