/**
 * Family personas (family-profile Phase 1) — the roster for the per-group
 * "About this family" surface.
 *
 * Service: backfill is idempotent, account members sort first, a managed
 * non-user is created/updated/deleted, an account-linked persona is NOT
 * deletable (it follows group membership).
 * Route: list is membership-gated, create/patch/delete resolve the persona's
 * group before acting.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { seedGroupPersonas } from '@/db/personas-seed.js';
import { createGroup, joinGroupByCode } from '@/services/groups.service.js';
import {
  createPersona,
  deletePersona,
  listPersonas,
  promotePersonToGroup,
  updatePersona,
} from '@/services/personas.service.js';
import { createPerson, addImportantDate } from '@/services/people.service.js';
import { listFamilyFacts } from '@/services/memory.service.js';
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

describe('personas.service', () => {
  let db: Kysely<DB>;
  let owner: string;
  let other: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro');
    other = await createUser(db, 'mani');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
    await addMember(db, groupId, other);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('seedGroupPersonas creates one persona per account member and is idempotent', async () => {
    await seedGroupPersonas(db);
    const first = await listPersonas(db, groupId);
    expect(first).toHaveLength(2);
    expect(first.every((p) => p.memberUserId !== null && !p.isManaged)).toBe(true);
    expect(new Set(first.map((p) => p.memberUserId))).toEqual(new Set([owner, other]));

    await seedGroupPersonas(db);
    expect(await listPersonas(db, groupId)).toHaveLength(2);
  });

  it('creates a persona for the owner on group create and for a member on join', async () => {
    // createGroup already ran in beforeEach → owner has a persona without a backfill.
    const afterCreate = await listPersonas(db, groupId);
    expect(afterCreate.some((p) => p.memberUserId === owner)).toBe(true);

    const newcomer = await createUser(db, 'priya');
    const grp = await db
      .selectFrom('groups')
      .select('invite_code')
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow();
    await joinGroupByCode(db, newcomer, grp.invite_code);
    expect((await listPersonas(db, groupId)).some((p) => p.memberUserId === newcomer)).toBe(true);
  });

  it('does not seed personas for a personal group', async () => {
    const personal = (await createGroup(db, { name: 'Mine', kind: 'personal', createdBy: owner })).id;
    await seedGroupPersonas(db);
    expect(await listPersonas(db, personal)).toHaveLength(0);
  });

  it('creates a managed non-user persona', async () => {
    const ben = await createPersona(db, {
      groupId,
      name: 'Ben',
      householdRole: 'child',
      birthdate: '2017-05-12',
      managedBy: owner,
    });
    expect(ben).toMatchObject({
      name: 'Ben',
      householdRole: 'child',
      isManaged: true,
      managedBy: owner,
      memberUserId: null,
      birthdate: '2017-05-12',
    });
  });

  it('lists account members before managed personas', async () => {
    await seedGroupPersonas(db);
    await createPersona(db, { groupId, name: 'Grandma', householdRole: 'grandparent', managedBy: owner });
    const rows = await listPersonas(db, groupId);
    expect(rows).toHaveLength(3);
    expect(rows[0].memberUserId).not.toBeNull();
    expect(rows[1].memberUserId).not.toBeNull();
    expect(rows[2].name).toBe('Grandma');
  });

  it('updates name / role / birthdate, and clears birthdate with null', async () => {
    const p = await createPersona(db, { groupId, name: 'Kiddo', householdRole: 'child', birthdate: '2015-01-01', managedBy: owner });
    const u1 = await updatePersona(db, p.id, { name: 'Aarav', householdRole: 'child' });
    expect(u1).toMatchObject({ name: 'Aarav' });
    const u2 = await updatePersona(db, p.id, { birthdate: null });
    expect(u2?.birthdate).toBeNull();
  });

  it('promotePersonToGroup creates a managed persona + copies the person\'s facts', async () => {
    const person = await createPerson(db, {
      ownerUserId: owner,
      displayName: 'Grandma Rue',
      notes: 'mom\'s mother, lives in Ohio',
      email: 'rue@example.com',
    });
    await addImportantDate(db, { personId: person.id, kind: 'birthday', date: '1950-04-02', recurs: true });

    const out = await promotePersonToGroup(db, { userId: owner, groupId, personId: person.id });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.reused).toBe(false);
    expect(out.result.facts).toBe(3); // note + email + birthday

    const persona = (await listPersonas(db, groupId)).find((p) => p.name === 'Grandma Rue')!;
    expect(persona.isManaged).toBe(true);
    expect(persona.birthdate).toBe('1950-04-02');

    const facts = (await listFamilyFacts(db, groupId, { viewerId: owner })).filter((f) => f.subjectId === persona.id);
    expect(facts.map((f) => f.key).sort()).toEqual(['birthday', 'email', 'note']);
    expect(facts.every((f) => f.provenance === `promoted:person:${person.id}`)).toBe(true);

    // A second promote reuses the persona (name match), not a duplicate.
    const again = await promotePersonToGroup(db, { userId: owner, groupId, personId: person.id });
    expect(again.ok && again.result.reused).toBe(true);
    expect((await listPersonas(db, groupId)).filter((p) => p.name === 'Grandma Rue')).toHaveLength(1);
  });

  it('promotePersonToGroup refuses a person the caller does not own', async () => {
    const theirs = await createPerson(db, { ownerUserId: other, displayName: 'Someone' });
    const out = await promotePersonToGroup(db, { userId: owner, groupId, personId: theirs.id });
    expect(out).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('deletes a managed persona but refuses an account-linked one', async () => {
    await seedGroupPersonas(db);
    const linked = (await listPersonas(db, groupId)).find((p) => p.memberUserId === owner)!;
    expect(await deletePersona(db, linked.id)).toBe('linked');

    const managed = await createPersona(db, { groupId, name: 'Nanny', householdRole: 'caregiver', managedBy: owner });
    expect(await deletePersona(db, managed.id)).toBe('deleted');
    expect(await deletePersona(db, managed.id)).toBe('not_found');
  });
});

describe('personas routes', () => {
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

  const req = (method: string, path: string, tok: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('GET personas is membership-gated', async () => {
    expect((await req('GET', API.groupPersonas(groupId), ownerTok)).status).toBe(200);
    expect((await req('GET', API.groupPersonas(groupId), strangerTok)).status).toBe(403);
  });

  it('POST creates a managed persona, PATCH edits it, DELETE removes it', async () => {
    const created = await req('POST', API.groupPersonas(groupId), ownerTok, {
      name: 'Ben',
      householdRole: 'child',
      birthdate: '2017-05-12',
    });
    expect(created.status).toBe(201);
    const persona = (await created.json()) as { id: string; isManaged: boolean };
    expect(persona.isManaged).toBe(true);

    const patched = await req('PATCH', API.persona(persona.id), ownerTok, { name: 'Aarav' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { name: string }).name).toBe('Aarav');

    // A stranger cannot touch it — the persona's group is resolved first.
    expect((await req('PATCH', API.persona(persona.id), strangerTok, { name: 'X' })).status).toBe(404);

    expect((await req('DELETE', API.persona(persona.id), ownerTok)).status).toBe(204);
    expect((await req('DELETE', API.persona(persona.id), ownerTok)).status).toBe(404);
  });

  it('DELETE on an account-linked persona is refused with 409', async () => {
    const linked = (await (await req('GET', API.groupPersonas(groupId), ownerTok)).json()) as Array<{
      id: string;
      memberUserId: string | null;
    }>;
    const mine = linked.find((p) => p.memberUserId === owner)!;
    expect((await req('DELETE', API.persona(mine.id), ownerTok)).status).toBe(409);
  });
});
