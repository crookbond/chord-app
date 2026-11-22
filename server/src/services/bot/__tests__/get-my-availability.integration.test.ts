/**
 * ADR 0197 — "reply with times that work" said in chat gets the same real
 * availability the reply box's composer gets, and only in the personal 1:1:
 * busy blocks are owner-scoped across every group (ADR 0032).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { userAvailability } from '@/services/availability.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, READONLY_TOOL_NAMES, buildToolDefs } from '@/services/bot/tools.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'avail-asker');
  await db.updateTable('users').set({ last_tz: 'America/Chicago' }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
});

afterEach(async () => {
  await closeTestDb(db);
});

const ask = (groupId: string, args: { days?: number } = {}) =>
  applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: null,
    turnId: 'turn-avail',
    call: { name: 'get_my_availability', args },
  });

it('lists the real busy block in the user zone, same as the composer sees', async () => {
  await upsertCalendarSource(db, userId, {
    googleCalendarId: 'primary@cal',
    summary: 'Me',
    accessRole: 'owner',
    isPrimary: true,
    selectedInGoogle: true,
    isChordTarget: true,
  });
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(19, 0, 0, 0);
  await createEvent(db, {
    groupId: personalId,
    title: 'School pickup',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    createdBy: userId,
  });

  const result = await ask(personalId, { days: 3 });
  const data = result.data as { known: boolean; tz: string; days: number; text: string };
  expect(data.known).toBe(true);
  expect(data.tz).toBe('America/Chicago');
  expect(data.text.split('\n')).toHaveLength(3);
  const label = start.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  expect(data.text).toContain(`busy ${label}–`);
  // One implementation: the chat tool and the reply-box composer agree.
  expect(data.text).toBe((await userAvailability(db, userId, { days: 3 })).text);
});

it('says availability is unknown with no calendar connected', async () => {
  const data = (await ask(personalId)).data as { known: boolean; text: string };
  expect(data.known).toBe(false);
  expect(data.text).toContain('no calendar connected');
});

it('refuses in a shared group', async () => {
  const shared = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
  const data = (await ask(shared.id)).data as { known: boolean; reason?: string };
  expect(data).toEqual({ known: false, reason: 'personal_only' });
});

it('is read-only, personal-only, and named by reply_to_email for proposing times', () => {
  expect(READONLY_TOOL_NAMES.has('get_my_availability')).toBe(true);
  expect(PERSONAL_ONLY_TOOL_NAMES.has('get_my_availability')).toBe(true);
  const reply = buildToolDefs().find((d) => d.name === 'reply_to_email')!;
  expect(reply.description).toContain('get_my_availability');
});
