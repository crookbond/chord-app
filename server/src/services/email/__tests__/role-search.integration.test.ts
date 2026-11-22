/**
 * "Mail from the dentist" (ADR 0275), on sealed mail through the bot's search
 * tool. A role is not a name: the eval's "mail from the dentist" returned
 * nothing, because nothing called Dentist ever wrote. It is found, strongest
 * first, in People notes, then saved contacts, then senders' own names, then
 * the phone's address book (company / job title) - and the bot offers to
 * remember what the phone found.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SSE, type DeviceContactLookupRequest } from '@chord/kernel';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { answerDeviceContactLookup } from '@/services/bot/device-contact-lookup.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { toolSchemas } from '@/services/bot/tools.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const ME = 'me@family.test';
const legacy = env as { CONTENT_LEGACY_TSV: boolean; CONTACT_LOOKUP_TIMEOUT_MS: number };
const saved = { CONTENT_LEGACY_TSV: env.CONTENT_LEGACY_TSV, CONTACT_LOOKUP_TIMEOUT_MS: env.CONTACT_LOOKUP_TIMEOUT_MS };

let db: Kysely<DB>;
let userId: string;
let personalId: string;
let phone: ((req: DeviceContactLookupRequest) => void) | null;
let lookups: DeviceContactLookupRequest[];

async function search(args: Record<string, unknown>) {
  const r = await applyToolCall(db, {
    groupId: personalId,
    actorUserId: userId,
    provenance: null,
    mode: 'commit',
    tz: 'America/New_York',
    call: { name: 'search', args: toolSchemas.search.parse({ categories: ['emails'], ...args }) } as never,
    emit: ((_channel: string, event: string, data: unknown) => {
      if (event !== SSE.contactLookup) return;
      lookups.push(data as DeviceContactLookupRequest);
      if (phone) setTimeout(() => phone?.(data as DeviceContactLookupRequest), 5);
    }) as never,
  });
  const d = r.data as { emails: Array<{ subject: string }>; people?: Array<{ via?: string; status: string }>; instruction: string };
  return { subjects: d.emails.map((e) => e.subject), people: d.people ?? [], instruction: d.instruction };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(async () => {
  db = await openTestDb();
  // After opening: openTestDb sets encryption back to its default.
  setContentEncryption(true);
  legacy.CONTENT_LEGACY_TSV = false;
  legacy.CONTACT_LOOKUP_TIMEOUT_MS = 300;
  userId = await createUser(db, 'pat');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
  phone = null;
  lookups = [];
  await seedSyncedMail(db, userId, { subject: 'Dental plans that save you money', fromName: 'Dentalplans Weekly', fromEmail: 'news@dentalplansweekly.test', toEmails: [ME], at: daysAgo(1) });
  await seedSyncedMail(db, userId, { subject: 'Tee time Saturday?', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], at: daysAgo(2) });
});

afterEach(async () => {
  Object.assign(legacy, saved);
  setContentEncryption(false);
  await closeTestDb(db);
});

describe('a role found by the server', () => {
  it("finds the dentist by the sender's own name, not a newsletter that only sounds like one", async () => {
    await seedSyncedMail(db, userId, { subject: 'Reminder from Dr. Patel', fromName: 'Bright Smiles Dental', fromEmail: 'frontdesk@brightsmiles.test', toEmails: [ME], at: daysAgo(4) });
    const r = await search({ from: 'the dentist' });
    expect(r.subjects).toEqual(['Reminder from Dr. Patel']);
    expect(r.people[0]).toMatchObject({ status: 'resolved', via: 'senders' });
    expect(lookups).toEqual([]);
  });

  it('reads plain "mail from the dentist" the same way', async () => {
    await seedSyncedMail(db, userId, { subject: 'Reminder from Dr. Patel', fromName: 'Bright Smiles Dental', fromEmail: 'frontdesk@brightsmiles.test', toEmails: [ME], at: daysAgo(4) });
    expect((await search({ query: 'mail from the dentist' })).subjects).toEqual(['Reminder from Dr. Patel']);
  });

  it('prefers a People row the user wrote "dentist" on', async () => {
    await seedSyncedMail(db, userId, { subject: 'Your cleaning is due', fromName: 'Raj Patel', fromEmail: 'raj@patelfamilycare.test', toEmails: [ME], at: daysAgo(6) });
    const now = new Date().toISOString();
    await db.insertInto('people').values({ id: newId('per'), owner_user_id: userId, display_name: 'Dr. Patel', notes: 'our dentist', email: 'raj@patelfamilycare.test', created_at: now, updated_at: now }).execute();
    const r = await search({ from: 'dentist' });
    expect(r.subjects).toEqual(['Your cleaning is due']);
    expect(r.people[0]).toMatchObject({ via: 'people' });
  });

  it('uses a saved contact whose organisation says so, through its name', async () => {
    await seedSyncedMail(db, userId, { subject: 'Braces check-up', fromName: 'Lisa Wong', fromEmail: 'lisa.wong@gmail.com', toEmails: [ME], at: daysAgo(3) });
    await db
      .insertInto('contacts')
      .values({ id: newId('con'), group_id: personalId, name: 'Lisa Wong', org: 'Wong Family Dental', education: null, family: null, tags: '[]', note: null, created_by: userId, created_at: new Date().toISOString() })
      .execute();
    const r = await search({ from: 'dentist' });
    expect(r.subjects).toEqual(['Braces check-up']);
    expect(r.people[0]).toMatchObject({ via: 'contacts' });
  });

  it('treats every sender that is "the school" as the school, without asking', async () => {
    await seedSyncedMail(db, userId, { subject: 'Field trip form', fromName: 'Lincoln Elementary Office', fromEmail: 'office@lincoln.test', toEmails: [ME], at: daysAgo(2) });
    await seedSyncedMail(db, userId, { subject: 'Bake sale', fromName: 'Lincoln PTA', fromEmail: 'pta@lincoln.test', toEmails: [ME], at: daysAgo(3) });
    const r = await search({ from: 'the school' });
    expect(r.subjects.sort()).toEqual(['Bake sale', 'Field trip form']);
    expect(r.people[0].status).toBe('resolved');
  });
});

describe("the phone's address book", () => {
  it('asks the phone by company and job title when the server cannot place the role, then offers to save it', async () => {
    await seedSyncedMail(db, userId, { subject: 'Appointment confirmed', fromName: 'Front Desk', fromEmail: 'hello@smilestudio.test', toEmails: [ME], at: daysAgo(5) });
    phone = (req) =>
      answerDeviceContactLookup(userId, req.requestId, {
        status: 'found',
        matches: [{ name: 'Dr. Mei Chen', emails: ['hello@smilestudio.test'], phones: [], company: 'Smile Studio Orthodontics' }],
      });
    const r = await search({ from: 'the dentist' });
    expect(lookups).toHaveLength(1);
    expect(lookups[0].role).toContain('dental');
    expect(r.subjects).toEqual(['Appointment confirmed']);
    expect(r.people[0]).toMatchObject({ via: 'phone' });
    expect(r.instruction).toMatch(/remember Dr\. Mei Chen as their dentist;/);
    expect(r.instruction).toMatch(/add_person \{ displayName: "Dr\. Mei Chen", email: "hello@smilestudio\.test", notes: "dentist" \}/);
  });

  it('finds it without the phone next time, once saved to People', async () => {
    await seedSyncedMail(db, userId, { subject: 'Appointment confirmed', fromName: 'Front Desk', fromEmail: 'hello@smilestudio.test', toEmails: [ME], at: daysAgo(5) });
    const now = new Date().toISOString();
    // What the add_person call the bot offered writes.
    await db.insertInto('people').values({ id: newId('per'), owner_user_id: userId, display_name: 'Dr. Mei Chen', notes: 'dentist', email: 'hello@smilestudio.test', created_at: now, updated_at: now }).execute();
    const r = await search({ from: 'the dentist' });
    expect(r.subjects).toEqual(['Appointment confirmed']);
    expect(r.people[0]).toMatchObject({ via: 'people' });
    expect(lookups).toEqual([]);
  });

  it('falls back to the words when no phone answers', async () => {
    const r = await search({ query: 'mail from the dentist' });
    expect(lookups).toHaveLength(1);
    expect(r.people).toEqual([]);
    expect(r.subjects).toEqual([]);
  });
});
