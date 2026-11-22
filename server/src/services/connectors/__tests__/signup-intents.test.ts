/**
 * Coverage for the UUID-referrer flow (ADR 0031): mint a token in the
 * TG welcome DM, consume it on Google sign-in, soft-link the TG
 * identity into the freshly-created real user. Mint is idempotent per
 * TG id; consume is single-use, expiry-aware, and runs the same shadow
 * merge as pair-code consume.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { resolveIdentity } from '@/services/connectors/identity-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import {
  consumeForTg,
  consumeSignupIntent,
  mintForTg,
  mintSignupIntent,
} from '@/services/connectors/signup-intents.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('signup-intents — TG soft-link via UUID', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // ── mint ────────────────────────────────────────────────────────────

  it('mintForTg creates a token and inserts an open intent row', async () => {
    const token = await mintForTg(db, '12345');
    expect(token.length).toBeGreaterThanOrEqual(20);

    const row = await db
      .selectFrom('signup_intents')
      .selectAll()
      .where('token', '=', token)
      .executeTakeFirstOrThrow();
    expect(row.platform).toBe('telegram');
    expect(row.external_user_id).toBe('12345');
    expect(row.email).toBeNull();
    expect(row.consumed_at).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('mintForTg is idempotent — same TG id reuses the open token', async () => {
    const t1 = await mintForTg(db, 'tg-7');
    const t2 = await mintForTg(db, 'tg-7');
    expect(t2).toBe(t1);

    const count = await db
      .selectFrom('signup_intents')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('mintForTg mints a fresh token for a different TG id', async () => {
    const a = await mintForTg(db, 'tg-a');
    const b = await mintForTg(db, 'tg-b');
    expect(a).not.toBe(b);
  });

  it('mintForTg mints a fresh token when the old one is already consumed', async () => {
    const t1 = await mintForTg(db, 'tg-r');
    await db
      .updateTable('signup_intents')
      .set({ consumed_at: new Date().toISOString() })
      .where('token', '=', t1)
      .execute();

    const t2 = await mintForTg(db, 'tg-r');
    expect(t2).not.toBe(t1);
  });

  // ── consume — happy path ────────────────────────────────────────────

  it('consumeForTg re-points the TG identity to the real user and marks consumed', async () => {
    // The TG user showed up in some group first → shadow created.
    const shadowId = await resolveIdentity(db, 'telegram', 'tg-999', 'Sam on TG');
    const shadow = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', shadowId)
      .executeTakeFirstOrThrow();
    expect(shadow.shadow).toBe(1);

    // Bot DMs the user → mints intent.
    const token = await mintForTg(db, 'tg-999');

    // User signs up via Google → real user exists, then consume runs.
    const realId = await createUser(db, 'real_sam', 'Sam');
    const result = await consumeForTg(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'sam@example.com',
      ownerDisplay: 'Sam',
    });

    expect(result.ok).toBe(true);

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_id', '=', 'tg-999')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(realId);

    // Shadow should be deleted (merged).
    const shadowAfter = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', shadowId)
      .executeTakeFirst();
    expect(shadowAfter).toBeUndefined();

    const intent = await db
      .selectFrom('signup_intents')
      .selectAll()
      .where('token', '=', token)
      .executeTakeFirstOrThrow();
    expect(intent.consumed_at).not.toBeNull();
    expect(intent.email).toBe('sam@example.com');
  });

  it('consumeForTg links the TG identity to the real user when no shadow exists yet', async () => {
    const token = await mintForTg(db, 'tg-new');
    const realId = await createUser(db, 'newcomer', 'Newcomer');

    const result = await consumeForTg(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'new@example.com',
      ownerDisplay: 'Newcomer',
    });
    expect(result.ok).toBe(true);

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_id', '=', 'tg-new')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(realId);
  });

  // ── consume — failure modes ─────────────────────────────────────────

  it('consumeForTg returns unknown_token for a bogus token', async () => {
    const realId = await createUser(db);
    const result = await consumeForTg(db, {
      token: 'not-a-real-token-xyz',
      ownerUserId: realId,
      ownerEmail: 'x@example.com',
      ownerDisplay: 'X',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_token');
  });

  it('consumeForTg returns expired when the token is past expires_at', async () => {
    const token = await mintForTg(db, 'tg-stale');
    await db
      .updateTable('signup_intents')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where('token', '=', token)
      .execute();

    const realId = await createUser(db);
    const result = await consumeForTg(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'x@example.com',
      ownerDisplay: 'X',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('consumeForTg returns already_consumed on the second attempt', async () => {
    const token = await mintForTg(db, 'tg-used');
    const realId = await createUser(db);
    const first = await consumeForTg(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'a@example.com',
      ownerDisplay: 'A',
    });
    expect(first.ok).toBe(true);

    const otherReal = await createUser(db);
    const second = await consumeForTg(db, {
      token,
      ownerUserId: otherReal,
      ownerEmail: 'b@example.com',
      ownerDisplay: 'B',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_consumed');

    // Identity link should NOT have been re-pointed to the second user.
    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_id', '=', 'tg-used')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(realId);
  });
});

describe('signup-intents — WhatsApp soft-link (ADR 0053)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('mintSignupIntent stamps the whatsapp platform and is idempotent per number', async () => {
    const wa = 'whatsapp:+13475550001';
    const t1 = await mintSignupIntent(db, 'whatsapp', wa);
    const t2 = await mintSignupIntent(db, 'whatsapp', wa);
    expect(t2).toBe(t1);

    const row = await db
      .selectFrom('signup_intents')
      .selectAll()
      .where('token', '=', t1)
      .executeTakeFirstOrThrow();
    expect(row.platform).toBe('whatsapp');
    expect(row.external_user_id).toBe(wa);
  });

  it('a telegram id and a whatsapp number mint distinct tokens', async () => {
    const tg = await mintSignupIntent(db, 'telegram', 'shared-id');
    const wa = await mintSignupIntent(db, 'whatsapp', 'shared-id');
    expect(tg).not.toBe(wa);
  });

  it('consumeSignupIntent re-points the whatsapp identity to the real user', async () => {
    const wa = 'whatsapp:+13475550002';
    const shadowId = await resolveIdentity(db, 'whatsapp', wa, 'John on WA');
    const shadow = await db
      .selectFrom('users')
      .select('shadow')
      .where('id', '=', shadowId)
      .executeTakeFirstOrThrow();
    expect(shadow.shadow).toBe(1);

    const token = await mintSignupIntent(db, 'whatsapp', wa);
    const realId = await createUser(db, 'real_john', 'John');
    const result = await consumeSignupIntent(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'john@example.com',
      ownerDisplay: 'John',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.platform).toBe('whatsapp');

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'whatsapp')
      .where('external_id', '=', wa)
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(realId);

    const intent = await db
      .selectFrom('signup_intents')
      .select(['consumed_at', 'email'])
      .where('token', '=', token)
      .executeTakeFirstOrThrow();
    expect(intent.consumed_at).not.toBeNull();
    expect(intent.email).toBe('john@example.com');
  });

  // Regression (prod 2026-06-21): the shadow created an event during the
  // taster, so events.owner_user_id / organizer_user_id and an
  // event_attendees.user_id pointed at the shadow. Those NO-ACTION FKs were
  // missing from the merge's re-attribution list, so `DELETE FROM users`
  // threw and rolled back the entire (transactional) consume — the WhatsApp
  // number never linked. The merge must now re-point them and succeed.
  it('consumeSignupIntent merges a shadow that owns an event (FK re-point)', async () => {
    const wa = 'whatsapp:+13475550003';
    const shadowId = await resolveIdentity(db, 'whatsapp', wa, 'John on WA');
    const group = await createGroup(db, {
      name: 'Personal',
      kind: 'personal',
      createdBy: shadowId,
    });
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id: 'ev_taster',
        group_id: group.id,
        title: 'Dentist',
        starts_at: now,
        created_at: now,
        created_by: shadowId,
        owner_user_id: shadowId,
        organizer_user_id: shadowId,
      })
      .execute();
    await db
      .insertInto('event_attendees')
      .values({
        id: 'att_taster',
        ical_uid: 'uid_taster',
        user_id: shadowId,
        display_name: 'John on WA',
        updated_at: now,
      })
      .execute();

    const token = await mintSignupIntent(db, 'whatsapp', wa);
    const realId = await createUser(db, 'real_john2', 'John');
    const result = await consumeSignupIntent(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'john@example.com',
      ownerDisplay: 'John',
    });
    expect(result.ok).toBe(true);

    // Shadow gone, identity + all owned rows re-pointed at the real user.
    const shadowAfter = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', shadowId)
      .executeTakeFirst();
    expect(shadowAfter).toBeUndefined();

    const ev = await db
      .selectFrom('events')
      .select(['created_by', 'owner_user_id', 'organizer_user_id'])
      .where('id', '=', 'ev_taster')
      .executeTakeFirstOrThrow();
    expect(ev.created_by).toBe(realId);
    expect(ev.owner_user_id).toBe(realId);
    expect(ev.organizer_user_id).toBe(realId);

    const att = await db
      .selectFrom('event_attendees')
      .select('user_id')
      .where('id', '=', 'att_taster')
      .executeTakeFirstOrThrow();
    expect(att.user_id).toBe(realId);
  });
});

describe('signup-intents — WhatsApp connection confirmation', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'whatsapp');
    connectorRegistry.register(conn);
  });

  afterEach(async () => {
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('consolidates the taster personal group into the owner\'s existing one', async () => {
    // Owner already has a personal group (the returning-user case).
    const ownerId = await createUser(db, 'owner_existing', 'Owner');
    const ownerPersonal = await ensurePersonalGroup(db, ownerId);

    // WhatsApp taster: shadow + its own personal group holding a calendar
    // event and the WhatsApp binding.
    const wa = 'whatsapp:+13475550042';
    const shadowId = await resolveIdentity(db, 'whatsapp', wa, 'John on WA');
    const shadowPersonal = await ensurePersonalGroup(db, shadowId);
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id: 'ev_taster_call',
        group_id: shadowPersonal.id,
        group_ids: JSON.stringify([shadowPersonal.id]),
        title: '330p call',
        starts_at: now,
        created_at: now,
        created_by: shadowId,
        owner_user_id: shadowId,
      })
      .execute();
    await bindChannel(db, 'whatsapp', wa, shadowPersonal.id, 'whatsapp');

    const token = await mintSignupIntent(db, 'whatsapp', wa);
    const result = await consumeSignupIntent(db, {
      token,
      ownerUserId: ownerId,
      ownerEmail: 'owner@example.com',
      ownerDisplay: 'Owner',
    });
    expect(result.ok).toBe(true);

    // The taster group is gone; the owner has exactly one personal group.
    const shadowGroupAfter = await db
      .selectFrom('groups')
      .select('id')
      .where('id', '=', shadowPersonal.id)
      .executeTakeFirst();
    expect(shadowGroupAfter).toBeUndefined();
    const personals = await db
      .selectFrom('groups')
      .select('id')
      .where('kind', '=', 'personal')
      .where('created_by', '=', ownerId)
      .execute();
    expect(personals.map((p) => p.id)).toEqual([ownerPersonal.id]);

    // The event moved into the owner's group (group_id + group_ids), owned
    // by the owner, and the WhatsApp binding follows.
    const ev = await db
      .selectFrom('events')
      .select(['group_id', 'group_ids', 'owner_user_id'])
      .where('id', '=', 'ev_taster_call')
      .executeTakeFirstOrThrow();
    expect(ev.group_id).toBe(ownerPersonal.id);
    expect(ev.owner_user_id).toBe(ownerId);
    expect(JSON.stringify(ev.group_ids)).toContain(ownerPersonal.id);
    const binding = await db
      .selectFrom('group_external_channels')
      .select('group_id')
      .where('external_channel_id', '=', wa)
      .executeTakeFirstOrThrow();
    expect(binding.group_id).toBe(ownerPersonal.id);
  });

  it('collapses duplicate daily briefings to one after the merge', async () => {
    const ownerId = await createUser(db, 'owner_nudge', 'Owner');
    const ownerPersonal = await ensurePersonalGroup(db, ownerId);
    const wa = 'whatsapp:+13475550077';
    const shadowId = await resolveIdentity(db, 'whatsapp', wa, 'John on WA');
    const shadowPersonal = await ensurePersonalGroup(db, shadowId);

    // Each personal group has its own pending morning scan (what seedDailyScan
    // produces). The shadow's payload names the shadow user.
    const mkScan = (id: string, gid: string, uid: string) => ({
      id,
      group_id: gid,
      persona_id: uid,
      kind: 'daily_morning_scan' as const,
      payload: JSON.stringify({ userId: uid, scanDate: '2026-06-22' }),
      scheduled_for: '2026-06-22T11:00:00.000Z',
      fired_at: null,
      created_at: '2026-06-21T00:00:00.000Z',
    });
    await db
      .insertInto('proactive_messages')
      .values([
        mkScan('pm_owner_scan', ownerPersonal.id, ownerId),
        mkScan('pm_shadow_scan', shadowPersonal.id, shadowId),
      ])
      .execute();

    const token = await mintSignupIntent(db, 'whatsapp', wa);
    const result = await consumeSignupIntent(db, {
      token,
      ownerUserId: ownerId,
      ownerEmail: 'owner@example.com',
      ownerDisplay: 'Owner',
    });
    expect(result.ok).toBe(true);

    // Exactly one unfired daily scan remains, attributed to the owner (not
    // the now-deleted shadow whose payload would render an empty briefing).
    const scans = await db
      .selectFrom('proactive_messages')
      .select(['persona_id', 'payload'])
      .where('kind', '=', 'daily_morning_scan')
      .where('persona_id', '=', ownerId)
      .where('fired_at', 'is', null)
      .execute();
    expect(scans).toHaveLength(1);
    expect(scans[0].payload).toContain(ownerId);
    expect(scans[0].payload).not.toContain(shadowId);
  });

  it('confirms back to WhatsApp once the chat is linked', async () => {
    const wa = 'whatsapp:+13475559999';
    await resolveIdentity(db, 'whatsapp', wa, 'John on WA');
    const token = await mintSignupIntent(db, 'whatsapp', wa);
    const realId = await createUser(db, 'real_confirm', 'John');

    const result = await consumeSignupIntent(db, {
      token,
      ownerUserId: realId,
      ownerEmail: 'john@example.com',
      ownerDisplay: 'John',
    });
    expect(result.ok).toBe(true);

    // A single confirmation lands on the same WhatsApp channel.
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].externalChannelId).toBe(wa);
    expect(conn.sent[0].text).toMatch(/connected/i);
  });
});
