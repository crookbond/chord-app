/**
 * A file copied out of email (ADR 0071) is auto-filed by
 * `classifyAndAutoFileAttachment` straight into trips and the calendar — no
 * card, no tap. The email-BODY path guards every one of those writes, and the
 * attachment path skipped all of them:
 *
 *  1. ADR 0158 §4 — nothing past ever surfaces. `stageFlight`/`stageHotel`
 *     drop a leg that already flew and a stay that already ended; the
 *     attachment filer filed last month's itinerary PDF from the 90-day
 *     backfill as a fresh trip.
 *  2. ADR 0294 addendum (2026-10-28) — nothing is filed from a sender the code
 *     check calls dangerous. Only magics and person extraction asked
 *     `isDangerousSender`, so a phishing "booking" PDF filed a trip.
 *  3. ADR 0073 / 0294 addendum (2026-10-29) — mail in Trash feeds nothing, and
 *     the AI passes skip archived mail. Import looked only at per-message SPAM.
 *  4. ADR 0312 — mail stays with its mailbox. Flight legs already go on their
 *     mailbox's calendar (`calendarForBooking`); a restaurant / movie / school
 *     calendar file from the same Outlook mailbox went on the user default.
 *
 * A file a person uploads themselves keeps filing what it says, past dates
 * included: that is their request, and nobody is being asked (ADR 0155).
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let reply = '';
let extractedText = '';
const BOOKING_FOOTER =
  ' Please arrive at the airport at least 90 minutes before departure. Bags must be checked 45 minutes prior. Fare rules apply.';
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'classifier-mock',
    defaultModel: 'classifier-mock',
    supportsNativeTools: false,
    complete: async () => reply,
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('not used'); },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});
vi.mock('@/services/attachments.extract.js', () => ({
  extractAndSummarize: vi.fn(async () => ({ text: extractedText, summary: 'Booking document' })),
}));

const PDF = Buffer.from('%PDF-1.4 itinerary');
let partName = 'Itinerary.pdf';
vi.mock('@/services/email-accounts/attachment-fetch.js', () => ({
  attachmentPartsFor: vi.fn(async () => [
    { id: 'p1', filename: partName, mimeType: 'application/pdf', size: PDF.byteLength },
  ]),
  fetchEmailAttachmentData: vi.fn(async () => ({ buffer: PDF, mimeType: 'application/pdf', filename: partName })),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { saveFile } from '@/services/attachments.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { importEmailAttachments } from '@/services/email/attachment-import.js';
import { isDangerousSender } from '@/services/email/sender-check/prompt.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { __resetOutlookCalendarTokens } from '@/services/outlook-calendar/accounts.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type Env = { OUTLOOK_CALENDAR_ENABLED: boolean; OUTLOOK_PROVIDER: 'real' | 'mock' };
const saved: Env = { OUTLOOK_CALENDAR_ENABLED: env.OUTLOOK_CALENDAR_ENABLED, OUTLOOK_PROVIDER: env.OUTLOOK_PROVIDER };
const setEnv = (over: Partial<Env>) => Object.assign(env as unknown as Env, over);

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db
    .updateTable('users')
    .set({ email: 'ownertest@gmail.com', last_tz: 'America/New_York' })
    .where('id', '=', userId)
    .execute();
  await ensurePersonalGroup(db, userId);
  partName = 'Itinerary.pdf';
});

afterEach(async () => {
  await settleBackgroundWork();
  setEnv(saved);
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

interface SeedOpts {
  from?: { name: string; email: string };
  labels?: string[];
  archived?: boolean;
  accountId?: string | null;
  receivedDaysAgo?: number;
}

async function seedEmailWithPdf(opts: SeedOpts = {}): Promise<{ threadId: string; gid: string }> {
  const from = opts.from ?? { name: 'Southwest Airlines', email: 'southwestairlines@ifly.southwest.com' };
  const labels = opts.labels ?? ['INBOX'];
  const at = new Date(Date.now() - (opts.receivedDaysAgo ?? 0) * 86_400_000).toISOString();
  const gid = opts.accountId ? `${opts.accountId}:${newId('x')}` : `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      account_id: opts.accountId ?? null,
      subject: 'Your trip confirmation',
      snippet: 'Your itinerary is attached.',
      from_email: from.email,
      from_name: from.name,
      last_message_at: at,
      is_unread: 0,
      is_archived: opts.archived ? 1 : 0,
      gmail_label_ids: JSON.stringify(labels),
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${gid}`,
      gmail_thread_id: gid,
      account_id: opts.accountId ?? null,
      from_name: from.name,
      from_email: from.email,
      to_emails: JSON.stringify(['ownertest@gmail.com']),
      cc_emails: JSON.stringify([]),
      subject: 'Your trip confirmation',
      snippet: 'Your itinerary is attached.',
      body_text: 'Your itinerary is attached.',
      internal_date: at,
      is_unread: 0,
      gmail_label_ids: JSON.stringify(labels),
      created_at: at,
    })
    .execute();
  return { threadId, gid };
}

function flightReply(legs: { origin: string; destination: string; departAt: string; arriveAt: string }[]): string {
  return JSON.stringify({
    kind: 'flight',
    confirmation: 'K7QZ4M',
    passengerName: 'John Doe',
    legs: legs.map((l) => ({ ...l, carrier: 'Southwest', flightNo: 'WN 1123' })),
  });
}

const legs = () => db.selectFrom('travel_legs').select(['origin', 'destination', 'depart_at']).execute();
const trips = () => db.selectFrom('trips').select(['id', 'name']).where('deleted_at', 'is', null).execute();
const attachments = () => db.selectFrom('attachments').select(['id', 'origin_email_thread_id']).execute();

describe('a file copied from email is filed under the email path\'s rules', () => {
  it('does not file last month\'s itinerary from the backfill as a trip (ADR 0158 §4)', async () => {
    extractedText = 'Southwest Airlines itinerary K7QZ4M. LGA to MDW. Return MDW to LGA.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'LGA', destination: 'MDW', departAt: `${day(-34)}T07:05:00`, arriveAt: `${day(-34)}T09:00:00` },
      { origin: 'MDW', destination: 'LGA', departAt: `${day(-30)}T18:15:00`, arriveAt: `${day(-30)}T21:40:00` },
    ]);
    await seedEmailWithPdf({ receivedDaysAgo: 41 });

    const res = await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(res.imported).toBe(1); // still in the knowledge base
    expect(await legs()).toEqual([]);
    expect(await trips()).toEqual([]);
  });

  it('keeps only the legs still ahead of a trip already under way', async () => {
    extractedText = 'Southwest Airlines itinerary K7QZ4M. LGA to MDW. Return MDW to LGA.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'LGA', destination: 'MDW', departAt: `${day(-3)}T07:05:00`, arriveAt: `${day(-3)}T09:00:00` },
      { origin: 'MDW', destination: 'LGA', departAt: `${day(4)}T18:15:00`, arriveAt: `${day(4)}T21:40:00` },
    ]);
    await seedEmailWithPdf();

    await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    const filed = await legs();
    expect(filed.map((l) => `${l.origin}-${l.destination}`)).toEqual(['MDW-LGA']);
  });

  it('does not file a hotel stay that already ended', async () => {
    extractedText = 'Hyatt Regency Chicago. Confirmation 58123901. Check-in / check-out.' + BOOKING_FOOTER;
    reply = JSON.stringify({
      kind: 'hotel',
      propertyName: 'Hyatt Regency Chicago',
      city: 'Chicago',
      checkinDate: day(-34),
      checkoutDate: day(-30),
      confirmation: '58123901',
    });
    await seedEmailWithPdf({ from: { name: 'Hyatt', email: 'reservations@hyatt.com' } });

    await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(await db.selectFrom('accommodations').select('id').execute()).toEqual([]);
    expect(await trips()).toEqual([]);
  });

  it('files only the dates still ahead of a school calendar mailed as a PDF', async () => {
    partName = 'LakesideCalendar2026.pdf';
    extractedText = 'Lakeside School calendar. Picture Day, Fall Break, Spring Concert.' + BOOKING_FOOTER;
    reply = JSON.stringify({
      kind: 'calendar',
      events: [
        { title: 'Picture Day', startsAt: day(-20) },
        { title: 'Fall Break - No School', startsAt: day(-6) },
        { title: 'Spring Concert', startsAt: day(25) },
      ],
    });
    await seedEmailWithPdf({ from: { name: 'Lakeside School', email: 'office@lakesideschool.org' } });

    await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    const titles = (await db.selectFrom('events').select('title').execute()).map((e) => e.title);
    expect(titles).toEqual(['Spring Concert']);
  });

  it('files nothing from a phishing "booking" PDF (ADR 0294)', async () => {
    extractedText = 'Delta Air Lines e-ticket. JFK to ATL. Confirm your seat at delta-checkin-alerts.com.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'JFK', destination: 'ATL', departAt: `${day(9)}T08:00:00`, arriveAt: `${day(9)}T10:40:00` },
    ]);
    const { threadId } = await seedEmailWithPdf({
      from: { name: 'Delta Air Lines', email: 'eticket@delta-checkin-alerts.com' },
    });
    expect(await isDangerousSender(db, userId, threadId)).toBe(true);

    const res = await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(res.imported).toBe(1);
    expect(await legs()).toEqual([]);
    expect(await trips()).toEqual([]);
  });

  it('imports nothing from mail in Trash', async () => {
    extractedText = 'Southwest Airlines itinerary K7QZ4M. LGA to MDW.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'LGA', destination: 'MDW', departAt: `${day(9)}T07:05:00`, arriveAt: `${day(9)}T09:00:00` },
    ]);
    await seedEmailWithPdf({ labels: ['TRASH'], archived: true });

    const res = await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(res.imported).toBe(0);
    expect(await attachments()).toEqual([]);
    expect(await legs()).toEqual([]);
  });

  it('keeps an archived email\'s file searchable but files nothing from it', async () => {
    extractedText = 'Southwest Airlines itinerary K7QZ4M. LGA to MDW.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'LGA', destination: 'MDW', departAt: `${day(9)}T07:05:00`, arriveAt: `${day(9)}T09:00:00` },
    ]);
    await seedEmailWithPdf({ labels: [], archived: true });

    const res = await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(res.imported).toBe(1);
    expect(await legs()).toEqual([]);
  });

  it('puts a dinner reservation mailed to the work Outlook on the work calendar (ADR 0312)', async () => {
    setEnv({ OUTLOOK_CALENDAR_ENABLED: true, OUTLOOK_PROVIDER: 'real' });
    __resetOutlookCalendarTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' })),
    );
    const now = new Date().toISOString();
    const work = newId('ema');
    await db
      .insertInto('email_accounts')
      .values({
        id: work,
        user_id: userId,
        provider: 'outlook',
        email_address: 'john@work.example',
        display_name: 'John',
        preset_key: null,
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        status: 'ok',
        calendar_enabled: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await upsertCalendarSource(db, userId, {
      provider: 'outlook',
      googleCalendarId: WORK_CAL,
      summary: 'Calendar',
      accessRole: 'owner',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    // The user's own default is a family Google calendar: the work dinner must not go there.
    const FAMILY = 'family123@group.calendar.google.com';
    await upsertCalendarSource(db, userId, {
      provider: 'google',
      googleCalendarId: FAMILY,
      summary: 'Family',
      accessRole: 'owner',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar', default_calendar_id: FAMILY })
      .where('id', '=', userId)
      .execute();

    partName = 'OpenTable-Confirmation.pdf';
    extractedText = 'OpenTable reservation confirmed. Gramercy Tavern, party of 4.' + BOOKING_FOOTER;
    reply = JSON.stringify({
      kind: 'restaurant',
      name: 'Gramercy Tavern',
      dateTime: `${day(6)}T19:30:00`,
      address: '42 E 20th St, New York, NY 10003',
      partySize: 4,
    });
    await seedEmailWithPdf({ accountId: work, from: { name: 'OpenTable', email: 'member_services@opentable.com' } });

    await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    const events = await db.selectFrom('events').select(['title', 'google_calendar_id']).execute();
    expect(events).toEqual([{ title: 'Gramercy Tavern', google_calendar_id: WORK_CAL }]);
  });
});

describe('a file the user uploads themselves', () => {
  it('still files a past itinerary: the upload is their request', async () => {
    extractedText = 'Southwest Airlines itinerary K7QZ4M. LGA to MDW.' + BOOKING_FOOTER;
    reply = flightReply([
      { origin: 'LGA', destination: 'MDW', departAt: `${day(-34)}T07:05:00`, arriveAt: `${day(-34)}T09:00:00` },
    ]);
    const personal = await ensurePersonalGroup(db, userId);
    await saveFile(db, {
      scope: { kind: 'group', groupId: personal.id },
      uploadedBy: userId,
      filename: 'Itinerary.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
      awaitExtraction: true,
    });
    await settleBackgroundWork();

    expect((await legs()).map((l) => `${l.origin}-${l.destination}`)).toEqual(['LGA-MDW']);
  });
});
