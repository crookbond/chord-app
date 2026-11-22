/**
 * ADR 0312 — disconnecting a mailbox removes what its mail produced, and
 * nothing else. The shape is a family's: a trip that mixes a flight from the
 * work mailbox with a stay typed by hand, people and facts from several
 * mailboxes, receipts from each.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'google-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { disconnectAccount } from '@/services/email-accounts/accounts.service.js';
import { disconnectGmail } from '@/services/google/gmail.service.js';
import { createGroup } from '@/services/groups.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import { __resetOutlookCalendarTokens } from '@/services/outlook-calendar/accounts.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { createPerson } from '@/services/people.service.js';
import { addAccommodation, addTravelLeg, createTrip } from '@/services/trips.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

type Env = { OUTLOOK_CALENDAR_ENABLED: boolean; OUTLOOK_PROVIDER: 'real' | 'mock' };
const saved: Env = { OUTLOOK_CALENDAR_ENABLED: env.OUTLOOK_CALENDAR_ENABLED, OUTLOOK_PROVIDER: env.OUTLOOK_PROVIDER };
const setEnv = (over: Partial<Env>) => Object.assign(env as unknown as Env, over);

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let work: string;
let yahoo: string;
let WORK_CAL: string;

async function seedAccount(provider: 'outlook' | 'imap', email: string, over: Record<string, unknown> = {}) {
  const id = newId('ema');
  const now = new Date().toISOString();
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
      calendar_enabled: 0,
      created_at: now,
      updated_at: now,
      ...over,
    })
    .execute();
  return id;
}

async function seedReceipt(accountId: string | null, thread: string) {
  await db
    .insertInto('email_receipts')
    .values({
      id: newId('rc'),
      user_id: userId,
      gmail_thread_id: thread,
      receipt_json: JSON.stringify({ merchant: 'Shop', amount: 10, currency: 'USD' }),
      from_name: 'Shop',
      from_email: 'orders@shop.example',
      account_id: accountId,
      mailbox: null,
      email_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
}

beforeEach(async () => {
  setEnv({ OUTLOOK_CALENDAR_ENABLED: true, OUTLOOK_PROVIDER: 'real' });
  __resetOutlookCalendarTokens();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' })),
  );
  db = await openTestDb();
  userId = await createUser(db, 'john');
  groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: userId })).id;
  work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
  WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
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
  yahoo = await seedAccount('imap', 'john@yahoo.example');
});

afterEach(async () => {
  await settleBackgroundWork();
  setEnv(saved);
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

const workMail = () => `gmail:${work}:AAMkAGI2-${Math.random().toString(36).slice(2)}`;

describe('disconnecting a mailbox', () => {
  it('removes what its mail made and keeps everything else', async () => {
    // A family Google calendar is the default: the work flight must not go there.
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
    // A trip the work mail made, with a typed stay added by hand.
    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Denver offsite',
      destination: 'Denver',
      startDate: day(10),
      endDate: day(13),
      participantIds: [],
      sourceRawContext: workMail(),
    });
    const leg = await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'BOS',
      destination: 'DEN',
      departAt: `${day(10)}T13:00:00.000Z`,
      arriveAt: `${day(10)}T17:00:00.000Z`,
      carrier: 'UA',
      flightNo: '1234',
      confirmation: 'KX8QP2',
      passengerName: 'John Doe',
      sourceRawContext: workMail(),
    });
    const stay = await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'The Crawford',
      checkinDate: day(10),
      checkoutDate: day(13),
    });
    // A trip entirely from the Yahoo mailbox: not this mailbox's to remove.
    const yahooTrip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Vail',
      destination: 'Vail',
      startDate: day(40),
      endDate: day(44),
      participantIds: [],
      sourceRawContext: `gmail:${yahoo}:4711`,
    });
    await addAccommodation(db, {
      tripId: yahooTrip.id,
      propertyName: 'Arrabelle',
      checkinDate: day(40),
      checkoutDate: day(44),
      sourceRawContext: `gmail:${yahoo}:4711`,
    });
    await settleBackgroundWork();

    // The flight event went on the WORK calendar, not anywhere else.
    const legEvent = await db
      .selectFrom('events')
      .select(['id', 'google_calendar_id'])
      .where('external_uid', '=', `chord:travel_leg:${leg.id}`)
      .executeTakeFirst();
    expect(legEvent?.google_calendar_id).toBe(WORK_CAL);

    const fromWork = await createPerson(db, { ownerUserId: userId, displayName: 'Bill Mills', provenance: workMail() });
    const typed = await createPerson(db, { ownerUserId: userId, displayName: 'Grandma' });
    const fromYahoo = await createPerson(db, { ownerUserId: userId, displayName: 'Coach Dana', provenance: `gmail:${yahoo}:9` });

    // A typed fact replaced by one from work mail comes back when it goes.
    const typedFact = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'office_city',
      value: 'Boston',
      source: 'explicit',
      status: 'confirmed',
    });
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'office_city',
      value: 'Cambridge',
      source: 'extracted',
      status: 'confirmed',
      provenance: workMail(),
    });

    await seedReceipt(work, `${work}:r1`);
    await seedReceipt(yahoo, `${yahoo}:r2`);
    await seedReceipt(null, '18f2a9c0');

    expect(await disconnectAccount(db, userId, work)).toBe(true);
    await settleBackgroundWork();

    const legs = await db.selectFrom('travel_legs').select('id').where('trip_id', '=', trip.id).execute();
    expect(legs).toEqual([]);
    const stays = await db.selectFrom('accommodations').select('id').where('trip_id', '=', trip.id).execute();
    expect(stays.map((s) => s.id)).toEqual([stay.id]);
    const tripRow = await db.selectFrom('trips').select('deleted_at').where('id', '=', trip.id).executeTakeFirstOrThrow();
    expect(tripRow.deleted_at).toBeNull(); // still holds the typed stay
    expect(
      await db.selectFrom('events').select('id').where('external_uid', '=', `chord:travel_leg:${leg.id}`).execute(),
    ).toEqual([]);

    const yahooRow = await db.selectFrom('trips').select('deleted_at').where('id', '=', yahooTrip.id).executeTakeFirstOrThrow();
    expect(yahooRow.deleted_at).toBeNull();

    const peopleLeft = (await db.selectFrom('people').select('id').where('owner_user_id', '=', userId).execute()).map((p) => p.id);
    expect(peopleLeft).not.toContain(fromWork.id);
    expect(peopleLeft).toEqual(expect.arrayContaining([typed.id, fromYahoo.id]));

    const facts = await db
      .selectFrom('memories')
      .select(['id', 'value', 'superseded_by'])
      .where('group_id', '=', groupId)
      .where('key', '=', 'office_city')
      .execute();
    expect(facts).toEqual([{ id: typedFact.id, value: 'Boston', superseded_by: null }]);

    const receipts = await db.selectFrom('email_receipts').select('account_id').where('user_id', '=', userId).execute();
    expect(receipts.map((r) => r.account_id).sort()).toEqual([null, yahoo].sort());
  });

  it('removes a trip the mail made once nothing typed is left on it', async () => {
    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Chicago',
      destination: 'Chicago',
      startDate: day(20),
      endDate: day(22),
      participantIds: [],
      sourceRawContext: workMail(),
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Palmer House',
      checkinDate: day(20),
      checkoutDate: day(22),
      sourceRawContext: workMail(),
    });
    await disconnectAccount(db, userId, work);
    const row = await db.selectFrom('trips').select('deleted_at').where('id', '=', trip.id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });

  it('disconnecting the primary Gmail leaves attached mailboxes alone', async () => {
    const primaryPerson = await createPerson(db, { ownerUserId: userId, displayName: 'Ms Patel', provenance: 'gmail:18f2a9c0d1e2' });
    const workPerson = await createPerson(db, { ownerUserId: userId, displayName: 'Bill Mills', provenance: workMail() });
    await seedReceipt(null, '18f2a9c0');
    await seedReceipt(work, `${work}:r1`);

    await disconnectGmail(db, userId);

    const left = (await db.selectFrom('people').select('id').where('owner_user_id', '=', userId).execute()).map((p) => p.id);
    expect(left).toEqual([workPerson.id]);
    expect(left).not.toContain(primaryPerson.id);
    const receipts = await db.selectFrom('email_receipts').select('account_id').where('user_id', '=', userId).execute();
    expect(receipts.map((r) => r.account_id)).toEqual([work]);
  });

  it('disconnecting the primary Gmail leaves another member’s mail-made rows on a shared trip', async () => {
    // Audit: a bare `gmail:` provenance is what EVERY member's primary
    // mailbox writes, so disconnecting John's primary deleted Alice's leg
    // on his trip and her fact in the family group.
    const alice = await createUser(db, 'alice');
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: alice, role: 'member', tier: 'trusted', joined_at: new Date().toISOString() })
      .execute();
    const mine = 'gt_john_primary_1';
    await seedSyncedMail(db, userId, { gmailThreadId: mine, subject: 'Your UA itinerary', fromEmail: 'ua@united.example' });
    const hers = 'gt_alice_primary_1';
    await seedSyncedMail(db, alice, { gmailThreadId: hers, subject: 'Your DL itinerary', fromEmail: 'dl@delta.example' });

    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Denver',
      destination: 'Denver',
      startDate: day(10),
      endDate: day(14),
      participantIds: [],
    });
    const leg = (flightNo: string, passengerName: string, ctx: string) =>
      addTravelLeg(db, {
        tripId: trip.id,
        mode: 'flight',
        origin: 'BOS',
        destination: 'DEN',
        departAt: `${day(10)}T13:00:00.000Z`,
        arriveAt: `${day(10)}T17:00:00.000Z`,
        carrier: 'UA',
        flightNo,
        passengerName,
        sourceRawContext: ctx,
      });
    const johnLeg = await leg('1234', 'John Doe', `gmail:${mine}`);
    const aliceLeg = await leg('5678', 'Alice Doe', `gmail:${hers}`);
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'school_name',
      value: 'Lincoln Elementary',
      source: 'extracted',
      status: 'confirmed',
      provenance: `gmail:${hers}`,
    });

    await disconnectGmail(db, userId);

    const legs = (await db.selectFrom('travel_legs').select('id').where('trip_id', '=', trip.id).execute()).map(
      (l) => l.id,
    );
    expect(legs).toEqual([aliceLeg.id]);
    expect(legs).not.toContain(johnLeg.id);
    const facts = await db.selectFrom('memories').select('value').where('group_id', '=', groupId).execute();
    expect(facts.map((f) => f.value)).toContain('Lincoln Elementary');
  });

  it('keeps everything when the mailbox is moving to another account, not leaving', async () => {
    const person = await createPerson(db, { ownerUserId: userId, displayName: 'Bill Mills', provenance: workMail() });
    await disconnectAccount(db, userId, work, { keepDerived: true });
    expect(await db.selectFrom('people').select('id').where('id', '=', person.id).executeTakeFirst()).toBeDefined();
  });
});
