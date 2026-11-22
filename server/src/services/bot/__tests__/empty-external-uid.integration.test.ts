/**
 * An empty `externalUid` is not a dedup key.
 *
 * Prod, 2026-08-24: "add meeting Sharon at 330p for Wednesday" over WhatsApp
 * came back "You already have a meeting with Sharon scheduled at 3:30 PM on
 * Wednesday." Nothing was on the calendar and nothing was written. The model
 * had filled the optional `externalUid` with `""`; `if (args.externalUid)`
 * read that as absent and skipped the dedup branch, then the insert stored it
 * as a real value — and `events_external_uid_per_group` exempts NULL but not
 * `''`, so the SECOND such event in a group hit a 23505. The driver's
 * "duplicate key value violates unique constraint" text was handed to the
 * model as the tool result, and it relayed it as a fact about her calendar.
 *
 * Two rules, both pinned here: `''` never reaches the column, and the field is
 * not advertised to the model in the first place.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent } from '@/services/events.service.js';
import { buildToolDefs, toolSchemas } from '@/services/bot/tools.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('create_event with an empty externalUid', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  const dayOffset = (days: number): string => {
    const d = new Date(Date.now() + days * 86400000);
    return `${d.toISOString().slice(0, 10)}T19:00:00+00:00`;
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: userId, username: 'ro', display_name: 'Ro', created_at: now, shadow: 0 })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Personal',
        kind: 'personal',
        invite_code: 'XEUID',
        ingest_email: 'euid@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({
        group_id: groupId,
        user_id: userId,
        role: 'owner',
        tier: 'verified',
        joined_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const create = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: newId('m'),
      tzOffset: '+00:00',
      call: { name: 'create_event', args: toolSchemas.create_event.parse(args) },
    });

  const uids = async () =>
    (
      await db
        .selectFrom('events')
        .select('external_uid')
        .where('group_id', '=', groupId)
        .execute()
    ).map((r) => r.external_uid);

  it('stores NULL, not the empty string', async () => {
    await create({ title: 'Meeting Sharon', startsAt: dayOffset(2), externalUid: '' });
    expect(await uids()).toEqual([null]);
  });

  it('lets a second event through — the collision that wedged the group', async () => {
    await create({ title: 'Meeting Sharon', startsAt: dayOffset(2), externalUid: '' });
    // Different title and time, so the ADR 0013 similar-event dedup cannot be
    // what saves this: only the NULL uid can.
    await create({ title: 'Dentist', startsAt: dayOffset(5), externalUid: '' });
    expect(await uids()).toEqual([null, null]);
  });

  it('still dedups on a real uid', async () => {
    const startsAt = dayOffset(2);
    await create({ title: 'Standup', startsAt, externalUid: 'ics:abc' });
    const second = await create({ title: 'Standup', startsAt, externalUid: 'ics:abc' });

    expect(second.data).toMatchObject({ deduped: true });
    expect(await uids()).toEqual(['ics:abc']);
  });

  it('coerces an empty uid at the write too, not only at the schema', async () => {
    // Deliberately bypasses `toolSchemas` — the ingest pipelines call
    // `createEvent` directly, and an .ics with no UID line yields `''` with
    // no LLM anywhere near it. `?? null` let that through; `|| null` does not.
    await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Imported one',
      startsAt: dayOffset(2),
      externalUid: '',
    });
    await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Imported two',
      startsAt: dayOffset(6),
      externalUid: '',
    });

    expect(await uids()).toEqual([null, null]);
  });

  it('never offers externalUid to the model', () => {
    const ce = buildToolDefs().find((d) => d.name === 'create_event');
    const props = Object.keys(
      ((ce?.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
    );

    expect(props).not.toContain('externalUid');
    // The strip must not take the real parameters with it.
    expect(props).toEqual(
      expect.arrayContaining(['title', 'startsAt', 'endsAt', 'location', 'confirmPast']),
    );
  });
});
