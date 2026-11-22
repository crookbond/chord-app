/**
 * A school calendar uploaded twice in chat filed every all-day entry twice:
 * the calendar auto-filer passes no `externalUid`, and createEvent's
 * same-event merge (ADR 0223) skips all-day events, so nothing matched the
 * first upload's rows. A second upload must only add what is new.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { createGroup } from '@/services/groups.service.js';
import { classifyAndAutoFileAttachment } from '@/services/bot/trip_classifier.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

let reply = '';
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'calendar-mock',
    defaultModel: 'calendar-mock',
    supportsNativeTools: false,
    complete: async () => reply,
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('not used'); },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

let db: Kysely<DB>;
beforeEach(async () => { db = await openTestDb(); });
afterEach(async () => { await closeTestDb(db); });

const nextYear = new Date().getUTCFullYear() + 1;

function calendarReply(events: { title: string; startsAt: string }[]): string {
  return JSON.stringify({ kind: 'calendar', events });
}

async function seed() {
  const userId = newId('u');
  await db.insertInto('users').values({
    id: userId,
    username: 'parent',
    display_name: 'Parent',
    created_at: new Date().toISOString(),
    shadow: 0,
  }).execute();
  const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
  return { userId, groupId: group.id };
}

async function upload(userId: string, groupId: string) {
  return classifyAndAutoFileAttachment(db, {
    attachmentId: newId('a'),
    groupId,
    uploadedBy: userId,
    filename: 'LakesideCalendar2026.pdf',
    extractedText: 'Lakeside School 2026-27 calendar. Picture Day, Thanksgiving Break (no school), Spring Concert.',
    uploaderTz: 'America/New_York',
  });
}

async function eventsNamed(groupId: string, title: string) {
  return db.selectFrom('events').select(['id', 'starts_at', 'owner_user_id'])
    .where('group_id', '=', groupId).where('title', '=', title).execute();
}

describe('calendar file uploaded twice', () => {
  it('does not file its all-day entries a second time', async () => {
    const { userId, groupId } = await seed();
    reply = calendarReply([
      { title: 'Thanksgiving Break - No School', startsAt: `${nextYear}-11-26` },
      { title: 'Picture Day', startsAt: `${nextYear}-10-02` },
      { title: 'Back to School Night', startsAt: `${nextYear}-09-17T18:30:00` },
    ]);

    expect(await upload(userId, groupId)).toBe(true);
    const first = await eventsNamed(groupId, 'Thanksgiving Break - No School');
    expect(first.length).toBeGreaterThan(0);

    // The same file again, re-read with slightly different casing/spacing.
    reply = calendarReply([
      { title: 'thanksgiving break -  no school', startsAt: `${nextYear}-11-26` },
      { title: 'Picture Day', startsAt: `${nextYear}-10-02` },
      { title: 'Spring Concert', startsAt: `${nextYear}-04-15` },
      { title: 'Back to School Night', startsAt: `${nextYear}-09-17T18:30:00` },
    ]);
    expect(await upload(userId, groupId)).toBe(true);

    expect(await eventsNamed(groupId, 'Thanksgiving Break - No School')).toHaveLength(first.length);
    expect(await eventsNamed(groupId, 'thanksgiving break -  no school')).toHaveLength(0);
    expect(await eventsNamed(groupId, 'Picture Day')).toHaveLength(first.length);
    expect(await eventsNamed(groupId, 'Back to School Night')).toHaveLength(first.length);
    // A genuinely new entry on the re-upload is still added.
    expect((await eventsNamed(groupId, 'Spring Concert')).length).toBeGreaterThan(0);
  });

  it('keeps two different all-day entries on the same day', async () => {
    const { userId, groupId } = await seed();
    reply = calendarReply([
      { title: 'Picture Day', startsAt: `${nextYear}-10-02` },
      { title: 'Early Dismissal', startsAt: `${nextYear}-10-02` },
    ]);
    await upload(userId, groupId);
    expect((await eventsNamed(groupId, 'Picture Day')).length).toBeGreaterThan(0);
    expect((await eventsNamed(groupId, 'Early Dismissal')).length).toBeGreaterThan(0);
  });
});
