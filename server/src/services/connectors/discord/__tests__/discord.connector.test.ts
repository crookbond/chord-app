/**
 * DiscordConnector inbound + outbound tests.
 *
 * Uses `skipGateway: true` so we never spin up the WS state machine —
 * tests synthesize `MESSAGE_CREATE` directly via
 * `connector.handleMessageCreate(...)`. Gateway behaviour is covered
 * separately in `discord-gateway.test.ts`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { awaitPendingBotReactions } from '@/services/bot/bot.service.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { DiscordConnector } from '@/services/connectors/discord/discord.connector.js';
import type { DiscordMessageCreate } from '@/services/connectors/discord/discord-gateway.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const TOKEN = 'discord-test-token';
const BOT_USER_ID = '123456789012345678';

async function seedGroup(db: Kysely<DB>): Promise<{ groupId: string }> {
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
      name: 'Discord Group',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `discord-${groupId.slice(2)}@chord.app`,
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
  return { groupId };
}

function makeConnector(db: Kysely<DB>): DiscordConnector {
  return new DiscordConnector({
    token: TOKEN,
    db,
    botUserId: BOT_USER_ID,
    skipGateway: true,
  });
}

function buildMessage(
  partial: Partial<DiscordMessageCreate> & {
    channel_id: string;
    content: string;
  },
): DiscordMessageCreate {
  return {
    id: partial.id ?? `m_${Math.floor(Math.random() * 1e9)}`,
    channel_id: partial.channel_id,
    guild_id: partial.guild_id,
    author: partial.author ?? {
      id: 'u_alex',
      username: 'alex',
      discriminator: '0',
    },
    content: partial.content,
    mentions: partial.mentions ?? [],
    timestamp: partial.timestamp ?? new Date().toISOString(),
  };
}

describe('DiscordConnector — inbound dispatch', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    ({ groupId } = await seedGroup(db));
    await bindChannel(db, 'discord', 'C_GUILD', groupId, 'discord');
    vi.restoreAllMocks();
    // Unbound-channel drop is a google-mode invariant; under demo the
    // pipeline auto-provisions and binds.
    savedAuthMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    vi.restoreAllMocks();
    await awaitPendingBotReactions();
    await closeTestDb(db);
  });

  it('guild message with @bot in mentions[] is forwarded as InboundMessage', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_42',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'hey <@123456789012345678> what time is it',
        mentions: [{ id: BOT_USER_ID }],
      }),
    );

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg).toMatchObject({
      group_id: groupId,
      source: 'discord',
      external_message_id: 'msg_42',
      mentions_bot: 1,
    });
  });

  it('guild message without bot in mentions[] is posted but mentions_bot=0', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_43',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'hi everyone',
        mentions: [],
      }),
    );

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(0);
  });

  it('mention of a different user is NOT a self-mention', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_44',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'hey <@_someone_else>',
        mentions: [{ id: 'OTHER_USER_ID' }],
      }),
    );

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(0);
  });

  it('DM (no guild_id) is auto-mention even with empty mentions[]', async () => {
    await bindChannel(db, 'discord', 'C_DM', groupId, 'discord-dm');
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_45',
        channel_id: 'C_DM',
        // no guild_id
        content: 'just chatting',
        mentions: [],
      }),
    );

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(1);
  });

  it('messages from bot users (author.bot=true) are dropped', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_46',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'bot says hi',
        author: { id: 'OTHER_BOT', username: 'otherbot', bot: true },
        mentions: [{ id: BOT_USER_ID }],
      }),
    );

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('bot self-message (author.id matches botUserId) is dropped', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_47',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'I am the bot',
        author: { id: BOT_USER_ID, username: 'chord' },
        mentions: [],
      }),
    );

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('empty content is dropped (image-only / sticker)', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_48',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: '',
        mentions: [{ id: BOT_USER_ID }],
      }),
    );

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('inbound from unbound channel is dropped', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_49',
        channel_id: 'C_UNBOUND',
        guild_id: 'G1',
        content: 'hi',
        mentions: [{ id: BOT_USER_ID }],
      }),
    );

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('duplicate message id is dropped on second sighting', async () => {
    const conn = makeConnector(db);
    const m = buildMessage({
      id: 'msg_dupe',
      channel_id: 'C_GUILD',
      guild_id: 'G1',
      content: 'replay me',
      mentions: [{ id: BOT_USER_ID }],
    });
    await conn.handleMessageCreate(m);
    await conn.handleMessageCreate(m);

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(1);
  });

  it('display name uses username#discriminator when discriminator is non-zero', async () => {
    const conn = makeConnector(db);
    await conn.handleMessageCreate(
      buildMessage({
        id: 'msg_50',
        channel_id: 'C_GUILD',
        guild_id: 'G1',
        content: 'hello',
        author: { id: 'u_old', username: 'OldStyle', discriminator: '4242' },
        mentions: [],
      }),
    );

    const sender = await db
      .selectFrom('messages')
      .innerJoin('users', 'users.id', 'messages.sender_id')
      .select(['users.display_name as displayName'])
      .executeTakeFirstOrThrow();
    expect(sender.displayName).toBe('OldStyle#4242');
  });
});

describe('DiscordConnector — send', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await awaitPendingBotReactions();
    await closeTestDb(db);
  });

  it('send POSTs to /channels/{id}/messages with content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'm_out', channel_id: 'C1', content: 'hi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const conn = makeConnector(db);
    await conn.send({ externalChannelId: 'C1', body: 'hi', cards: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/C1/messages');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe(`Bot ${TOKEN}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ content: 'hi' });
  });

  it('send slices content over the 2000-char limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'x', channel_id: 'C1', content: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const conn = makeConnector(db);
    const long = 'a'.repeat(2500);
    await conn.send({ externalChannelId: 'C1', body: long, cards: [] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.content).toHaveLength(2000);
  });

  it('surfaces non-2xx errors with code + message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 50001, message: 'Missing Access' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const conn = makeConnector(db);
    await expect(conn.send({ externalChannelId: 'C_X', body: 'x', cards: [] })).rejects.toThrow(
      /Missing Access/,
    );
  });
});
