/**
 * The client reports its timezone with every message post. An unchanged zone
 * used to cost a `users` read each time (plus a zone-validity check), on the
 * highest-volume route: 5,600 reads in 75 s at 500 users.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { recordUserTimezone } from '@/services/proactive.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function countUserReads(db: Kysely<DB>): { db: Kysely<DB>; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'selectFrom') {
        return (table: string) => {
          if (table === 'users') n += 1;
          return (target.selectFrom as (t: string) => unknown).call(target, table);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kysely<DB>;
  return { db: proxy, reads: () => n };
}

describe('recordUserTimezone on the message hot path', () => {
  let db: Kysely<DB>;
  let uid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'poster');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('costs nothing once the zone is known, however many times it is reported again', async () => {
    const counted = countUserReads(db);
    // The first report reads, stores, and re-times the briefing.
    expect(await recordUserTimezone(counted.db, uid, 'America/New_York')).toBe(true);
    const afterFirst = counted.reads();
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      expect(await recordUserTimezone(counted.db, uid, 'America/New_York')).toBe(false);
    }
    expect(counted.reads()).toBe(afterFirst);
  });

  it('still notices a real change, and stores it', async () => {
    await recordUserTimezone(db, uid, 'America/New_York');
    expect(await recordUserTimezone(db, uid, 'Africa/Nairobi')).toBe(true);
    const row = await db.selectFrom('users').select('last_tz').where('id', '=', uid).executeTakeFirstOrThrow();
    expect(row.last_tz).toBe('Africa/Nairobi');
    // ...and going back is a change too, not something the cache swallows.
    expect(await recordUserTimezone(db, uid, 'America/New_York')).toBe(true);
  });

  it('a junk zone is rejected and does not poison later valid ones', async () => {
    expect(await recordUserTimezone(db, uid, 'Not/AZone')).toBe(false);
    expect(await recordUserTimezone(db, uid, 'Europe/Madrid')).toBe(true);
  });

  it('an unknown user is not remembered as confirmed', async () => {
    expect(await recordUserTimezone(db, 'u_missing', 'Europe/Madrid')).toBe(false);
    expect(await recordUserTimezone(db, 'u_missing', 'Europe/Madrid')).toBe(false);
  });
});
