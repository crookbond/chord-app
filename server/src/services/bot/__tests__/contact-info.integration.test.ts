/**
 * ADR 0212 — "what is Ben's email" is answered from the asker's saved People
 * and, when that can't, from the Contacts on the asker's own phone; "Ben's
 * phone is …" is remembered on the person.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SSE, type DeviceContactLookupRequest } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  answerDeviceContactLookup,
  requestDeviceContact,
} from '@/services/bot/device-contact-lookup.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addImportantDate, createPerson, findPersonByName } from '@/services/people.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let personalId: string;
let familyId: string;
let emitted: Array<{ channel: string; event: string; data: unknown }>;

/** Stands in for the phone: answers every `contact.lookup` as `phoneAnswers` says. */
let phone: ((req: DeviceContactLookupRequest) => void) | null;

async function run(groupId: string, name: string, args: Record<string, unknown>) {
  return applyToolCall(db, {
    groupId,
    call: { name, args } as never,
    actorUserId: john,
    provenance: 'test',
    mode: 'commit',
    emit: ((channel: string, event: string, data: unknown) => {
      emitted.push({ channel, event, data });
      if (event === SSE.contactLookup && phone) {
        const req = data as DeviceContactLookupRequest;
        setTimeout(() => phone?.(req), 5);
      }
    }) as never,
  });
}

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john');
  personalId = (await ensurePersonalGroup(db, john)).id;
  familyId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: john })).id;
  emitted = [];
  phone = null;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('get_contact_info', () => {
  it("asks the asker's phone and returns only what the phone sent", async () => {
    phone = (req) =>
      answerDeviceContactLookup(john, req.requestId, {
        status: 'found',
        matches: [
          { name: 'Ben Doe', emails: ['ben@example.com'], phones: ['+1 555 010 2030'], birthday: '0000-03-14' },
        ],
      });
    const r = await run(personalId, 'get_contact_info', { name: 'Ben' });

    const lookups = emitted.filter((e) => e.event === SSE.contactLookup);
    expect(lookups).toHaveLength(1);
    // The personal chat's channel — never a shared group's.
    expect(lookups[0]!.channel).toBe(personalId);
    expect((lookups[0]!.data as DeviceContactLookupRequest).query).toBe('Ben');

    const data = r.data as { saved: unknown; device: { status: string; matches: { emails: string[] }[] } };
    expect(data.saved).toBeNull();
    expect(data.device.status).toBe('found');
    expect(data.device.matches[0]!.emails).toEqual(['ben@example.com']);
  });

  it('asks the phone first even when saved People already has the email and phone', async () => {
    await createPerson(db, { ownerUserId: john, displayName: 'Ben', email: 'old@example.com' });
    await run(personalId, 'update_person', { personName: 'Ben', phone: '555-0000' });
    phone = (req) =>
      answerDeviceContactLookup(john, req.requestId, {
        status: 'found',
        matches: [{ name: 'Ben', emails: ['ben@example.com'], phones: ['555-0102'] }],
      });
    emitted = [];

    const r = await run(personalId, 'get_contact_info', { name: 'Ben' });

    expect(emitted.filter((e) => e.event === SSE.contactLookup)).toHaveLength(1);
    expect(r.data).toMatchObject({
      device: { status: 'found', matches: [{ emails: ['ben@example.com'], phones: ['555-0102'] }] },
      saved: { email: 'old@example.com', phone: '555-0000' },
    });
    expect((r.data as { instruction: string }).instruction).toMatch(/`device`.*first/);
  });

  it('falls back to saved People when the phone does not have the contact', async () => {
    const p = await createPerson(db, { ownerUserId: john, displayName: 'Ben', email: 'ben@example.com' });
    await addImportantDate(db, { personId: p.id, kind: 'birthday', date: '2014-03-14', recurs: true });
    phone = (req) => answerDeviceContactLookup(john, req.requestId, { status: 'not_found', matches: [] });

    const r = await run(personalId, 'get_contact_info', { name: 'ben' });

    expect(r.data).toMatchObject({
      device: { status: 'not_found' },
      saved: { displayName: 'Ben', email: 'ben@example.com', birthday: '2014-03-14' },
    });
  });

  it('refuses in a shared group and never broadcasts the name there', async () => {
    const r = await run(familyId, 'get_contact_info', { name: 'Ben' });
    expect(r.data).toMatchObject({ found: false, reason: 'not_personal' });
    expect(emitted.filter((e) => e.event === SSE.contactLookup)).toHaveLength(0);
  });
});

describe('the phone round trip', () => {
  it('times out to "unavailable" when no phone answers', async () => {
    const out = await requestDeviceContact({
      emit: () => {},
      groupId: personalId,
      userId: john,
      query: 'Ben',
      timeoutMs: 20,
    });
    expect(out).toEqual({ status: 'unavailable', matches: [] });
  });

  it("refuses an answer from someone other than the asker", async () => {
    let requestId = '';
    const pending = requestDeviceContact({
      emit: ((_c: string, _e: string, d: unknown) => {
        requestId = (d as DeviceContactLookupRequest).requestId;
      }) as never,
      groupId: personalId,
      userId: john,
      query: 'Ben',
      timeoutMs: 50,
    });
    const intruder = await createUser(db, 'mallory');
    expect(
      answerDeviceContactLookup(intruder, requestId, {
        status: 'found',
        matches: [{ name: 'Ben', emails: ['evil@example.com'], phones: [] }],
      }),
    ).toBe(false);
    expect(await pending).toEqual({ status: 'unavailable', matches: [] });
    // And once settled, the id is spent.
    expect(answerDeviceContactLookup(john, requestId, { status: 'not_found', matches: [] })).toBe(false);
  });
});

describe('update_person', () => {
  it('creates the person when unknown and stores the email and phone', async () => {
    const r = await run(familyId, 'update_person', {
      personName: 'Ben',
      email: 'Ben@Example.com',
      phone: '+1 555 010 2030',
    });
    expect(r.data).toMatchObject({ created: true });
    const p = await findPersonByName(db, john, 'Ben');
    expect(p).toMatchObject({ email: 'ben@example.com', phone: '+1 555 010 2030' });
  });

  it('changes only the fields given, and an empty string clears one', async () => {
    await createPerson(db, { ownerUserId: john, displayName: 'Ben', notes: 'son', email: 'a@example.com' });
    await run(personalId, 'update_person', { personName: 'Ben', phone: '555-0102' });
    let p = await findPersonByName(db, john, 'Ben');
    expect(p).toMatchObject({ notes: 'son', email: 'a@example.com', phone: '555-0102' });

    await run(personalId, 'update_person', { personName: 'Ben', email: '' });
    p = await findPersonByName(db, john, 'Ben');
    expect(p).toMatchObject({ notes: 'son', email: null, phone: '555-0102' });
  });
});
