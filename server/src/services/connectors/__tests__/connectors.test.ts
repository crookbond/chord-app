/**
 * Phase 1 scaffolding tests for the IM connector subsystem (ADR 0010).
 *
 * Drives the inbound and outbound paths through `MockConnector` against a
 * per-test Postgres database. The mock LLM provider replies with a canned
 * text fence — enough to validate that bot replies fan out via the outbound
 * publisher to the connector's `send`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSE } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  bindChannel,
  listBindingsForGroup,
  lookupGroupForChannel,
  unbindChannel,
} from '@/services/connectors/channel-resolver.js';
import { resolveIdentity } from '@/services/connectors/identity-resolver.js';
import { awaitPendingBotReactions } from '@/services/bot/bot.service.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { startOutboundPublisher } from '@/services/connectors/outbound-publisher.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seedGroup(db: Kysely<DB>): Promise<{ groupId: string; ownerId: string }> {
  const ownerId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({
      id: ownerId,
      username: `owner_${ownerId.slice(2)}`,
      display_name: 'Owner',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Bridged Group',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `bridged-${groupId.slice(2)}@chord.app`,
      created_by: ownerId,
      adults_only: 0,
      mirror_inbound: 1,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: ownerId,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();
  return { groupId, ownerId };
}

describe('connector scaffolding', () => {
  let db: Kysely<DB>;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    // Pin google — the unbound-channel drop test asserts a google-mode
    // invariant. Under demo, the pipeline auto-provisions + binds.
    savedAuthMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await awaitPendingBotReactions();
    await closeTestDb(db);
  });

  describe('identity-resolver', () => {
    it('first sighting creates a shadow user; second returns same id', async () => {
      const id1 = await resolveIdentity(db, 'slack', 'U123', 'Alex');
      const id2 = await resolveIdentity(db, 'slack', 'U123', 'Alex');
      expect(id1).toBe(id2);
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id1)
        .executeTakeFirstOrThrow();
      expect(user.shadow).toBe(1);
      expect(user.display_name).toBe('Alex');
      expect(user.username).toBe('slack_u123');
    });

    it('refreshes shadow user display_name when external_display changes', async () => {
      // Without this sync the Chord client would render the raw user id
      // (e.g. "u_abc123") because the shadow user's display_name was
      // stale relative to the latest inbound name from the platform.
      const id1 = await resolveIdentity(db, 'discord', '999', 'Old Name');
      await resolveIdentity(db, 'discord', '999', 'New Name');
      const user = await db
        .selectFrom('users')
        .select(['display_name', 'shadow'])
        .where('id', '=', id1)
        .executeTakeFirstOrThrow();
      expect(user.shadow).toBe(1);
      expect(user.display_name).toBe('New Name');
      const ident = await db
        .selectFrom('external_identities')
        .select('external_display')
        .where('platform', '=', 'discord')
        .where('external_id', '=', '999')
        .executeTakeFirstOrThrow();
      expect(ident.external_display).toBe('New Name');
    });

    it('platforms are namespaced — same external_id on two platforms is two users', async () => {
      const slackId = await resolveIdentity(db, 'slack', '1', 'A');
      const discordId = await resolveIdentity(db, 'discord', '1', 'A');
      expect(slackId).not.toBe(discordId);
    });
  });

  describe('channel-resolver', () => {
    it('bind / lookup / unbind round-trip', async () => {
      const { groupId } = await seedGroup(db);
      expect(await lookupGroupForChannel(db, 'slack', 'C123')).toBeNull();

      await bindChannel(db, 'slack', 'C123', groupId, 'slack', '{"workspace":"T1"}');
      expect(await lookupGroupForChannel(db, 'slack', 'C123')).toBe(groupId);

      const bindings = await listBindingsForGroup(db, groupId);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        platform: 'slack',
        externalChannelId: 'C123',
        groupId,
      });

      const removed = await unbindChannel(db, 'slack', 'C123');
      expect(removed).toBe(true);
      expect(await lookupGroupForChannel(db, 'slack', 'C123')).toBeNull();
    });

    it('rebinding the same channel updates the group', async () => {
      const { groupId: g1 } = await seedGroup(db);
      const { groupId: g2 } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C99', g1, 'slack');
      await bindChannel(db, 'slack', 'C99', g2, 'slack');
      expect(await lookupGroupForChannel(db, 'slack', 'C99')).toBe(g2);
    });

    it('binding to an unknown group throws', async () => {
      await expect(bindChannel(db, 'slack', 'C1', 'g_missing', 'slack')).rejects.toThrow();
    });
  });

  describe('inbound-pipeline (via MockConnector)', () => {
    it('drops messages from unbound channels', async () => {
      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_unbound',
        externalUserId: 'U1',
        text: 'hello',
      });
      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(0);
    });

    it('bound channel: posts message, creates shadow user + guest membership', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_bound',
        externalUserId: 'U_alex',
        externalUserDisplay: 'Alex',
        externalMessageId: 'slack-msg-1',
        text: 'hello from slack',
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        group_id: groupId,
        kind: 'text',
        body: 'hello from slack',
        source: 'slack',
        external_message_id: 'slack-msg-1',
        mentions_bot: 0,
      });

      const sender = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', msgs[0].sender_id!)
        .executeTakeFirstOrThrow();
      expect(sender.shadow).toBe(1);
      expect(sender.display_name).toBe('Alex');

      const member = await db
        .selectFrom('group_members')
        .selectAll()
        .where('group_id', '=', groupId)
        .where('user_id', '=', sender.id)
        .executeTakeFirstOrThrow();
      expect(member.tier).toBe('guest');
      expect(member.role).toBe('member');
    });

    it('mirror_inbound=0: drops external non-bot-mention messages entirely', async () => {
      const { groupId } = await seedGroup(db);
      await db
        .updateTable('groups')
        .set({ mirror_inbound: 0 })
        .where('id', '=', groupId)
        .execute();
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_bound',
        externalUserId: 'U_alex',
        text: 'a regular telegram message',
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(0);
    });

    it('mirror_inbound=1 + bot-only mention: persists chord_visible=1', async () => {
      // A bot-only message is still posted in the shared connector channel,
      // so every member there already saw it. A mirroring group surfaces
      // the bot exchange on the Chord side too rather than hiding it.
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_bound',
        externalUserId: 'U_alex',
        text: '@chord save this',
        mentionsBot: true,
        mentionsOthers: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].chord_visible).toBe(1);
    });

    it('mirror_inbound=0 + bot-only mention: persists chord_visible=0', async () => {
      // Clean-mirror groups still hide bot chatter on the Chord surface.
      const { groupId } = await seedGroup(db);
      await db
        .updateTable('groups')
        .set({ mirror_inbound: 0 })
        .where('id', '=', groupId)
        .execute();
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_bound',
        externalUserId: 'U_alex',
        text: '@chord save this',
        mentionsBot: true,
        mentionsOthers: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].chord_visible).toBe(0);
    });

    it('mirror_inbound=1 + bot+others mention: persists chord_visible=1', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      await conn.injectInbound({
        externalChannelId: 'C_bound',
        externalUserId: 'U_alex',
        text: '@chord @alice please confirm',
        mentionsBot: true,
        mentionsOthers: true,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].chord_visible).toBe(1);
      expect(msgs[0].mentions_others).toBe(1);
    });

    it('honours the precomputed mentionsBot flag (no @chord literal in body)', async () => {
      // Use postMessage directly so we exercise the precomputed-flag path
      // without triggering the bot turn (which is fire-and-forget and can
      // outlive the test's in-memory db).
      const { groupId, ownerId } = await seedGroup(db);
      const { postMessage } = await import('@/services/messages.service.js');

      const native = await postMessage(db, {
        groupId,
        senderId: ownerId,
        body: 'hey <@U_BOT> what time is it',
      });
      expect(native.mentionsBot).toBe(false);

      const withFlag = await postMessage(db, {
        groupId,
        senderId: ownerId,
        body: 'hey <@U_BOT> what time is it',
        mentionsBot: true,
      });
      expect(withFlag.mentionsBot).toBe(true);

      const negated = await postMessage(db, {
        groupId,
        senderId: ownerId,
        body: '@chord please ignore me here',
        mentionsBot: false,
      });
      expect(negated.mentionsBot).toBe(false);
    });

    it('repeated inbound from the same external user does not duplicate membership', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      for (let i = 0; i < 3; i++) {
        await conn.injectInbound({
          externalChannelId: 'C_bound',
          externalUserId: 'U_alex',
          text: `msg ${i}`,
        });
      }
      const memberCount = await db
        .selectFrom('group_members')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      // owner + 1 shadow guest
      expect(Number(memberCount.n)).toBe(2);
    });
  });

  describe('sseHub.onBroadcast', () => {
    it('fires after broadcast and returns an unsubscribe', () => {
      const seen: Array<[string, string]> = [];
      const unsub = sseHub.onBroadcast((channel, event) => {
        seen.push([channel, event]);
      });
      sseHub.broadcast('grp1', SSE.botDone, { messageId: 'm1' });
      sseHub.broadcast('grp2', SSE.botDone, { messageId: 'm2' });
      unsub();
      sseHub.broadcast('grp3', SSE.botDone, { messageId: 'm3' });
      expect(seen).toEqual([
        ['grp1', SSE.botDone],
        ['grp2', SSE.botDone],
      ]);
    });

    it('listener exception does not abort the broadcast', () => {
      const calls: string[] = [];
      const unsub1 = sseHub.onBroadcast(() => {
        throw new Error('boom');
      });
      const unsub2 = sseHub.onBroadcast((_c, event) => {
        calls.push(event);
      });
      expect(() => sseHub.broadcast('g', SSE.botDone, { messageId: 'm' })).not.toThrow();
      unsub1();
      unsub2();
      expect(calls).toEqual([SSE.botDone]);
    });
  });

  describe('outbound-publisher', () => {
    // ADR 0053's taster footer needs a non-empty SIGNUP_URL (buildSignupLink
    // returns '' otherwise, and a '' link means no footer — see taster.ts).
    // .env/.env.local are gitignored and absent on a fresh checkout, so the
    // taster tests below must not depend on whatever's ambient; pin both
    // knobs explicitly and restore them, matching welcome-dm.test.ts.
    let savedSignupUrl: string;
    let savedTasterTurns: number;
    beforeEach(() => {
      savedSignupUrl = env.SIGNUP_URL;
      savedTasterTurns = env.WHATSAPP_TASTER_TURNS;
      (env as { SIGNUP_URL: string }).SIGNUP_URL = 'https://chordapp.ai';
      (env as { WHATSAPP_TASTER_TURNS: number }).WHATSAPP_TASTER_TURNS = 5;
    });
    afterEach(() => {
      (env as { SIGNUP_URL: string }).SIGNUP_URL = savedSignupUrl;
      (env as { WHATSAPP_TASTER_TURNS: number }).WHATSAPP_TASTER_TURNS = savedTasterTurns;
    });

    it('bot replies are forwarded to bound channels via connector.send', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id: 'm_bot',
          groupId,
          senderId: null,
          kind: 'bot',
          body: 'hello back',
          mentionsBot: false,
          createdAt: new Date().toISOString(),
        });
        // forward is async; the publisher does a DB lookup per event,
        // a real PG round-trip. Poll until the send lands.
        await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
        expect(conn.sent[0]).toMatchObject({
          externalChannelId: 'C_bound',
          text: 'hello back',
        });
      } finally {
        stop();
      }
    });

    it('a WhatsApp taster reply carries the connect prompt (ADR 0053)', async () => {
      // The ask must ride the answers, so the turn number the footer keys on
      // has to COUNT the reply going out — off by one and it lands on the
      // wrong turns, or never.
      const shadowId = newId('u');
      const groupId = newId('g');
      const now = new Date().toISOString();
      await db
        .insertInto('users')
        .values({
          id: shadowId,
          username: `wa_${shadowId.slice(2)}`,
          display_name: 'Stranger',
          created_at: now,
          shadow: 1,
        })
        .execute();
      await db
        .insertInto('groups')
        .values({
          id: groupId,
          name: 'Personal',
          kind: 'personal',
          invite_code: groupId.slice(2, 8).toUpperCase(),
          created_by: shadowId,
          created_at: now,
          ingest_email: `g-${Math.abs(Date.now() % 100000)}@chord.test`,
          adults_only: 0,
          mirror_inbound: 0,
        })
        .execute();
      await bindChannel(db, 'whatsapp', 'whatsapp:+15550001111', groupId, 'whatsapp');
      // The first reply, already persisted — this IS turn 1.
      await db
        .insertInto('messages')
        .values({
          id: newId('m'),
          group_id: groupId,
          sender_id: null,
          kind: 'bot',
          body: 'here you go',
          mentions_bot: 0,
          mentions_others: 0,
          chord_visible: 1,
          auto_mirror: 1,
          created_at: now,
          is_proactive: 0,
        })
        .execute();

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id: 'm_bot',
          groupId,
          senderId: null,
          kind: 'bot',
          body: 'here you go',
          mentionsBot: false,
          createdAt: now,
        });
        await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
        expect(conn.sent[0].text).toContain('here you go');
        expect(conn.sent[0].text).toContain("I'm Chord");
      } finally {
        stop();
      }
    });

    it('a signed-up user never sees the taster prompt', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'whatsapp', 'whatsapp:+15550002222', groupId, 'whatsapp');

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id: 'm_bot2',
          groupId,
          senderId: null,
          kind: 'bot',
          body: 'here you go',
          mentionsBot: false,
          createdAt: new Date().toISOString(),
        });
        await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
        expect(conn.sent[0].text).toBe('here you go');
      } finally {
        stop();
      }
    });

    it('shared-group user text mirrors to bound channels (bi-directional)', async () => {
      // Post-app-first: shared groups fully mirror in both directions
      // so paired co-members see each other's Chord messages on TG.
      const { groupId, ownerId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id: 'm_user',
          groupId,
          senderId: ownerId,
          kind: 'text',
          body: 'a user message',
          mentionsBot: false,
          createdAt: new Date().toISOString(),
        });
        await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
        // ADR follow-up: outbound now prefixes human sender's display
        // name (Telegram/Slack/Discord bot APIs can't impersonate users).
        expect(conn.sent[0]).toMatchObject({
          externalChannelId: 'C_bound',
          text: 'Owner: a user message',
        });
      } finally {
        stop();
      }
    });

    it('auto_mirror=0 bot reply: skipped (used by relay target=chord)', async () => {
      const { groupId } = await seedGroup(db);
      await bindChannel(db, 'slack', 'C_bound', groupId, 'slack');

      // Persist a bot row with auto_mirror=0, then broadcast SSE.message
      // for it. Outbound publisher should skip on the row's flag, not
      // forward to the binding.
      const id = 'm_relay_chord';
      await db
        .insertInto('messages')
        .values({
          id,
          group_id: groupId,
          sender_id: null,
          kind: 'bot',
          body: 'Alice (from telegram) asked me to share: hi',
          attachment_id: null,
          reply_to_id: null,
          mentions_bot: 0,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: 1,
          mentions_others: 0,
          auto_mirror: 0,
          bot_persona_id: null,
          is_proactive: 0,
        })
        .execute();

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id,
          groupId,
          senderId: null,
          kind: 'bot',
          body: 'Alice (from telegram) asked me to share: hi',
          mentionsBot: false,
          createdAt: new Date().toISOString(),
        });
        await new Promise((r) => setImmediate(r));
        expect(conn.sent).toHaveLength(0);
      } finally {
        stop();
      }
    });

    it('unbound group: no forward attempted', async () => {
      const { groupId } = await seedGroup(db);

      const conn = new MockConnector(db);
      const stop = startOutboundPublisher(db, { getForBinding: () => conn });
      try {
        sseHub.broadcast(groupId, SSE.message, {
          id: 'm_bot',
          groupId,
          senderId: null,
          kind: 'bot',
          body: 'no listener',
          mentionsBot: false,
          createdAt: new Date().toISOString(),
        });
        await new Promise((r) => setImmediate(r));
        expect(conn.sent).toHaveLength(0);
      } finally {
        stop();
      }
    });
  });
});
