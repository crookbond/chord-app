/**
 * Family-profile Phase 1, increment 2 — subject/category columns on
 * `memories`, `GET /groups/:id/profile`, and fact edit/delete.
 *
 * The load-bearing behaviours:
 *   - the dedup/supersede key follows the subject, so a fact about persona A
 *     and a fact about persona B with the same key coexist, and the same
 *     subject + key supersedes;
 *   - a legacy caller (scope/persona_id, no subject) still works — the shim
 *     derives the subject;
 *   - `getGroupProfile` buckets confirmed facts under their persona / the
 *     household and leaves proposed ones in the pending strip.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type FamilyProfile } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { classifyLegacyMemories } from '@/db/memories-facts.js';
import { seedGroupPersonas } from '@/db/personas-seed.js';
import { createGroup } from '@/services/groups.service.js';
import {
  confirmMemory,
  listFamilyFacts,
  updateFact,
  upsertMemory,
} from '@/services/memory.service.js';
import { createPersona, listPersonas } from '@/services/personas.service.js';
import { getGroupProfile } from '@/services/family-profile.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

async function addMember(db: Kysely<DB>, groupId: string, userId: string): Promise<void> {
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'member',
      tier: 'verified',
      joined_at: new Date().toISOString(),
    })
    .execute();
}

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

describe('memory.service — subject-keyed facts', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    db = await openTestDb();
    a = await createUser(db, 'a');
    b = await createUser(db, 'b');
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: a })).id;
    await addMember(db, groupId, b);
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a legacy persona-scope write derives subject_type=user + a category', async () => {
    const m = await upsertMemory(db, {
      groupId,
      personaId: a,
      scope: 'persona',
      key: 'kid_school',
      value: 'Lincoln Elementary',
      source: 'explicit',
    });
    expect(m.subjectType).toBe('user');
    expect(m.subjectId).toBe(a);
    expect(m.category).toBe('school');
  });

  it('same subject + key supersedes; different subjects with the same key coexist', async () => {
    await upsertMemory(db, { groupId, scope: 'persona', personaId: a, key: 'shoe_size', value: '3', source: 'explicit' });
    const bumped = await upsertMemory(db, { groupId, scope: 'persona', personaId: a, key: 'shoe_size', value: '4', source: 'explicit' });
    await upsertMemory(db, { groupId, scope: 'persona', personaId: b, key: 'shoe_size', value: '9', source: 'explicit' });

    // Each private fact is its owner's; read each as its owner (ADR 0333).
    const shoeA = (await listFamilyFacts(db, groupId, { viewerId: a })).filter((f) => f.key === 'shoe_size');
    const shoeB = (await listFamilyFacts(db, groupId, { viewerId: b })).filter((f) => f.key === 'shoe_size');
    expect(shoeA.map((f) => f.value)).toEqual(['4']); // the superseded '3' is gone; b's '9' is not a's
    expect(shoeB.map((f) => f.value)).toEqual(['9']);
    expect(bumped.value).toBe('4');
  });

  it('a household fact is subject_type=household with a null subject_id', async () => {
    const h = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'home_address',
      value: '12 Oak St',
      source: 'explicit',
    });
    expect(h.subjectType).toBe('household');
    expect(h.subjectId).toBeNull();
    expect(h.category).toBe('logistics');
  });

  it('a managed persona fact keys on the persona id', async () => {
    await seedGroupPersonas(db);
    const ben = await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: a });
    const f = await upsertMemory(db, {
      groupId,
      scope: 'persona',
      key: 'allergy',
      value: 'peanuts',
      source: 'explicit',
      subjectType: 'persona',
      subjectId: ben.id,
    });
    expect(f.subjectType).toBe('persona');
    expect(f.subjectId).toBe(ben.id);
    expect(f.category).toBe('health');
  });

  it('confirming a proposed fact supersedes the prior confirmed one for the same subject', async () => {
    await upsertMemory(db, { groupId, scope: 'persona', personaId: a, key: 'grade', value: '2nd', source: 'explicit' });
    const proposed = await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: a,
      key: 'grade',
      value: '3rd',
      source: 'extracted',
      status: 'proposed',
    });
    await confirmMemory(db, proposed.id);
    const live = (await listFamilyFacts(db, groupId, { viewerId: a })).filter((f) => f.key === 'grade');
    expect(live).toHaveLength(1);
    expect(live[0].value).toBe('3rd');
  });

  it('classifyLegacyMemories backfills subject + category on rows missing them', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('memories')
      .values({
        id: newId('mem'),
        group_id: groupId,
        persona_id: a,
        scope: 'persona',
        key: 'allergy',
        value: 'shellfish',
        source: 'explicit',
        confidence: 0.9,
        status: 'confirmed',
        superseded_by: null,
        created_at: now,
        subject_type: null,
        subject_id: null,
        category: null,
        provenance: null,
        dated_at: null,
      })
      .execute();
    await classifyLegacyMemories(db);
    const [row] = await listFamilyFacts(db, groupId, { viewerId: a });
    expect(row.subjectType).toBe('user');
    expect(row.subjectId).toBe(a);
    expect(row.category).toBe('health');
  });

  it('updateFact edits value / category', async () => {
    const f = await upsertMemory(db, { groupId, scope: 'group', key: 'wifi', value: 'old', source: 'explicit' });
    const u = await updateFact(db, f.id, { value: 'new-pass', category: 'logistics' });
    expect(u).toMatchObject({ value: 'new-pass', category: 'logistics' });
  });
});

describe('getGroupProfile', () => {
  let db: Kysely<DB>;
  let owner: string;
  let spouse: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro');
    spouse = await createUser(db, 'mani');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
    await addMember(db, groupId, spouse);
    await seedGroupPersonas(db);
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('buckets facts under their subject, collects household facts, and holds proposed in pending', async () => {
    const ben = await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: owner });

    await upsertMemory(db, { groupId, scope: 'persona', personaId: owner, key: 'office', value: '200 Park Ave', source: 'explicit' });
    await upsertMemory(db, { groupId, scope: 'group', key: 'allergy', value: 'peanuts', source: 'explicit', subjectType: 'persona', subjectId: ben.id });
    await upsertMemory(db, { groupId, scope: 'group', key: 'home_address', value: '12 Oak St', source: 'explicit' });
    await upsertMemory(db, { groupId, scope: 'persona', personaId: spouse, key: 'shoe_size', value: '7', source: 'extracted', status: 'proposed' });

    const profile: FamilyProfile = await getGroupProfile(db, groupId, owner);

    const personas = await listPersonas(db, groupId);
    expect(profile.personas).toHaveLength(personas.length); // 2 members + Ben

    const ownerCard = profile.personas.find((p) => p.memberUserId === owner)!;
    expect(ownerCard.facts.map((f) => f.key)).toContain('office');

    const benCard = profile.personas.find((p) => p.id === ben.id)!;
    expect(benCard.facts.map((f) => f.key)).toContain('allergy');

    expect(profile.household.map((f) => f.key)).toEqual(['home_address']);

    // ADR 0333 — the spouse's private (proposed) shoe_size is the spouse's:
    // the owner sees it neither on the card nor in the pending strip.
    const spouseCard = profile.personas.find((p) => p.memberUserId === spouse)!;
    expect(spouseCard.facts.map((f) => f.key)).not.toContain('shoe_size');
    expect(profile.pending.some((p) => p.kind === 'fact' && p.detail === '7')).toBe(false);

    // The spouse sees their own pending fact, and not the owner's private one.
    const asSpouse = await getGroupProfile(db, groupId, spouse);
    expect(asSpouse.pending.some((p) => p.kind === 'fact' && p.detail === '7')).toBe(true);
    const ownerCardForSpouse = asSpouse.personas.find((p) => p.memberUserId === owner)!;
    expect(ownerCardForSpouse.facts.map((f) => f.key)).not.toContain('office');
    // Shared facts are everyone's.
    expect(asSpouse.household.map((f) => f.key)).toEqual(['home_address']);
    expect(asSpouse.personas.find((p) => p.id === ben.id)!.facts.map((f) => f.key)).toContain('allergy');
  });
});

describe('family-profile routes', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let owner: string;
  let stranger: string;
  let ownerTok: string;
  let strangerTok: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    owner = await createUser(db, 'ro');
    stranger = await createUser(db, 'nemo');
    ownerTok = await mintToken(db, owner);
    strangerTok = await mintToken(db, stranger);
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner })).id;
    await seedGroupPersonas(db);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const send = (method: string, path: string, tok: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('GET /groups/:id/profile is membership-gated and returns the shape', async () => {
    expect((await send('GET', API.groupProfile(groupId), strangerTok)).status).toBe(403);
    const res = await send('GET', API.groupProfile(groupId), ownerTok);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FamilyProfile;
    expect(Array.isArray(body.personas)).toBe(true);
    expect(Array.isArray(body.household)).toBe(true);
    expect(Array.isArray(body.pending)).toBe(true);
  });

  it('POST /groups/:id/facts creates a confirmed fact for a subject', async () => {
    const bad = await send('POST', `/api/v1/groups/${groupId}/facts`, ownerTok, {
      subjectType: 'user',
      key: 'x',
      value: 'y',
    });
    expect(bad.status).toBe(400); // subjectId required unless household

    const ok = await send('POST', `/api/v1/groups/${groupId}/facts`, ownerTok, {
      subjectType: 'user',
      subjectId: owner,
      key: 'shoe_size',
      value: '10',
    });
    expect(ok.status).toBe(201);
    const fact = (await ok.json()) as { status: string; category: string; subjectId: string };
    expect(fact).toMatchObject({ status: 'confirmed', category: 'sizes', subjectId: owner });

    const hh = await send('POST', `/api/v1/groups/${groupId}/facts`, ownerTok, {
      subjectType: 'household',
      key: 'home_address',
      value: '12 Oak St',
    });
    expect(hh.status).toBe(201);

    const stranger = await send('POST', `/api/v1/groups/${groupId}/facts`, strangerTok, {
      subjectType: 'household',
      key: 'x',
      value: 'y',
    });
    expect(stranger.status).toBe(403);
  });

  it('PATCH/DELETE /facts/:id resolves the fact group and gates on membership', async () => {
    const fact = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'wifi',
      value: 'old',
      source: 'explicit',
    });
    expect((await send('PATCH', API.fact(fact.id), strangerTok, { value: 'x' })).status).toBe(404);
    const patched = await send('PATCH', API.fact(fact.id), ownerTok, { value: 'new' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { value: string }).value).toBe('new');
    expect((await send('DELETE', API.fact(fact.id), ownerTok)).status).toBe(204);
    expect((await send('DELETE', API.fact(fact.id), ownerTok)).status).toBe(404);
  });
});
