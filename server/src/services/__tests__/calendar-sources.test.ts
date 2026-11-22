/**
 * ADR 0033 — auto-pick rules + busy-id effective resolution. Verifies
 * the policy decisions documented in 0033-calendar-busyness-policy.md.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import {
  busyCalendarIds,
  eventBlocksTime,
  listCalendarSources,
  loadBusyContext,
  pickCountsForBusyAuto,
  setCalendarSourceOverride,
  upsertCalendarSource,
} from '@/services/calendar-sources.service.js';

describe('ADR 0033/0072 — pickCountsForBusyAuto judges from source signals', () => {
  const base = { summary: 's', selectedInGoogle: true };
  it('primary / Chord-target / writer (incl. writable device calendars) → Block', () => {
    expect(
      pickCountsForBusyAuto({
        ...base,
        googleCalendarId: 'me@example.com',
        accessRole: 'owner',
        isPrimary: true,
        isChordTarget: false,
      }),
    ).toBe(true);
    expect(
      pickCountsForBusyAuto({
        ...base,
        googleCalendarId: 'fam@group.v.calendar.google.com',
        accessRole: 'reader',
        isPrimary: false,
        isChordTarget: true,
      }),
    ).toBe(true);
    // Device calendars ride the same rule: allowsModifications → 'writer'.
    expect(
      pickCountsForBusyAuto({
        ...base,
        provider: 'device',
        googleCalendarId: 'dev-cal-1',
        accessRole: 'writer',
        isPrimary: false,
        isChordTarget: false,
      }),
    ).toBe(true);
  });

  it('reader-only shares (holidays, partner, subscribed device) → informational', () => {
    expect(
      pickCountsForBusyAuto({
        ...base,
        googleCalendarId: 'en.usa#holiday@holiday.calendar.google.com',
        accessRole: 'reader',
        isPrimary: false,
        isChordTarget: false,
      }),
    ).toBe(false);
    expect(
      pickCountsForBusyAuto({
        ...base,
        provider: 'device',
        googleCalendarId: 'dev-subscribed',
        accessRole: 'reader',
        isPrimary: false,
        isChordTarget: false,
      }),
    ).toBe(false);
  });
});

describe('ADR 0033 — calendar_sources table + effective resolution', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'busy_user', 'Busy');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('upsert assigns auto value, override is null, refresh preserves override', async () => {
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'shared@cal',
      summary: 'Shared',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    let rows = await listCalendarSources(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].countsForBusyAuto).toBe(false);
    expect(rows[0].countsForBusyEffective).toBe(false);

    await setCalendarSourceOverride(db, userId, rows[0].id, true);
    rows = await listCalendarSources(db, userId);
    expect(rows[0].countsForBusyOverride).toBe(true);
    expect(rows[0].countsForBusyEffective).toBe(true);

    // Re-sync: auto value would still be null, but override survives.
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'shared@cal',
      summary: 'Shared (renamed)',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    rows = await listCalendarSources(db, userId);
    expect(rows[0].summary).toBe('Shared (renamed)');
    expect(rows[0].countsForBusyOverride).toBe(true);
    expect(rows[0].countsForBusyEffective).toBe(true);
  });

  it('surfaces provider + color, and a color-less re-sync keeps the color (ADR 0057)', async () => {
    await upsertCalendarSource(db, userId, {
      provider: 'google',
      googleCalendarId: 'g@cal',
      summary: 'Family',
      color: '#4287f5',
      accessRole: 'owner',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await upsertCalendarSource(db, userId, {
      provider: 'device',
      googleCalendarId: 'dev-1',
      summary: 'Family',
      color: '#e5534b',
      accessRole: 'writer',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    let rows = await listCalendarSources(db, userId);
    const g = rows.find((r) => r.googleCalendarId === 'g@cal')!;
    const d = rows.find((r) => r.googleCalendarId === 'dev-1')!;
    expect(g.provider).toBe('google');
    expect(g.color).toBe('#4287f5');
    expect(d.provider).toBe('device');
    expect(d.color).toBe('#e5534b');

    // A later sync that doesn't carry a color must not wipe it.
    await upsertCalendarSource(db, userId, {
      provider: 'device',
      googleCalendarId: 'dev-1',
      summary: 'Family',
      accessRole: 'writer',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    rows = await listCalendarSources(db, userId);
    expect(rows.find((r) => r.googleCalendarId === 'dev-1')!.color).toBe('#e5534b');
  });

  it('busyCalendarIds returns only calendars the user opted into Block', async () => {
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'holiday@cal',
      summary: 'Holidays',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    // Signal-based defaults: primary blocks, reader-only holiday doesn't.
    let ids = await busyCalendarIds(db, userId);
    expect(ids.has('primary@cal')).toBe(true);
    expect(ids.has('holiday@cal')).toBe(false);

    // The Block switch overrides either way.
    const rows = await listCalendarSources(db, userId);
    const primary = rows.find((r) => r.googleCalendarId === 'primary@cal')!;
    await setCalendarSourceOverride(db, userId, primary.id, false);
    ids = await busyCalendarIds(db, userId);
    expect(ids.has('primary@cal')).toBe(false);
  });

  it('eventBlocksTime: only busy-calendar and Chord-native events block', async () => {
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'holiday@cal',
      summary: 'Holidays',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    const ctx = await loadBusyContext(db, userId);
    expect(ctx.primaryCalendarId).toBe('primary@cal');

    // Chord-native (no gcal external_uid) always blocks.
    expect(eventBlocksTime({ external_uid: null }, ctx)).toBe(true);
    // Primary-calendar event (gcal:<id>, no embedded cal id) blocks by default.
    expect(eventBlocksTime({ external_uid: 'gcal:evt123' }, ctx)).toBe(true);
    // Event on an informational calendar does NOT block.
    expect(eventBlocksTime({ external_uid: 'gcal:holiday@cal:evt9' }, ctx)).toBe(false);
  });

  // ADR 0157 — a device-calendar copy carries `device:<calId>:<eventId>`.
  // eventBlocksTime must honour that calendar's Block setting, not fall through
  // to the "unknown shape → Chord-native → always blocks" default (the bug that
  // made a read-only subscribed school calendar trigger a conflict nudge).
  it('eventBlocksTime: a device-calendar copy honours its Block setting', async () => {
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'DEVICE-BUSY',
      summary: 'Work (phone)',
      accessRole: 'writer', // writable → blocks
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
      provider: 'device',
    });
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'DEVICE-INFO',
      summary: 'School feed (phone)',
      accessRole: 'reader', // subscribed / read-only → informational
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
      provider: 'device',
    });
    const ctx = await loadBusyContext(db, userId);

    expect(eventBlocksTime({ external_uid: 'device:DEVICE-BUSY:evt-1' }, ctx)).toBe(true);
    expect(eventBlocksTime({ external_uid: 'device:DEVICE-INFO:evt-2' }, ctx)).toBe(false);
    // Unknown device calendar id → not in the busy set → does not block.
    expect(eventBlocksTime({ external_uid: 'device:DEVICE-GONE:evt-3' }, ctx)).toBe(false);
  });
});
