/**
 * Coverage for the incidental-attachment retention sweep
 * (insurance-cards-file-link-bug): a direct upload never expires; an
 * email-auto-imported (ADR 0071) attachment expires after
 * ATTACHMENT_RETENTION_DAYS unless pinned.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccommodationsTable, AttachmentsTable, DB, TravelLegsTable, TripsTable } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { createGroup } from '@/services/groups.service.js';
import {
  expireExpiredItineraryAttachments,
  expireIncidentalAttachments,
} from '@/services/attachments.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

async function insertEmailThread(db: Kysely<DB>, id: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: `g_${id}`,
      subject: 'Test thread',
      snippet: 'Test thread',
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertAttachment(
  db: Kysely<DB>,
  over: Partial<AttachmentsTable> & Pick<AttachmentsTable, 'id' | 'scope_id' | 'uploaded_by' | 'path'>,
): Promise<void> {
  const row: AttachmentsTable = {
    scope_kind: 'group',
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    size: 1234,
    summary: null,
    extracted_text: null,
    image_meta: null,
    pinned: 0,
    indexed_at: new Date().toISOString(),
    created_at: daysAgo(0),
    ...over,
  } as AttachmentsTable;
  await db.insertInto('attachments').values(row).execute();
}

async function exists(db: Kysely<DB>, id: string): Promise<boolean> {
  const row = await db.selectFrom('attachments').select('id').where('id', '=', id).executeTakeFirst();
  return !!row;
}

describe('expireIncidentalAttachments', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let userId: string;
  let retentionDaysBefore: number;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    groupId = group.id;
    retentionDaysBefore = env.ATTACHMENT_RETENTION_DAYS;
    (env as { ATTACHMENT_RETENTION_DAYS: number }).ATTACHMENT_RETENTION_DAYS = 30;
  });

  afterEach(async () => {
    (env as { ATTACHMENT_RETENTION_DAYS: number }).ATTACHMENT_RETENTION_DAYS = retentionDaysBefore;
    await closeTestDb(db);
  });

  it('expires an old, unpinned, email-imported attachment', async () => {
    await insertEmailThread(db, 'et_1', userId);
    await insertAttachment(db, {
      id: 'a_old_import',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_old_import/coupon.jpg`,
      origin_email_thread_id: 'et_1',
      created_at: daysAgo(45),
    });

    const n = await expireIncidentalAttachments(db);
    expect(n).toBe(1);
    expect(await exists(db, 'a_old_import')).toBe(false);
  });

  it('never expires a direct upload, however old', async () => {
    await insertAttachment(db, {
      id: 'a_direct_upload',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_direct_upload/insurance.jpg`,
      origin_email_thread_id: null,
      created_at: daysAgo(400),
    });

    const n = await expireIncidentalAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_direct_upload')).toBe(true);
  });

  it('never expires a pinned email-imported attachment', async () => {
    await insertEmailThread(db, 'et_2', userId);
    await insertAttachment(db, {
      id: 'a_pinned_import',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_pinned_import/lease.pdf`,
      origin_email_thread_id: 'et_2',
      pinned: 1,
      created_at: daysAgo(400),
    });

    const n = await expireIncidentalAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_pinned_import')).toBe(true);
  });

  it('keeps a recent email-imported attachment inside the retention window', async () => {
    await insertEmailThread(db, 'et_3', userId);
    await insertAttachment(db, {
      id: 'a_recent_import',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_recent_import/itinerary.pdf`,
      origin_email_thread_id: 'et_3',
      created_at: daysAgo(5),
    });

    const n = await expireIncidentalAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_recent_import')).toBe(true);
  });
});

async function insertTrip(db: Kysely<DB>, over: Partial<TripsTable> & Pick<TripsTable, 'id' | 'group_id'>): Promise<void> {
  const row: TripsTable = {
    name: 'Test trip',
    destination: 'Somewhere',
    start_date: daysAgo(10).slice(0, 10),
    end_date: daysAgo(3).slice(0, 10),
    created_by: null,
    created_at: new Date().toISOString(),
    source_raw_context: null,
    cancelled_at: null,
    deleted_at: null,
    ...over,
  } as TripsTable;
  await db.insertInto('trips').values(row).execute();
}

async function insertLeg(
  db: Kysely<DB>,
  over: Partial<TravelLegsTable> & Pick<TravelLegsTable, 'trip_id' | 'source_doc_id'>,
): Promise<void> {
  const row: TravelLegsTable = {
    id: newId('tl'),
    persona_id: null,
    passenger_name: null,
    mode: 'flight',
    origin: 'JFK',
    destination: 'SFO',
    depart_at: daysAgo(10),
    arrive_at: daysAgo(10),
    carrier: null,
    flight_no: null,
    confirmation: null,
    notes: null,
    created_at: new Date().toISOString(),
    source_raw_context: null,
    cancelled_at: null,
    ...over,
  } as TravelLegsTable;
  await db.insertInto('travel_legs').values(row).execute();
}

async function insertStay(
  db: Kysely<DB>,
  over: Partial<AccommodationsTable> & Pick<AccommodationsTable, 'trip_id' | 'source_doc_id'>,
): Promise<void> {
  const row: AccommodationsTable = {
    id: newId('ac'),
    property_name: 'Test Hotel',
    address: null,
    checkin_date: daysAgo(10).slice(0, 10),
    checkout_date: daysAgo(3).slice(0, 10),
    room_count: null,
    confirmation: null,
    notes: null,
    created_at: new Date().toISOString(),
    source_raw_context: null,
    cancelled_at: null,
    ...over,
  } as AccommodationsTable;
  await db.insertInto('accommodations').values(row).execute();
}

describe('expireExpiredItineraryAttachments', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let userId: string;
  let graceDaysBefore: number;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    groupId = group.id;
    graceDaysBefore = env.ATTACHMENT_ITINERARY_GRACE_DAYS;
    (env as { ATTACHMENT_ITINERARY_GRACE_DAYS: number }).ATTACHMENT_ITINERARY_GRACE_DAYS = 7;
  });

  afterEach(async () => {
    (env as { ATTACHMENT_ITINERARY_GRACE_DAYS: number }).ATTACHMENT_ITINERARY_GRACE_DAYS = graceDaysBefore;
    await closeTestDb(db);
  });

  it('expires a directly-uploaded boarding pass once its flight has landed past the grace window', async () => {
    await insertAttachment(db, {
      id: 'a_boarding_pass',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_boarding_pass/pass.pdf`,
      created_at: daysAgo(20),
    });
    await insertTrip(db, { id: 'tr_1', group_id: groupId });
    await insertLeg(db, { trip_id: 'tr_1', source_doc_id: 'a_boarding_pass', arrive_at: daysAgo(10) });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(1);
    expect(await exists(db, 'a_boarding_pass')).toBe(false);
  });

  it('keeps a round-trip itinerary alive until the LATER leg passes', async () => {
    await insertAttachment(db, {
      id: 'a_roundtrip',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_roundtrip/itinerary.pdf`,
    });
    await insertTrip(db, { id: 'tr_2', group_id: groupId });
    // Outbound already landed, well past grace...
    await insertLeg(db, { trip_id: 'tr_2', source_doc_id: 'a_roundtrip', arrive_at: daysAgo(10) });
    // ...but the return leg hasn't happened yet — same attachment backs both.
    const future = new Date(Date.now() + 3 * DAY).toISOString();
    await insertLeg(db, { trip_id: 'tr_2', source_doc_id: 'a_roundtrip', arrive_at: future });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_roundtrip')).toBe(true);
  });

  it('never expires a pinned itinerary attachment, however long past', async () => {
    await insertAttachment(db, {
      id: 'a_pinned_itinerary',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_pinned_itinerary/pass.pdf`,
      pinned: 1,
    });
    await insertTrip(db, { id: 'tr_3', group_id: groupId });
    await insertLeg(db, { trip_id: 'tr_3', source_doc_id: 'a_pinned_itinerary', arrive_at: daysAgo(100) });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_pinned_itinerary')).toBe(true);
  });

  it('expires a hotel confirmation once checkout has passed the grace window', async () => {
    await insertAttachment(db, {
      id: 'a_hotel_conf',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_hotel_conf/confirmation.pdf`,
    });
    await insertTrip(db, { id: 'tr_4', group_id: groupId });
    await insertStay(db, { trip_id: 'tr_4', source_doc_id: 'a_hotel_conf', checkout_date: daysAgo(10).slice(0, 10) });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(1);
    expect(await exists(db, 'a_hotel_conf')).toBe(false);
  });

  it('keeps a future stay alive', async () => {
    await insertAttachment(db, {
      id: 'a_future_stay',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_future_stay/confirmation.pdf`,
    });
    await insertTrip(db, { id: 'tr_5', group_id: groupId });
    const future = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    await insertStay(db, { trip_id: 'tr_5', source_doc_id: 'a_future_stay', checkout_date: future });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_future_stay')).toBe(true);
  });

  it('expires an attachment on a user-deleted trip even with a future leg date', async () => {
    await insertAttachment(db, {
      id: 'a_deleted_trip_leg',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_deleted_trip_leg/pass.pdf`,
    });
    await insertTrip(db, { id: 'tr_6', group_id: groupId, deleted_at: new Date().toISOString() });
    const future = new Date(Date.now() + 30 * DAY).toISOString();
    await insertLeg(db, { trip_id: 'tr_6', source_doc_id: 'a_deleted_trip_leg', arrive_at: future });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(1);
    expect(await exists(db, 'a_deleted_trip_leg')).toBe(false);
  });

  // An arrival is stored on its airport's clock, so its text is not in UTC
  // order with the cutoff (ADR 0208).
  const atOffset = (ms: number, offsetHours: number): string => {
    const wall = new Date(ms + offsetHours * 3_600_000).toISOString().slice(0, 19);
    const sign = offsetHours < 0 ? '-' : '+';
    return `${wall}${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  };
  const GRACE_MS = 7 * DAY;

  it('expires a ticket that landed past the grace window on a clock ahead of UTC', async () => {
    await insertAttachment(db, {
      id: 'a_tokyo_landing',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_tokyo_landing/pass.pdf`,
      created_at: daysAgo(20),
    });
    await insertTrip(db, { id: 'tr_tokyo', group_id: groupId });
    // Landed two hours before the cutoff, written in Tokyo time.
    await insertLeg(db, {
      trip_id: 'tr_tokyo',
      source_doc_id: 'a_tokyo_landing',
      arrive_at: atOffset(Date.now() - GRACE_MS - 2 * 3_600_000, 9),
    });

    expect(await expireExpiredItineraryAttachments(db)).toBe(1);
    expect(await exists(db, 'a_tokyo_landing')).toBe(false);
  });

  it('keeps a ticket still inside the grace window on a clock behind UTC', async () => {
    await insertAttachment(db, {
      id: 'a_sfo_landing',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_sfo_landing/pass.pdf`,
      created_at: daysAgo(20),
    });
    await insertTrip(db, { id: 'tr_sfo', group_id: groupId });
    // Landed two hours after the cutoff, written in Pacific time.
    await insertLeg(db, {
      trip_id: 'tr_sfo',
      source_doc_id: 'a_sfo_landing',
      arrive_at: atOffset(Date.now() - GRACE_MS + 2 * 3_600_000, -8),
    });

    expect(await expireExpiredItineraryAttachments(db)).toBe(0);
    expect(await exists(db, 'a_sfo_landing')).toBe(true);
  });

  it('keeps a hotel confirmation whose checkout is the cutoff day', async () => {
    await insertAttachment(db, {
      id: 'a_cutoff_day_stay',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_cutoff_day_stay/hotel.pdf`,
      created_at: daysAgo(20),
    });
    await insertTrip(db, { id: 'tr_cutoff', group_id: groupId });
    await insertStay(db, {
      trip_id: 'tr_cutoff',
      source_doc_id: 'a_cutoff_day_stay',
      checkout_date: new Date(Date.now() - GRACE_MS).toISOString().slice(0, 10),
    });

    expect(await expireExpiredItineraryAttachments(db)).toBe(0);
    expect(await exists(db, 'a_cutoff_day_stay')).toBe(true);
  });

  it('never touches an attachment that is not linked to any trip', async () => {
    await insertAttachment(db, {
      id: 'a_unrelated',
      scope_id: groupId,
      uploaded_by: userId,
      path: `group/${groupId}/a_unrelated/doc.pdf`,
      created_at: daysAgo(400),
    });

    const n = await expireExpiredItineraryAttachments(db);
    expect(n).toBe(0);
    expect(await exists(db, 'a_unrelated')).toBe(true);
  });
});
