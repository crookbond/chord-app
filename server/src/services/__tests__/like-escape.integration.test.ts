/**
 * Title matching put the model's text into a LIKE pattern unescaped, so a
 * titleContains of "%" or "_" matched every task and event in the group: a
 * complete_task / delete_event / update_event aimed at one row found them all.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createEvent, findEventsByTitle } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createTask, findTasksByTitle } from '@/services/tasks.service.js';
import { likeContains } from '@/utils/like.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('likeContains', () => {
  it('escapes the LIKE wildcards and the escape character', () => {
    expect(likeContains('50% off_now\\')).toBe('%50\\% off\\_now\\\\%');
  });
});

describe('title matching with wildcard characters', () => {
  let db: Kysely<DB>;
  let uid: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john');
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a "%" title matches no task, not every task', async () => {
    await createTask(db, { groupId, createdBy: uid, title: 'Renew passport' });
    await createTask(db, { groupId, createdBy: uid, title: 'Pay water bill' });
    expect(await findTasksByTitle(db, { groupId }, '%', ['open'])).toEqual([]);
    expect(await findTasksByTitle(db, { groupId }, '_', ['open'])).toEqual([]);
  });

  it('a "%" title still finds a task that really says "%"', async () => {
    const t = await createTask(db, { groupId, createdBy: uid, title: 'Use the 20% coupon' });
    await createTask(db, { groupId, createdBy: uid, title: 'Pay water bill' });
    expect((await findTasksByTitle(db, { groupId }, '20%', ['open'])).map((r) => r.id)).toEqual([t.id]);
  });

  it('a "%" title matches no event, not every event', async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await createEvent(db, { groupId, createdBy: uid, title: 'Dentist', startsAt: soon });
    await createEvent(db, { groupId, createdBy: uid, title: 'Soccer practice', startsAt: soon });
    expect(await findEventsByTitle(db, { groupId }, '%')).toEqual([]);
  });
});
