/**
 * ADR 0153 — `enrichExternalActionQuery` fills blank fields on a
 * `suggest_external_action` query from what the harness knows about this
 * family: the roster size, the household airport, the live trip, a saved
 * place. It never overrides a field the model supplied, and it is
 * best-effort.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { enrichExternalActionQuery } from '@/services/bot/external-actions-enrich.js';
import { createGroup } from '@/services/groups.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import { createPersona } from '@/services/personas.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { createTrip } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => ymd(new Date(Date.now() + n * 86_400_000));

describe('enrichExternalActionQuery (ADR 0153)', () => {
  let db: Kysely<DB>;
  let owner: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const enrich = (kind: Parameters<typeof enrichExternalActionQuery>[2], query = {}) =>
    enrichExternalActionQuery(db, { groupId, userId: owner }, kind, query);

  describe('partySize ← the roster count', () => {
    it('fills partySize from the number of personas in the group', async () => {
      await createPersona(db, { groupId, name: 'Priya', householdRole: 'parent', managedBy: owner });
      await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: owner });
      // createGroup already seeded one persona for the owner → 3 total.
      const q = await enrich('restaurant', {});
      expect(q.partySize).toBe(3);
    });

    it('does not fill when the roster is under two', async () => {
      const q = await enrich('restaurant', {}); // only the owner's seeded persona
      expect(q.partySize).toBeUndefined();
    });

    it('never overrides a partySize the model supplied', async () => {
      await createPersona(db, { groupId, name: 'Priya', householdRole: 'parent', managedBy: owner });
      await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: owner });
      const q = await enrich('restaurant', { partySize: 2 });
      expect(q.partySize).toBe(2);
    });

    it('is not applied to a flight', async () => {
      await createPersona(db, { groupId, name: 'Priya', householdRole: 'parent', managedBy: owner });
      await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: owner });
      const q = await enrich('flight', {});
      expect(q.partySize).toBeUndefined();
    });
  });

  describe('origin ← a home_airport fact', () => {
    it('fills a flight origin from a household home_airport fact', async () => {
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        key: 'home_airport',
        value: 'BOS',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'household',
        subjectId: null,
      });
      const q = await enrich('flight', {});
      expect(q.origin).toBe('BOS');
    });

    it("falls back to the asker's own home_airport when there is no household one", async () => {
      await upsertMemory(db, {
        groupId,
        scope: 'persona',
        personaId: owner,
        key: 'home_airport',
        value: 'JFK',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'user',
        subjectId: owner,
      });
      const q = await enrich('flight', {});
      expect(q.origin).toBe('JFK');
    });

    it('prefers the household fact over the personal one', async () => {
      await upsertMemory(db, {
        groupId,
        scope: 'persona',
        personaId: owner,
        key: 'home_airport',
        value: 'JFK',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'user',
        subjectId: owner,
      });
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        key: 'home_airport',
        value: 'BOS',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'household',
        subjectId: null,
      });
      const q = await enrich('flight', {});
      expect(q.origin).toBe('BOS');
    });

    it('never overrides an origin the model supplied', async () => {
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        key: 'home_airport',
        value: 'BOS',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'household',
        subjectId: null,
      });
      const q = await enrich('flight', { origin: 'ORD' });
      expect(q.origin).toBe('ORD');
    });
  });

  describe('map destination ← the household address', () => {
    beforeEach(async () => {
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        key: 'home_address',
        value: '12 Maple St, Boston',
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'household',
        subjectId: null,
      });
    });

    it('fills a blank map term from home_address', async () => {
      const q = await enrich('map', {});
      expect(q.q).toBe('12 Maple St, Boston');
    });

    it('fills a "home" reference from home_address', async () => {
      expect((await enrich('map', { q: 'home' })).q).toBe('12 Maple St, Boston');
      expect((await enrich('map', { q: 'our house' })).q).toBe('12 Maple St, Boston');
    });

    it('leaves a real place term alone', async () => {
      const q = await enrich('map', { q: 'the school' });
      expect(q.q).toBe('the school');
    });

    it('does not touch a non-map kind', async () => {
      const q = await enrich('restaurant', {});
      expect(q.q).toBeUndefined();
    });
  });

  describe('the soonest open trip', () => {
    beforeEach(async () => {
      await createTrip(db, {
        groupId,
        createdBy: owner,
        name: 'Old trip',
        destination: 'Rome',
        startDate: daysFromNow(-30),
        endDate: daysFromNow(-20),
        participantIds: [],
      });
      await createTrip(db, {
        groupId,
        createdBy: owner,
        name: 'Lisbon',
        destination: 'Lisbon',
        startDate: daysFromNow(20),
        endDate: daysFromNow(27),
        participantIds: [],
      });
    });

    it('fills a flight destination + both dates from the trip, ignoring the past one', async () => {
      const q = await enrich('flight', {});
      expect(q.destination).toBe('Lisbon');
      expect(q.departDate).toBe(daysFromNow(20));
      expect(q.returnDate).toBe(daysFromNow(27));
    });

    it('fills a restaurant city from the trip destination', async () => {
      const q = await enrich('restaurant', { restaurantName: 'somewhere nice' });
      expect(q.city).toBe('Lisbon');
    });

    it('does not touch a flight destination the model supplied', async () => {
      const q = await enrich('flight', { destination: 'Tokyo' });
      expect(q.destination).toBe('Tokyo');
      // dates still fill from the trip — they were blank
      expect(q.departDate).toBe(daysFromNow(20));
    });
  });

  describe('restaurantName ← a saved place', () => {
    beforeEach(async () => {
      await createSaveWithDedup(db, {
        groupId,
        createdBy: owner,
        kind: 'place',
        title: 'Nakazawa',
        tags: [],
      });
    });

    it('canonicalises a loose reference to the saved place name on a single match', async () => {
      const q = await enrich('restaurant', { restaurantName: 'nakazawa' });
      expect(q.restaurantName).toBe('Nakazawa');
    });

    it('leaves the name alone when nothing matches', async () => {
      const q = await enrich('restaurant', { restaurantName: 'Carbone' });
      expect(q.restaurantName).toBe('Carbone');
    });

    it('leaves the name alone when more than one saved place matches', async () => {
      await createSaveWithDedup(db, {
        groupId,
        createdBy: owner,
        kind: 'place',
        title: 'Nakazawa Uptown',
        tags: [],
      });
      const q = await enrich('restaurant', { restaurantName: 'nakazawa' });
      expect(q.restaurantName).toBe('nakazawa');
    });
  });

  it('returns the query untouched for a group it has nothing on', async () => {
    const bare = (await createGroup(db, { name: 'Empty', kind: 'group', createdBy: owner })).id;
    const q = await enrichExternalActionQuery(
      db,
      { groupId: bare, userId: owner },
      'flight',
      { destination: 'Oslo' },
    );
    expect(q).toEqual({ destination: 'Oslo' });
  });
});
