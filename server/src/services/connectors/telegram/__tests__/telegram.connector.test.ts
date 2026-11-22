/**
 * TelegramConnector tests.
 *
 * Avoid running the live `runLoop`: tests pre-seed `botUsername` /
 * `botUserId` via the constructor and call `pollOnce` directly. fetch
 * is mocked per test so no network calls escape.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { awaitPendingBotReactions } from '@/services/bot/bot.service.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { TelegramConnector } from '@/services/connectors/telegram/telegram.connector.js';
import type {
  TgMessage,
  TgUpdate,
} from '@/services/connectors/telegram/telegram.api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const TOKEN = 'tg-test-token';
const BOT_USERNAME = 'chord_bot';
const BOT_USER_ID = 9001;

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
      name: 'TG Group',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `tg-${groupId.slice(2)}@chord.app`,
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

function makeConnector(db: Kysely<DB>): TelegramConnector {
  return new TelegramConnector({
    token: TOKEN,
    db,
    botUsername: BOT_USERNAME,
    botUserId: BOT_USER_ID,
    longPollTimeoutSeconds: 0,
  });
}

function buildMessage(partial: Partial<TgMessage> & { text: string; chatId: number }): TgMessage {
  const id = partial.message_id ?? Math.floor(Math.random() * 1_000_000);
  return {
    message_id: id,
    from: partial.from ?? {
      id: 12345,
      is_bot: false,
      first_name: 'Alex',
      username: 'alex',
    },
    chat: partial.chat ?? { id: partial.chatId, type: 'group' },
    date: partial.date ?? Math.floor(Date.now() / 1000),
    text: partial.text,
    entities: partial.entities,
  };
}

function tgOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function tgErr(error_code: number, description: string, retry_after?: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code,
      description,
      ...(retry_after ? { parameters: { retry_after } } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('TelegramConnector — pollOnce + handleUpdate', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    ({ groupId } = await seedGroup(db));
    await bindChannel(db, 'telegram', '-1001234567890', groupId, 'telegram');
    vi.restoreAllMocks();
    // Pin google — unbound-chat drop and stranger-in-group drops are
    // google-mode invariants. Under demo, unbound chats auto-provision +
    // bind (covered by welcome-dm.test.ts demo describe).
    savedAuthMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    vi.restoreAllMocks();
    await awaitPendingBotReactions();
    await closeTestDb(db);
  });

  it('group message with @bot mention is forwarded as InboundMessage', async () => {
    const text = `hey @${BOT_USERNAME} what's the time`;
    const update: TgUpdate = {
      update_id: 100,
      message: buildMessage({
        text,
        chatId: -1001234567890,
        message_id: 42,
        entities: [{ type: 'mention', offset: 4, length: 1 + BOT_USERNAME.length }],
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tgOk([update]));

    const conn = makeConnector(db);
    const consumed = await conn.pollOnce();
    expect(consumed).toBe(1);

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg).toMatchObject({
      group_id: groupId,
      source: 'telegram',
      external_message_id: '42',
      mentions_bot: 1,
      body: text,
    });
  });

  it('group message without bot mention is dropped from the bot turn but still posted', async () => {
    const text = 'small talk among humans';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 101,
          message: buildMessage({ text, chatId: -1001234567890, message_id: 43 }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(0);
  });

  it('substring mention (entities absent) still detected', async () => {
    const text = `hey @${BOT_USERNAME} ping`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 102,
          message: buildMessage({ text, chatId: -1001234567890, message_id: 44 }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(1);
  });

  it('text_mention by user-id matches even without @username', async () => {
    const text = 'hey there bot';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 103,
          message: buildMessage({
            text,
            chatId: -1001234567890,
            message_id: 45,
            entities: [
              {
                type: 'text_mention',
                offset: 4,
                length: 5,
                user: {
                  id: BOT_USER_ID,
                  is_bot: true,
                  first_name: 'Chord',
                  username: BOT_USERNAME,
                },
              },
            ],
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(1);
  });

  it('private chat is auto-mention even without @-prefix', async () => {
    await bindChannel(db, 'telegram', '11111', groupId, 'telegram-private');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 104,
          message: buildMessage({
            text: 'just talking',
            chatId: 11111,
            message_id: 46,
            chat: { id: 11111, type: 'private' },
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msg = await db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.mentions_bot).toBe(1);
  });

  it('message from a bot (is_bot=true) is dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 105,
          message: buildMessage({
            text: 'hello from another bot',
            chatId: -1001234567890,
            message_id: 47,
            from: {
              id: 7777,
              is_bot: true,
              first_name: 'OtherBot',
              username: 'otherbot',
            },
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('message from the bot itself (matching botUserId) is dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 106,
          message: buildMessage({
            text: 'I am the bot',
            chatId: -1001234567890,
            message_id: 48,
            from: {
              id: BOT_USER_ID,
              is_bot: false, // even if mis-flagged
              first_name: 'Chord',
              username: BOT_USERNAME,
            },
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('non-message updates (edited_message, channel_post) are skipped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 107,
          edited_message: buildMessage({
            text: 'edited',
            chatId: -1001234567890,
            message_id: 49,
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('inbound from unbound chat is dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 108,
          message: buildMessage({
            text: 'hi',
            chatId: -9999,
            message_id: 50,
          }),
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });

  it('offset advances past the highest update_id seen', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        tgOk([
          {
            update_id: 200,
            message: buildMessage({ text: 'a', chatId: -1001234567890, message_id: 1 }),
          },
          {
            update_id: 205,
            message: buildMessage({ text: 'b', chatId: -1001234567890, message_id: 2 }),
          },
        ]),
      )
      .mockResolvedValueOnce(tgOk([]));

    const conn = makeConnector(db);
    await conn.pollOnce();
    await conn.pollOnce();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondCall.offset).toBe(206);
  });

  it('empty text messages (file/photo only) are dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk([
        {
          update_id: 109,
          message: {
            message_id: 51,
            from: { id: 1, is_bot: false, first_name: 'Alex' },
            chat: { id: -1001234567890, type: 'group' },
            date: Math.floor(Date.now() / 1000),
            // no text — like a photo-only message
          },
        },
      ]),
    );

    const conn = makeConnector(db);
    await conn.pollOnce();

    const msgs = await db.selectFrom('messages').selectAll().execute();
    expect(msgs).toHaveLength(0);
  });
});

describe('TelegramConnector — send', () => {
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

  it('sendMessage ships HTML body with parse_mode=HTML', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk({
        message_id: 1,
        chat: { id: -1001234567890, type: 'group' },
        date: 0,
        text: 'reply',
      }),
    );
    const conn = makeConnector(db);
    await conn.send({ externalChannelId: '-1001234567890', body: 'reply', cards: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      chat_id: '-1001234567890',
      text: 'reply',
      parse_mode: 'HTML',
    });
    expect(body.reply_markup).toBeUndefined();
  });

  it('action card with URL becomes an inline-keyboard button', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk({
        message_id: 1,
        chat: { id: -1001234567890, type: 'group' },
        date: 0,
        text: 'ok',
      }),
    );
    const conn = makeConnector(db);
    await conn.send({
      externalChannelId: '-1001234567890',
      body: "Here's the spot on the map.",
      cards: [
        {
          kind: 'action',
          title: 'Open in Maps',
          url: 'https://maps.google.com/?q=Dos+Caminos',
        },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.parse_mode).toBe('HTML');
    // Body carries only the prose; the action card is now a button.
    expect(body.text).toBe("Here&#39;s the spot on the map.".replace('&#39;', "'"));
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[
        { text: 'Open in Maps', url: 'https://maps.google.com/?q=Dos+Caminos' },
      ]],
    });
    // No URL in the body itself → suppress the auto-link preview.
    expect(body.disable_web_page_preview).toBe(true);
  });

  it('save card without an action button renders as <b>title</b>: <a>url</a>', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tgOk({
        message_id: 1,
        chat: { id: -1001234567890, type: 'group' },
        date: 0,
        text: 'ok',
      }),
    );
    const conn = makeConnector(db);
    await conn.send({
      externalChannelId: '-1001234567890',
      body: 'Saved.',
      cards: [
        {
          kind: 'save',
          title: 'Instagram reel',
          url: 'https://instagram.com/reel/x',
        },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>Instagram reel</b>');
    expect(body.text).toContain('<a href="https://instagram.com/reel/x">');
    expect(body.reply_markup).toBeUndefined();
  });

  it('surfaces ok:false errors from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tgErr(403, 'bot was blocked'));
    const conn = makeConnector(db);
    await expect(
      conn.send({ externalChannelId: '11111', body: 'x', cards: [] }),
    ).rejects.toThrow(/bot was blocked/);
  });
});

describe('TelegramConnector — initialize via getMe', () => {
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

  it('initialize calls getMe when botUsername not pre-seeded, then shutdown stops loop', async () => {
    // 1. getMe; 2. first getUpdates (returns empty so loop iterates fast)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        tgOk({
          id: BOT_USER_ID,
          is_bot: true,
          first_name: 'Chord',
          username: BOT_USERNAME,
        }),
      )
      .mockResolvedValue(tgOk([]));

    const conn = new TelegramConnector({
      token: TOKEN,
      db,
      longPollTimeoutSeconds: 0,
    });
    await conn.initialize();
    // Let loop run a couple of iterations.
    await new Promise((r) => setTimeout(r, 10));
    await conn.shutdown();

    const firstCallUrl = fetchMock.mock.calls[0][0];
    expect(firstCallUrl).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });
});
