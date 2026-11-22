/**
 * ADR 0333 — a private fact (`scope = 'persona'`) reaches only its owner, on
 * every surface: the fact lists, the family profile, its edit routes, the
 * live event, and the form filler. Before this, `GET /me/memories` and
 * `GET /groups/:id/memories` returned every member's private facts, any
 * member could confirm/reject/edit/delete them, and a fact could be added
 * about a person from another chat.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type FamilyProfile, type Memory } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { seedGroupPersonas } from '@/db/personas-seed.js';
import { gatherKnowledge } from '@/services/forms.service.js';
import { createGroup } from '@/services/groups.service.js';
import { factEventChannel } from '@/services/memory-notices.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import { createPerson, learnedFactsForPeople } from '@/services/people.service.js';
import { createPersona } from '@/services/personas.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let john: string;
let alice: string;
let johnTok: string;
let aliceTok: string;
let groupId: string;

async function addMember(userId: string, gid = groupId): Promise<void> {
  await db
    .insertInto('group_members')
    .values({ group_id: gid, user_id: userId, role: 'member', tier: 'verified', joined_at: new Date().toISOString() })
    .execute();
}

async function mintToken(userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

const send = (method: string, path: string, tok: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** John's own private Global Entry number. */
const johnsPrivate = (status: 'confirmed' | 'proposed' = 'confirmed') =>
  upsertMemory(db, {
    groupId,
    scope: 'persona',
    personaId: john,
    subjectType: 'user',
    subjectId: john,
    key: 'global_entry_number',
    value: '154800334',
    source: 'explicit',
    status,
  });

beforeEach(async () => {
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  john = await createUser(db, 'john', 'John Doe');
  alice = await createUser(db, 'alice', 'Alice Doe');
  johnTok = await mintToken(john);
  aliceTok = await mintToken(alice);
  groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john })).id;
  await addMember(alice);
  await seedGroupPersonas(db);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('fact lists show a private fact to its owner only', () => {
  it('GET /me/memories and GET /groups/:id/memories', async () => {
    await johnsPrivate();
    for (const path of [API.meMemories, `/api/v1/groups/${groupId}/memories`]) {
      const asAlice = (await (await send('GET', path, aliceTok)).json()) as Memory[];
      expect(asAlice.map((m) => m.value)).not.toContain('154800334');
      const asJohn = (await (await send('GET', path, johnTok)).json()) as Memory[];
      const mine = asJohn.find((m) => m.value === '154800334');
      expect(mine?.about).toBe('John Doe');
    }
  });

  it('another member cannot confirm or reject it', async () => {
    const proposed = await johnsPrivate('proposed');
    expect((await send('POST', `/api/v1/memories/${proposed.id}/confirm`, aliceTok)).status).toBe(404);
    expect((await send('POST', `/api/v1/memories/${proposed.id}/reject`, aliceTok)).status).toBe(404);
    expect((await send('POST', `/api/v1/memories/${proposed.id}/confirm`, johnTok)).status).toBe(200);
  });
});

describe('family profile', () => {
  it("does not show or let another member edit or delete someone's private fact", async () => {
    const fact = await johnsPrivate();
    const profile = (await (await send('GET', API.groupProfile(groupId), aliceTok)).json()) as FamilyProfile;
    const values = profile.personas.flatMap((p) => p.facts.map((f) => f.value));
    expect(values).not.toContain('154800334');

    expect((await send('PATCH', API.fact(fact.id), aliceTok, { value: '999' })).status).toBe(404);
    expect((await send('DELETE', API.fact(fact.id), aliceTok)).status).toBe(404);
    expect((await send('PATCH', API.fact(fact.id), johnTok, { value: '154800335' })).status).toBe(200);
  });

  it('will not add a fact about a person from another chat', async () => {
    const otherGroup = (await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice })).id;
    const elsewhere = await createPersona(db, { groupId: otherGroup, name: 'Ben', householdRole: 'child', managedBy: alice });
    const stranger = await createUser(db, 'nemo');

    const res = await send('POST', `/api/v1/groups/${groupId}/facts`, johnTok, {
      subjectType: 'persona',
      subjectId: elsewhere.id,
      key: 'global_entry_number',
      value: '155605322',
    });
    expect(res.status).toBe(400);
    const res2 = await send('POST', `/api/v1/groups/${groupId}/facts`, johnTok, {
      subjectType: 'user',
      subjectId: stranger,
      key: 'global_entry_number',
      value: '155605322',
    });
    expect(res2.status).toBe(400);
  });

  it("a fact typed about another member stays the typist's private fact, filed under that member", async () => {
    const res = await send('POST', `/api/v1/groups/${groupId}/facts`, johnTok, {
      subjectType: 'user',
      subjectId: alice,
      key: 'shoe_size',
      value: '7',
    });
    expect(res.status).toBe(201);
    const fact = (await res.json()) as Memory;
    expect(fact).toMatchObject({ subjectType: 'user', subjectId: alice, personaId: john, scope: 'persona' });
  });
});

describe('live events', () => {
  it("a private fact's event goes to its owner's channel, a shared one to the chat", () => {
    expect(factEventChannel({ groupId, scope: 'persona', personaId: john })).toBe(`user:${john}`);
    expect(factEventChannel({ groupId, scope: 'group', personaId: null })).toBe(groupId);
  });
});

describe('form filling', () => {
  it("names who each fact is about, marks the form's own person, and leaves out other members' private facts", async () => {
    const ben = await createPerson(db, { ownerUserId: john, displayName: 'Ben Doe' });
    const nolan = await createPerson(db, { ownerUserId: john, displayName: 'Nolan Doe' });
    for (const [p, v] of [
      [nolan.id, '154800334'],
      [ben.id, '155605322'],
    ] as const) {
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        subjectType: 'person',
        subjectId: p,
        key: 'global_entry_number',
        value: v,
        source: 'explicit',
        status: 'confirmed',
      });
    }
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: alice,
      subjectType: 'user',
      subjectId: alice,
      key: 'passport_number',
      value: 'X999',
      source: 'explicit',
      status: 'confirmed',
    });

    const k = await gatherKnowledge(db, { userId: john, groupId, subjectPersonId: ben.id });
    expect(k.facts).toContainEqual({ about: 'Ben Doe', key: 'global_entry_number', value: '155605322', formSubject: true });
    expect(k.facts).toContainEqual({ about: 'Nolan Doe', key: 'global_entry_number', value: '154800334', formSubject: false });
    expect(k.facts.map((f) => f.value)).not.toContain('X999');
  });
});

describe('People screen', () => {
  it('shows a fact under the person it is about, not under a name found in its value', async () => {
    const mayaLin = await createPerson(db, { ownerUserId: john, displayName: 'Maya Lin' });
    const ben = await createPerson(db, { ownerUserId: john, displayName: 'Ben Doe' });
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: john,
      key: 'kid_name',
      value: 'Maya Doe',
      source: 'explicit',
      status: 'confirmed',
    });
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      subjectType: 'person',
      subjectId: ben.id,
      key: 'global_entry_number',
      value: '155605322',
      source: 'explicit',
      status: 'confirmed',
    });

    const learned = await learnedFactsForPeople(db, john, [mayaLin, ben]);
    expect(learned.get(mayaLin.id)).toBeUndefined();
    expect(learned.get(ben.id)).toEqual([{ key: 'global_entry_number', value: '155605322' }]);
  });
});
