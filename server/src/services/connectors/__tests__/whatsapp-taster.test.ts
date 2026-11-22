/**
 * WhatsApp "taster" gate (ADR 0053): an unsigned WhatsApp stranger is
 * served under a shadow account for up to WHATSAPP_TASTER_TURNS billed
 * turns, then gated to the signup flow. `maybeTasterServe` is the pure
 * DB decision — it provisions the shadow + personal group, counts the
 * reactive bot turns already served, and returns the group to serve into
 * (or null to fall through to the app-first gate).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { tasterState } from '@/services/connectors/whatsapp/taster.js';
import { __testing } from '@/services/connectors/inbound-pipeline.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import type { InboundMessage } from '@/services/connectors/types.js';

const { maybeTasterServe } = __testing;

function waMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'whatsapp',
    externalChannelId: 'whatsapp:+13475550100',
    externalChannelDisplay: 'Sam',
    externalUserId: 'whatsapp:+13475550100',
    externalUserDisplay: 'Sam',
    externalMessageId: 'SM1',
    text: 'hi',
    ts: new Date(),
    mentionsBot: true,
    mentionsOthers: false,
    isPrivate: true,
    raw: {},
    ...overrides,
  };
}

let seedSeq = 0;
async function seedBotTurns(
  db: Kysely<DB>,
  groupId: string,
  n: number,
  proactive = 0,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db
      .insertInto('messages')
      .values({
        id: `m_${groupId}_${seedSeq++}`,
        group_id: groupId,
        sender_id: null,
        kind: 'bot',
        body: 'reply',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: proactive,
      })
      .execute();
  }
}

describe('WhatsApp taster (ADR 0053)', () => {
  let db: Kysely<DB>;
  let savedLimit: number;

  beforeEach(async () => {
    db = await openTestDb();
    savedLimit = env.WHATSAPP_TASTER_TURNS;
    (env as { WHATSAPP_TASTER_TURNS: number }).WHATSAPP_TASTER_TURNS = 2;
  });

  afterEach(async () => {
    (env as { WHATSAPP_TASTER_TURNS: number }).WHATSAPP_TASTER_TURNS = savedLimit;
    await closeTestDb(db);
  });

  it('serves a new stranger — creates a shadow + personal group and BINDS the channel', async () => {
    const gid = await maybeTasterServe(db, waMsg());
    expect(gid).not.toBeNull();

    const g = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', gid!)
      .executeTakeFirstOrThrow();
    expect(g.kind).toBe('personal');

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'whatsapp')
      .executeTakeFirstOrThrow();
    const u = await db
      .selectFrom('users')
      .select('shadow')
      .where('id', '=', ident.user_id)
      .executeTakeFirstOrThrow();
    expect(u.shadow).toBe(1);

    // Bound, so the bot's reply can reach WhatsApp (outbound routes by binding).
    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('platform', '=', 'whatsapp')
      .where('external_channel_id', '=', 'whatsapp:+13475550100')
      .executeTakeFirstOrThrow();
    expect(binding.group_id).toBe(gid);
  });

  it('returns null when disabled (limit = 0)', async () => {
    (env as { WHATSAPP_TASTER_TURNS: number }).WHATSAPP_TASTER_TURNS = 0;
    expect(await maybeTasterServe(db, waMsg())).toBeNull();
  });

  it('ignores non-WhatsApp platforms (Telegram keeps its own gate)', async () => {
    const r = await maybeTasterServe(
      db,
      waMsg({ platform: 'telegram', externalUserId: 'tg-1', externalChannelId: 'tg-1' }),
    );
    expect(r).toBeNull();
  });

  it('skips a real (paired) identity', async () => {
    const realId = await createUser(db, 'real_sam', 'Sam');
    await ensurePersonalGroup(db, realId);
    await db
      .insertInto('external_identities')
      .values({
        platform: 'whatsapp',
        external_id: 'whatsapp:+13475550200',
        external_display: 'Sam',
        user_id: realId,
        created_at: new Date().toISOString(),
      })
      .execute();

    const r = await maybeTasterServe(
      db,
      waMsg({
        externalUserId: 'whatsapp:+13475550200',
        externalChannelId: 'whatsapp:+13475550200',
      }),
    );
    expect(r).toBeNull();
  });

  // ── allowance gate (runs at reaction time, after the channel is bound) ──

  it('tasterState.spent: false under the limit, true at/over it', async () => {
    const gid = await maybeTasterServe(db, waMsg());
    const shadowId = (
      await db
        .selectFrom('external_identities')
        .select('user_id')
        .where('external_id', '=', 'whatsapp:+13475550100')
        .executeTakeFirstOrThrow()
    ).user_id;

    expect((await tasterState(db, gid!, shadowId)).spent).toBe(false); // 0 turns
    await seedBotTurns(db, gid!, 1);
    expect((await tasterState(db, gid!, shadowId)).spent).toBe(false); // 1 < 2
    await seedBotTurns(db, gid!, 1, 1); // a proactive nudge — must not count
    expect((await tasterState(db, gid!, shadowId)).spent).toBe(false); // still 1
    await seedBotTurns(db, gid!, 1);
    expect((await tasterState(db, gid!, shadowId)).spent).toBe(true); // 2 >= 2
  });

  it('tasterState.spent: a real (signed-up) user is never limited', async () => {
    const realId = await createUser(db, 'real_john', 'John');
    const g = await ensurePersonalGroup(db, realId);
    await seedBotTurns(db, g.id, 5); // well over the limit
    expect((await tasterState(db, g.id, realId)).spent).toBe(false);
  });
});
