/**
 * ADR 0158/0159 — "nothing past ever surfaces" extended to `create_task` and
 * trip bundles, mirroring `retractPastEventProposals` (ADR 0137).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  retractPastTaskProposals,
  retractPastTripProposals,
} from '@/services/event-convergence.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

describe('retractPastTaskProposals', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'stale-task-user');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Personal',
        kind: 'personal',
        invite_code: newId('inv'),
        ingest_email: `${groupId}@chord.app`,
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const stageTask = async (title: string, dueAt?: string) =>
    (
      await createProposal(db, {
        groupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'create_task',
        args: { title, ...(dueAt ? { dueAt } : {}) },
        provenance: `gmail:${newId('t')}`,
      })
    ).id;

  it('retracts a task proposal whose dueAt has already passed', async () => {
    const id = await stageTask('Confirm attendance', `${isoDay(-6)}T23:59:59-04:00`);
    expect(await retractPastTaskProposals(db, userId, '-04:00')).toBe(1);
    const row = await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
  });

  it('leaves a future-dated task alone', async () => {
    const id = await stageTask('Renew passport', `${isoDay(6)}T23:59:59-04:00`);
    expect(await retractPastTaskProposals(db, userId, '-04:00')).toBe(0);
    const row = await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });

  it('never touches an undated task', async () => {
    const id = await stageTask('Renew passport');
    expect(await retractPastTaskProposals(db, userId, '-04:00')).toBe(0);
    const row = await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });
});

describe('retractPastTripProposals', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'stale-trip-user');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Personal',
        kind: 'personal',
        invite_code: newId('inv'),
        ingest_email: `${groupId}@chord.app`,
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const stage = async (
    toolName: string,
    args: Record<string, unknown>,
    bundleId?: string,
  ): Promise<string> =>
    (
      await createProposal(db, {
        groupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName,
        args,
        provenance: `gmail:${newId('t')}`,
        bundleId,
      })
    ).id;

  const statusOf = async (id: string) =>
    (await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow())
      .status;

  it('retracts the whole bundle when every leg is past', async () => {
    const bundle = newId('bundle');
    const trip = await stage('create_trip', { name: 'Old trip', destination: 'DEN' }, bundle);
    const leg = await stage(
      'add_travel_leg',
      { origin: 'JFK', destination: 'DEN', departAt: `${isoDay(-10)}T08:00:00-04:00`, arriveAt: `${isoDay(-10)}T10:00:00-06:00` },
      bundle,
    );
    expect(await retractPastTripProposals(db, userId, '-04:00')).toBe(2);
    expect(await statusOf(trip)).toBe('expired');
    expect(await statusOf(leg)).toBe('expired');
  });

  it('keeps the bundle but drops only the stale leg of a straddling itinerary', async () => {
    const bundle = newId('bundle');
    const trip = await stage('create_trip', { name: 'Europe', destination: 'LIS' }, bundle);
    const flown = await stage(
      'add_travel_leg',
      { origin: 'JFK', destination: 'LIS', departAt: `${isoDay(-3)}T20:00:00-04:00`, arriveAt: `${isoDay(-2)}T08:00:00+01:00` },
      bundle,
    );
    const ahead = await stage(
      'add_travel_leg',
      { origin: 'LIS', destination: 'JFK', departAt: `${isoDay(4)}T11:00:00+01:00`, arriveAt: `${isoDay(4)}T14:00:00-04:00` },
      bundle,
    );
    expect(await retractPastTripProposals(db, userId, '-04:00')).toBe(1);
    expect(await statusOf(trip)).toBe('pending');
    expect(await statusOf(flown)).toBe('expired');
    expect(await statusOf(ahead)).toBe('pending');
  });

  it('retracts an accommodation bundle once checkout has passed', async () => {
    const bundle = newId('bundle');
    const trip = await stage('create_trip', { name: 'Old stay', destination: 'Rome' }, bundle);
    const accom = await stage(
      'add_accommodation',
      { propertyName: 'Hotel Roma', checkinDate: isoDay(-10), checkoutDate: isoDay(-7) },
      bundle,
    );
    expect(await retractPastTripProposals(db, userId, '-04:00')).toBe(2);
    expect(await statusOf(trip)).toBe('expired');
    expect(await statusOf(accom)).toBe('expired');
  });

  it('leaves a future bundle untouched', async () => {
    const bundle = newId('bundle');
    const trip = await stage('create_trip', { name: 'Denver', destination: 'DEN' }, bundle);
    const leg = await stage(
      'add_travel_leg',
      { origin: 'JFK', destination: 'DEN', departAt: `${isoDay(30)}T08:00:00-04:00`, arriveAt: `${isoDay(30)}T10:00:00-06:00` },
      bundle,
    );
    expect(await retractPastTripProposals(db, userId, '-04:00')).toBe(0);
    expect(await statusOf(trip)).toBe('pending');
    expect(await statusOf(leg)).toBe('pending');
  });
});
