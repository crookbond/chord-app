/**
 * A two-person chat reads as the person you are talking to.
 *
 * Technically it is a group, but nobody thinks of it that way, so the chat
 * list and header label it by the other member — unless somebody deliberately
 * named it, which is what a rename means. The server decides this (it has the
 * membership) and sends `counterpartName` only when the client should prefer
 * it, so these tests are the specification of that rule.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  counterpartNames,
  createGroup,
  ensurePairGroup,
  joinGroupByCode,
  leaveGroup,
  renameGroup,
} from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('counterpartNames', () => {
  let db: Kysely<DB>;
  let me: string;
  let them: string;

  beforeEach(async () => {
    db = await openTestDb();
    me = await createUser(db, 'john', 'John Doe');
    them = await createUser(db, 'kane', 'Kane Doe');
    return async () => closeTestDb(db);
  });

  const rowFor = async (id: string) =>
    db.selectFrom('groups').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  const nameFor = async (id: string): Promise<string | undefined> => {
    const row = await rowFor(id);
    return (await counterpartNames(db, me, [row])).get(id);
  };

  it('names an un-named two-person chat after the other member', async () => {
    const pair = await ensurePairGroup(db, me, them);
    expect(await nameFor(pair.id)).toBe('Kane Doe');
  });

  it('a rename wins from then on', async () => {
    const pair = await ensurePairGroup(db, me, them);
    await renameGroup(db, pair.id, 'Karma-Doe');
    expect(await nameFor(pair.id)).toBeUndefined();
    expect((await rowFor(pair.id)).name).toBe('Karma-Doe');
  });

  it('a name typed at creation counts as deliberate too', async () => {
    const g = await createGroup(db, {
      name: 'Dinner club',
      kind: 'group',
      createdBy: me,
      nameIsCustom: true,
    });
    await joinGroupByCode(db, them, g.invite_code);
    expect(await nameFor(g.id)).toBeUndefined();
  });

  it('leaves a three-person group alone', async () => {
    const third = await createUser(db, 'ada', 'Ada Doe');
    const g = await createGroup(db, { name: 'Imported chat', kind: 'group', createdBy: me });
    await joinGroupByCode(db, them, g.invite_code);
    await joinGroupByCode(db, third, g.invite_code);
    expect(await nameFor(g.id)).toBeUndefined();
  });

  it('leaves a personal group alone - that title is the user, not a member', async () => {
    const g = await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: me });
    expect(await nameFor(g.id)).toBeUndefined();
  });

  it('is per viewer - each of the two sees the other', async () => {
    const pair = await ensurePairGroup(db, me, them);
    const row = await rowFor(pair.id);
    expect((await counterpartNames(db, me, [row])).get(pair.id)).toBe('Kane Doe');
    expect((await counterpartNames(db, them, [row])).get(pair.id)).toBe('John Doe');
  });

  it('falls back to the username when a member has no name yet', async () => {
    const nameless = await createUser(db, 'newcomer');
    const pair = await ensurePairGroup(db, me, nameless);
    expect(await nameFor(pair.id)).toBe('newcomer');
  });

  it('a group that shrinks to two KEEPS its name - it was called that on purpose', async () => {
    const third = await createUser(db, 'ada2', 'Ada Doe');
    const g = await createGroup(db, { name: 'UWS Mazaa', kind: 'group', createdBy: me });
    await joinGroupByCode(db, them, g.invite_code);
    await joinGroupByCode(db, third, g.invite_code);
    expect(await nameFor(g.id)).toBeUndefined();

    await leaveGroup(db, g.id, third);

    expect(await nameFor(g.id)).toBeUndefined();
    expect((await rowFor(g.id)).name).toBe('UWS Mazaa');
    expect((await rowFor(g.id)).name_is_custom).toBe(1);
  });

  it('a pair group that briefly had a third does NOT resurrect "Direct message"', async () => {
    const third = await createUser(db, 'ada4', 'Ada Doe');
    const pair = await ensurePairGroup(db, me, them);
    await joinGroupByCode(db, third, pair.invite_code);
    expect(await nameFor(pair.id)).toBeUndefined();

    await leaveGroup(db, pair.id, third);

    expect(await nameFor(pair.id)).toBe('Kane Doe');
  });

  it('a two-person chat losing one member is not a shrink to two', async () => {
    const pair = await ensurePairGroup(db, me, them);
    await leaveGroup(db, pair.id, them);
    expect((await rowFor(pair.id)).name_is_custom).toBe(0);
  });

  it('batches without cross-talk between groups', async () => {
    const third = await createUser(db, 'ada3', 'Ada Doe');
    const pairA = await ensurePairGroup(db, me, them);
    const pairB = await ensurePairGroup(db, me, third);
    const named = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: me,
      nameIsCustom: true,
    });
    await joinGroupByCode(db, them, named.invite_code);

    const rows = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', 'in', [pairA.id, pairB.id, named.id])
      .execute();
    const out = await counterpartNames(db, me, rows);

    expect(out.get(pairA.id)).toBe('Kane Doe');
    expect(out.get(pairB.id)).toBe('Ada Doe');
    expect(out.get(named.id)).toBeUndefined();
  });
});
