/**
 * ADR 0351 — re-engage nudges. What matters: one push per absence, never the
 * same feature twice, only to people who use the app and are idle 2+ days,
 * only in their daytime, and nothing for someone who turned tips off.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(
  () => [] as { tokens: string[]; payload: { title: string; body: string; data?: Record<string, unknown> } }[],
);
vi.mock('@/services/push/expo.service.js', () => ({
  sendPush: async (_db: unknown, tokens: string[], payload: { title: string; body: string }) => {
    sent.push({ tokens, payload });
  },
}));

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';
import { REENGAGE_FEATURES, pickFeature } from '../features.js';
import { idleCandidates, nudgeBlockedBy, setFeatureTips, sweepReengage } from '../reengage.service.js';

const DAY = 24 * 60 * 60 * 1000;
// Noon in New York (BRIEFING_DEFAULT_TZ), so the send-hours window is open.
const NOON = new Date('2026-06-10T16:00:00.000Z');
const ago = (days: number, from = NOON) => new Date(from.getTime() - days * DAY).toISOString();

let db: Kysely<DB>;
let userId: string;

async function seen(id: string, at: string): Promise<void> {
  await db
    .insertInto('sessions')
    .values({ token: newId('tok'), user_id: id, created_at: at, last_seen_at: at })
    .execute();
}
async function device(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('push_tokens')
    .values({ token: `ExponentPushToken[${id}]`, user_id: id, platform: 'ios', created_at: now, last_seen_at: now })
    .execute();
}
const features = () => sent.map((s) => s.payload.data?.feature);

beforeEach(async () => {
  sent.length = 0;
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  await device(userId);
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('re-engage sweep', () => {
  it('sends one tip to someone idle 3 days, naming the first unused feature', async () => {
    await seen(userId, ago(3));
    expect(await sweepReengage(db, NOON)).toBe(1);
    expect(features()).toEqual(['connect_email']);
    expect(sent[0].payload.data?.url).toBe('/settings?open=mailboxes');
    expect(sent[0].payload.body).toMatch(/Reply "stop sending me tips" in chat to stop\.$/);
  });

  it('sends nothing more in the same absence, however many sweeps run', async () => {
    await seen(userId, ago(3));
    await sweepReengage(db, NOON);
    await sweepReengage(db, new Date(NOON.getTime() + DAY));
    await sweepReengage(db, new Date(NOON.getTime() + 9 * DAY));
    expect(features()).toEqual(['connect_email']);
  });

  it('after a return and a new absence, offers the next feature, never the same one', async () => {
    await seen(userId, ago(3));
    await sweepReengage(db, NOON);
    const later = new Date(NOON.getTime() + 10 * DAY);
    await seen(userId, ago(3, later)); // came back, then left again
    await sweepReengage(db, later);
    expect(features()).toEqual(['connect_email', 'ask_chord']);
  });

  it('waits out the minimum gap even after a return', async () => {
    await seen(userId, ago(3));
    await sweepReengage(db, NOON);
    const soon = new Date(NOON.getTime() + 4 * DAY);
    await seen(userId, ago(2.5, soon)); // back the next day, gone again
    await sweepReengage(db, soon);
    expect(features()).toEqual(['connect_email']);
  });

  it('leaves alone someone active yesterday, gone a month, a shadow, or with no session', async () => {
    await seen(userId, ago(1));
    const gone = await createUser(db, 'gone');
    await device(gone);
    await seen(gone, ago(30));
    const shadow = await createUser(db, 'shadow');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', shadow).execute();
    await device(shadow);
    await seen(shadow, ago(3));
    const whatsappOnly = await createUser(db, 'wa');
    await device(whatsappOnly);
    expect(await idleCandidates(db, NOON)).toEqual([]);
    expect(await sweepReengage(db, NOON)).toBe(0);
  });

  it('does not send at 3am local, and sends later that day', async () => {
    await seen(userId, ago(3));
    const night = new Date('2026-06-10T07:00:00.000Z'); // 3am New York
    expect(await sweepReengage(db, night)).toBe(0);
    expect(await sweepReengage(db, NOON)).toBe(1);
  });

  it('skips a feature already used, and one whose prerequisite is not used', async () => {
    // Without a mailbox, every mail tip waits behind connect_email.
    const none = pickFeature(REENGAGE_FEATURES, new Set(), new Set(['connect_email', 'ask_chord', 'shared_list']));
    expect(none?.id).toBe('plan_my_day');

    await seen(userId, ago(3));
    await db
      .insertInto('email_accounts')
      .values({
        id: newId('acct'),
        user_id: userId,
        provider: 'imap',
        email_address: 'a@example.com',
        display_name: null,
        preset_key: null,
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        created_at: NOON.toISOString(),
        updated_at: NOON.toISOString(),
      })
      .execute();
    await sweepReengage(db, NOON);
    // connect_email is used, so the first tip is the next unused one.
    expect(features()).toEqual(['ask_chord']);
    const used = new Set(['connect_email']);
    expect(pickFeature(REENGAGE_FEATURES, used, new Set(['ask_chord', 'shared_list']))?.id).toBe('email_tldr');
  });

  it('counts a list the user made as used', async () => {
    await seen(userId, ago(3));
    const g = await db
      .insertInto('groups')
      .values({
        id: newId('g'),
        name: 'Me',
        kind: 'personal',
        invite_code: newId('inv'),
        ingest_email: `${newId('i')}@x`,
        created_by: userId,
        created_at: NOON.toISOString(),
        adults_only: 0,
        mirror_inbound: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('lists')
      .values({ id: newId('l'), group_id: g.id, name: 'Costco', created_by: userId, created_at: NOON.toISOString() })
      .execute();
    const ctx = { db, userId, personalGroupId: g.id };
    const list = REENGAGE_FEATURES.find((f) => f.id === 'shared_list')!;
    expect(await list.used(ctx)).toBe(true);
    expect(REENGAGE_FEATURES.find((f) => f.id === 'ask_chord')!.url(ctx)).toBe(`/groups/${g.id}`);
  });

  it('sends nothing to someone with no device, and records nothing', async () => {
    await db.deleteFrom('push_tokens').execute();
    await seen(userId, ago(3));
    expect(await sweepReengage(db, NOON)).toBe(0);
    await device(userId);
    expect(await sweepReengage(db, NOON)).toBe(1);
  });

  it('respects tips turned off, and back on', async () => {
    await seen(userId, ago(3));
    expect(await setFeatureTips(db, userId, false)).toBe(false);
    expect(await sweepReengage(db, NOON)).toBe(0);
    expect(await setFeatureTips(db, userId, null)).toBe(false);
    expect(await setFeatureTips(db, userId, true)).toBe(true);
    expect(await sweepReengage(db, NOON)).toBe(1);
  });

  it('respects the bot-notification switch', async () => {
    await seen(userId, ago(3));
    await db.updateTable('users').set({ notify_bot: 0 }).where('id', '=', userId).execute();
    expect(await sweepReengage(db, NOON)).toBe(0);
  });
});

describe('nudgeBlockedBy', () => {
  it('blocks a second nudge in one absence and one sooner than the gap', () => {
    expect(nudgeBlockedBy([], ago(3), NOON)).toBeNull();
    expect(nudgeBlockedBy([{ at: ago(1) }], ago(3), NOON)).toBe('this_absence');
    expect(nudgeBlockedBy([{ at: ago(4) }], ago(3), NOON)).toBe('too_soon');
    expect(nudgeBlockedBy([{ at: ago(10) }], ago(3), NOON)).toBeNull();
  });
});
