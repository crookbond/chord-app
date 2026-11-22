/**
 * ADR 0247 — one suggestion sent to several groups at once from the Action
 * Items card ("share this trip with Alice and with Ben, separately"). Each
 * picked group gets its own copy and its own fan-out; the confirmer's own
 * calendar does not get the event once per group.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (n: number, hh: string): string => `${day(n)}T${hh}:00.000Z`;

describe('confirming a suggestion into several groups (ADR 0247)', () => {
  let db: Kysely<DB>;
  let john: string;
  let alice: string;
  let ben: string;
  let personalId: string;
  let withAlice: string;
  let withBen: string;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    alice = await createUser(db, 'alice', 'Alice Stone');
    ben = await createUser(db, 'ben', 'Ben Doe');
    personalId = (await ensurePersonalGroup(db, john)).id;
    withAlice = (await createGroup(db, { name: 'Alice', kind: 'group', createdBy: john })).id;
    await addMember(db, withAlice, alice);
    withBen = (await createGroup(db, { name: 'Ben', kind: 'group', createdBy: john })).id;
    await addMember(db, withBen, ben);
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const stage = (toolName: string, args: unknown, bundleId?: string) =>
    createProposal(db, {
      groupId: personalId,
      proposedByUserId: john,
      proposedByMessageId: null,
      toolName,
      args,
      provenance: 'gmail:thread1',
      bundleId,
    });

  it('a to-do lands once in each picked group', async () => {
    const p = await stage('create_task', { title: 'Book airport pickup' });
    const res = await confirmProposal(db, {
      id: p.id,
      resolvedByUserId: john,
      targetGroupIds: [withAlice, withBen],
    });
    expect(res.ok).toBe(true);
    const tasks = await db.selectFrom('tasks').select(['group_id', 'title']).execute();
    expect(tasks.map((t) => t.group_id).sort()).toEqual([withAlice, withBen].sort());
    // Several groups teach no standing rule.
    expect(res.ok && res.routeSuggestion).toBeFalsy();
  });

  it('an event fans out in each group, and the confirmer gets ONE copy', async () => {
    const p = await stage('create_event', { title: 'Dinner at Nobu', startsAt: at(10, '23:00') });
    const res = await confirmProposal(db, {
      id: p.id,
      resolvedByUserId: john,
      targetGroupIds: [withAlice, withBen],
    });
    expect(res.ok).toBe(true);
    const rows = await db
      .selectFrom('events')
      .select(['group_id', 'owner_user_id'])
      .where('title', '=', 'Dinner at Nobu')
      .execute();
    const owners = (g: string) => rows.filter((r) => r.group_id === g).map((r) => r.owner_user_id).sort();
    expect(owners(withAlice)).toEqual([alice, john].sort());
    expect(owners(withBen)).toEqual([ben]);
    expect(rows.filter((r) => r.owner_user_id === john)).toHaveLength(1);
  });

  it('a trip bundle becomes one trip per picked group, each with its leg', async () => {
    const bundleId = 'b_multi';
    const lead = await stage(
      'create_trip',
      { name: 'Denver', destination: 'DEN', startDate: day(20), endDate: day(25) },
      bundleId,
    );
    await stage(
      'add_travel_leg',
      {
        personaName: 'John',
        origin: 'JFK',
        destination: 'DEN',
        departAt: at(20, '14:00'),
        arriveAt: at(20, '18:00'),
        carrier: 'UA',
        flightNo: '512',
      },
      bundleId,
    );
    const res = await confirmProposal(db, {
      id: lead.id,
      resolvedByUserId: john,
      targetGroupIds: [withAlice, withBen],
    });
    expect(res.ok).toBe(true);
    const trips = await db.selectFrom('trips').select(['id', 'group_id']).execute();
    expect(trips.map((t) => t.group_id).sort()).toEqual([withAlice, withBen].sort());
    for (const t of trips) {
      const legs = await db.selectFrom('travel_legs').select('id').where('trip_id', '=', t.id).execute();
      expect(legs).toHaveLength(1);
    }
    const pending = await db.selectFrom('proposals').select('id').where('status', '=', 'pending').execute();
    expect(pending).toHaveLength(0);
  });

  it('a group the confirmer is not in refuses the whole confirm', async () => {
    const strangers = (await createGroup(db, { name: 'Strangers', kind: 'group', createdBy: ben })).id;
    const p = await stage('create_task', { title: 'Book airport pickup' });
    const res = await confirmProposal(db, {
      id: p.id,
      resolvedByUserId: john,
      targetGroupIds: [withAlice, strangers],
    });
    expect(res.ok).toBe(false);
    expect(await db.selectFrom('tasks').select('id').execute()).toHaveLength(0);
  });

  it('one picked group still behaves like the single-group confirm', async () => {
    const p = await stage('create_task', { title: 'Book airport pickup' });
    const res = await confirmProposal(db, { id: p.id, resolvedByUserId: john, targetGroupIds: [withBen] });
    expect(res.ok).toBe(true);
    const tasks = await db.selectFrom('tasks').select('group_id').execute();
    expect(tasks.map((t) => t.group_id)).toEqual([withBen]);
  });
});
