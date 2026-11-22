/**
 * Briefing conflicts (loadScanContext → CONFLICTS).
 *
 * Two rules, both mirroring computeConflicts so the briefing can't drift from
 * the deterministic per-event check:
 *   1. Info-only calendar events are heads-up, never conflicts (INFO_ONLY).
 *   2. A conflict requires a real time-range clash between two *blocking*
 *      events — not mere same-day co-occurrence, and free events (transparent,
 *      all-day, <5-min) never count.
 * Conflicts used to be OVERLAPS_WITH tags on each event; they are one
 * CONFLICTS list now, each clash once.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { loadScanContext } from '@/services/proactive.service.js';

/** The lines of the CONFLICTS section, [] when there is none. */
function conflictLines(prompt: string): string[] {
  const lines = prompt.split('\n');
  const at = lines.indexOf('CONFLICTS:');
  if (at === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  - ')) break;
    out.push(l);
  }
  return out;
}

async function tomorrowAt(hour: number): Promise<string> {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function minutesPastTomorrow(hour: number, minutes: number): Promise<string> {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minutes, 0, 0);
  return d.toISOString();
}

describe('loadScanContext — info calendars never become conflicts', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('tags info-calendar events INFO_ONLY and leaves them out of CONFLICTS', async () => {
    const uid = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });

    // Primary (busy) + an info-only reader-shared calendar.
    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'alice@primary',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'soccer@info',
      summary: 'Kids soccer',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    const busyStart = await tomorrowAt(15); // 3pm UTC tomorrow
    const infoStart = await tomorrowAt(17); // 5pm UTC tomorrow — same day

    await createEvent(db, {
      groupId: group.id,
      title: 'Team standup',
      startsAt: busyStart,
      createdBy: uid,
      externalUid: 'gcal:alice@primary:evt1',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Sam soccer game',
      startsAt: infoStart,
      createdBy: uid,
      externalUid: 'gcal:soccer@info:evt2',
    });

    const prompt = await loadScanContext(db, uid);

    // The info-only event is tagged so the LLM treats it as FYI.
    expect(prompt).toMatch(/Sam soccer game.*INFO_ONLY/);
    // The only other event on the day is info-only, so there is no conflict.
    expect(prompt).toContain('Team standup');
    expect(conflictLines(prompt)).toEqual([]);
  });

  it('two busy events that actually overlap in time are one CONFLICTS line', async () => {
    const uid = await createUser(db, 'bob', 'Bob');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });

    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'bob@primary',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    // Doctor 10:00–12:00 and Lunch 11:00–12:00 — a real time overlap.
    await createEvent(db, {
      groupId: group.id,
      title: 'Doctor',
      startsAt: await tomorrowAt(10),
      endsAt: await tomorrowAt(12),
      createdBy: uid,
      externalUid: 'gcal:bob@primary:doc',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Lunch with Pat',
      startsAt: await tomorrowAt(11),
      endsAt: await tomorrowAt(12),
      createdBy: uid,
      externalUid: 'gcal:bob@primary:lunch',
    });

    const prompt = await loadScanContext(db, uid);
    // Once, naming both — it was a tag on each, so the clash was read twice.
    const conflicts = conflictLines(prompt);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/"Doctor".*overlaps "Lunch with Pat"/);
  });

  it('two busy events on the same day at NON-overlapping times do not pair', async () => {
    // Regression: the briefing used to tag every same-day busy event as
    // OVERLAPS_WITH (same-day != time clash), so the nudge reported events
    // "all overlapping" when none actually did.
    const uid = await createUser(db, 'carol', 'Carol');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });

    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'carol@primary',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    // 10:00–11:00 and 14:00–15:00 — same day, no time overlap.
    await createEvent(db, {
      groupId: group.id,
      title: 'Move car',
      startsAt: await tomorrowAt(10),
      endsAt: await tomorrowAt(11),
      createdBy: uid,
      externalUid: 'gcal:carol@primary:car',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Sign up for races',
      startsAt: await tomorrowAt(14),
      endsAt: await tomorrowAt(15),
      createdBy: uid,
      externalUid: 'gcal:carol@primary:races',
    });

    const prompt = await loadScanContext(db, uid);
    expect(prompt).toContain('Move car');
    expect(conflictLines(prompt)).toEqual([]);
  });

  it('a short (<5-min) busy event never pairs as a conflict', async () => {
    const uid = await createUser(db, 'dave', 'Dave');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });

    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'dave@primary',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    // A 2-min "Connect with John" inside a real meeting block. The short
    // event is structurally free (ADR 0040) so it must not be a conflict.
    await createEvent(db, {
      groupId: group.id,
      title: 'Connect with John',
      startsAt: await tomorrowAt(10),
      endsAt: await minutesPastTomorrow(10, 2),
      createdBy: uid,
      externalUid: 'gcal:dave@primary:short',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Design review',
      startsAt: await tomorrowAt(10),
      endsAt: await tomorrowAt(11),
      createdBy: uid,
      externalUid: 'gcal:dave@primary:review',
    });

    const prompt = await loadScanContext(db, uid);
    // The real meeting has no other *blocking* peer, so nothing pairs.
    expect(prompt).toContain('Design review');
    expect(conflictLines(prompt)).toEqual([]);
  });
});
