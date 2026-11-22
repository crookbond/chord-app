/**
 * `update_trip` corrects a trip's own name/destination/dates in place — the
 * gap that forced a manual SQL fix when a trip landed with the wrong year
 * (a source document with no printed year, resolved wrong). Only supplied
 * fields change; an inverted date range is rejected rather than silently
 * swapped.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { createTrip, updateTrip } from '@/services/trips.service.js';

describe('updateTrip', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let uid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john', 'John');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    groupId = g.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('corrects only the supplied fields, leaving the rest alone', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Ever Green Lodge at Vail', destination: 'Vail, CO',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });

    const updated = await updateTrip(db, trip.id, {
      name: 'Trip to Vail',
      startDate: '2027-02-11',
      endDate: '2027-02-15',
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Trip to Vail');
    expect(updated!.destination).toBe('Vail, CO'); // untouched
    expect(updated!.startDate).toBe('2027-02-11');
    expect(updated!.endDate).toBe('2027-02-15');
  });

  it('rejects an inverted date range without writing anything', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });

    await expect(updateTrip(db, trip.id, { startDate: '2027-03-01' })).rejects.toThrow();

    const unchanged = await updateTrip(db, trip.id, {}); // no-op read-through
    expect(unchanged!.startDate).toBe('2027-02-11');
  });

  it('returns null for a trip that does not exist', async () => {
    const result = await updateTrip(db, 'tr_does_not_exist', { name: 'x' });
    expect(result).toBeNull();
  });
});
