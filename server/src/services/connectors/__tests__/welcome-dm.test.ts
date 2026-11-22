/**
 * Welcome-DM gate: a Telegram user must pair from the app first. Until
 * then the bot only replies with a one-shot signup nudge (cooldown
 * gated). Paired (real) users pass through to the normal pipeline.
 *
 * Pins:
 *   - Unknown DM → one nudge sent + greeted row written; returns true
 *     (so the inbound pipeline treats the message as handled and does
 *     not persist a Chord message).
 *   - Group/channel message from an unbound chat → silent (welcome-dm
 *     only fires for private chats).
 *   - Second DM within cooldown → no second nudge (still returns true
 *     so the inbound pipeline drops the message).
 *   - `/start` always re-greets.
 *   - Paired real user → returns false (caller handles auto-bind +
 *     normal pipeline). No DM here.
 *   - WELCOME_DM_ENABLED=false → returns false (legacy silent drop).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import {
  __testing,
  maybeAnnounceShadowSignupInGroup,
  maybeWelcomeStranger,
} from '@/services/connectors/welcome-dm.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('welcome-dm: app-first gate', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;
  let savedSignupUrl: string;
  let savedEnabled: boolean;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    savedSignupUrl = env.SIGNUP_URL;
    savedEnabled = env.WELCOME_DM_ENABLED;
    savedAuthMode = env.AUTH_MODE;
    (env as { SIGNUP_URL: string }).SIGNUP_URL = 'https://example.test/signup';
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = true;
    // Nudge behavior is google-mode only; demo mode auto-provisions
    // instead (covered by the demo describe block below).
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { SIGNUP_URL: string }).SIGNUP_URL = savedSignupUrl;
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = savedEnabled;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('unknown DM → one nudge sent + greeted row + returns true', async () => {
    await conn.injectInbound({
      externalChannelId: '11',
      externalUserId: '11',
      text: 'hi',
      isPrivate: true,
    });
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].text).toMatch(/sign in, or create an account/i);
    expect(conn.sent[0].text).toContain('https://example.test/signup');
    // ADR 0031 / 0053: the welcome link carries a referrer token on a
    // claimed `/welcome/<ref>` deep-link path (ADR 0048) so the user can
    // sign up without pasting a pair code and the link opens the app.
    expect(conn.sent[0].text).toMatch(/\/welcome\/[A-Za-z0-9_-]{8,}/);
    expect(conn.sent[0].text).toMatch(/automatically|mirroring/i);
    const row = await db
      .selectFrom('connector_dm_greeted')
      .selectAll()
      .where('external_user_id', '=', '11')
      .executeTakeFirst();
    expect(row).toBeDefined();
    // And a signup_intents row should exist for this TG id.
    const intent = await db
      .selectFrom('signup_intents')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_user_id', '=', '11')
      .executeTakeFirst();
    expect(intent).toBeDefined();
    expect(intent?.consumed_at).toBeNull();
  });

  it('second DM within cooldown → no second nudge', async () => {
    await conn.injectInbound({
      externalChannelId: '5',
      externalUserId: '5',
      text: 'hi',
      isPrivate: true,
    });
    await conn.injectInbound({
      externalChannelId: '5',
      externalUserId: '5',
      text: 'still there?',
      isPrivate: true,
    });
    expect(conn.sent).toHaveLength(1);
  });

  it('/start always re-greets', async () => {
    await conn.injectInbound({
      externalChannelId: '6',
      externalUserId: '6',
      text: 'hi',
      isPrivate: true,
    });
    await conn.injectInbound({
      externalChannelId: '6',
      externalUserId: '6',
      text: '/start',
      isPrivate: true,
    });
    expect(conn.sent).toHaveLength(2);
  });

  it('group/channel message from unbound chat → silent', async () => {
    await conn.injectInbound({
      externalChannelId: '-1001',
      externalUserId: '7',
      text: 'random group chatter',
      isPrivate: false,
    });
    expect(conn.sent).toHaveLength(0);
  });

  it('paired real user → no DM (returns false; caller handles pipeline)', async () => {
    // Seed a real user + identity.
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_real',
        username: 'alice',
        display_name: 'Alice',
        created_at: now,
        shadow: 0,
        google_sub: 'sub_alice',
        email: 'alice@example.test',
        email_verified: 1,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '42',
        external_display: 'Alice',
        user_id: 'u_real',
        created_at: now,
      })
      .execute();

    const result = await maybeWelcomeStranger(db, {
      platform: 'telegram',
      externalChannelId: '42',
      externalChannelDisplay: null,
      externalUserId: '42',
      externalUserDisplay: 'Alice',
      externalMessageId: 'm1',
      text: 'hi',
      ts: new Date(),
      mentionsBot: false,
      mentionsOthers: false,
      receivedByBotUserId: null,
      isPrivate: true,
      raw: null,
    });
    expect(result).toBe(false);
    expect(conn.sent).toHaveLength(0);
  });

  it('WELCOME_DM_ENABLED=false → silent drop', async () => {
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = false;
    await conn.injectInbound({
      externalChannelId: '8',
      externalUserId: '8',
      text: 'hi',
      isPrivate: true,
    });
    expect(conn.sent).toHaveLength(0);
  });
});

describe('WhatsApp taster-spent nudge (ADR 0053)', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;
  let savedSignupUrl: string;
  let savedEnabled: boolean;
  let savedAuthMode: 'google' | 'demo';

  function waMsg(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'whatsapp' as const,
      externalChannelId: 'whatsapp:+13475550100',
      externalChannelDisplay: null,
      externalUserId: 'whatsapp:+13475550100',
      externalUserDisplay: 'Tester',
      externalMessageId: 'm1',
      text: 'hi',
      ts: new Date(),
      mentionsBot: false,
      mentionsOthers: false,
      receivedByBotUserId: null,
      isPrivate: true,
      raw: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'whatsapp');
    connectorRegistry.register(conn);
    savedSignupUrl = env.SIGNUP_URL;
    savedEnabled = env.WELCOME_DM_ENABLED;
    savedAuthMode = env.AUTH_MODE;
    (env as { SIGNUP_URL: string }).SIGNUP_URL = 'https://chordapp.ai';
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = true;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { SIGNUP_URL: string }).SIGNUP_URL = savedSignupUrl;
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = savedEnabled;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('renderWelcome(whatsapp) → account-gate copy with a /welcome/ link', () => {
    const text = __testing.renderWelcome('tok_abcdefgh1234', 'whatsapp');
    // Not a paywall, and it has to work for someone who already has Chord.
    expect(text).toMatch(/connected to a Chord account/i);
    expect(text).toMatch(/already have one/i);
    expect(text).not.toMatch(/quota/i);
    expect(text).toMatch(/https:\/\/chordapp\.ai\/welcome\/tok_abcdefgh1234/);
    expect(text).not.toMatch(/sign up/i);
  });

  it('alwaysSend=true → re-nudges on every message (cooldown bypassed)', async () => {
    await maybeWelcomeStranger(db, waMsg(), { alwaysSend: true });
    await maybeWelcomeStranger(db, waMsg({ text: 'still there?' }), {
      alwaysSend: true,
    });
    expect(conn.sent).toHaveLength(2);
    expect(conn.sent[0].text).toMatch(/connected to a Chord account/i);
    expect(conn.sent[1].text).toMatch(/connected to a Chord account/i);
  });

  it('default (no alwaysSend) → still cooldown-gated to one nudge', async () => {
    await maybeWelcomeStranger(db, waMsg());
    await maybeWelcomeStranger(db, waMsg({ text: 'again' }));
    expect(conn.sent).toHaveLength(1);
  });
});

describe('maybeAnnounceShadowSignupInGroup: shadow user in bound group', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;
  let savedEnabled: boolean;
  let savedAuthMode: 'google' | 'demo';
  let savedSignupUrl: string;

  async function seedShadowInBoundGroup(
    tgUserId: string,
    chatId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_owner',
        username: 'owner',
        display_name: 'Owner',
        created_at: now,
        shadow: 0,
        google_sub: 'sub_owner',
        email: 'owner@example.test',
        email_verified: 1,
      })
      .execute();
    const group = await createGroup(db, {
      name: 'Bound Group',
      kind: 'group',
      createdBy: 'u_owner',
    });
    await bindChannel(db, 'telegram', chatId, group.id, 'telegram');
    await db
      .insertInto('users')
      .values({
        id: `u_shadow_${tgUserId}`,
        username: `tg_${tgUserId}`,
        display_name: `Shadow ${tgUserId}`,
        created_at: now,
        shadow: 1,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: tgUserId,
        external_display: `Shadow ${tgUserId}`,
        user_id: `u_shadow_${tgUserId}`,
        created_at: now,
      })
      .execute();
  }

  function shadowMsg(tgUserId: string, chatId: string) {
    return {
      platform: 'telegram' as const,
      externalChannelId: chatId,
      externalChannelDisplay: null,
      externalUserId: tgUserId,
      externalUserDisplay: `Shadow ${tgUserId}`,
      externalMessageId: 'm1',
      text: '@chord hi',
      ts: new Date(),
      mentionsBot: true,
      mentionsOthers: false,
      receivedByBotUserId: null,
      isPrivate: false,
      raw: null,
    };
  }

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    savedEnabled = env.WELCOME_DM_ENABLED;
    savedAuthMode = env.AUTH_MODE;
    savedSignupUrl = env.SIGNUP_URL;
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = true;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
    (env as { SIGNUP_URL: string }).SIGNUP_URL = 'https://example.test/signup';
  });

  afterEach(async () => {
    (env as { WELCOME_DM_ENABLED: boolean }).WELCOME_DM_ENABLED = savedEnabled;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    (env as { SIGNUP_URL: string }).SIGNUP_URL = savedSignupUrl;
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('first invocation by shadow user → in-group signup notice posted', async () => {
    await seedShadowInBoundGroup('77', '-1001');
    const sent = await maybeAnnounceShadowSignupInGroup(
      db,
      shadowMsg('77', '-1001'),
    );
    expect(sent).toBe(true);
    expect(conn.sent).toHaveLength(1);
    // Notice goes to the GROUP chat, not the user's DM id.
    expect(conn.sent[0].externalChannelId).toBe('-1001');
    expect(conn.sent[0].text).toMatch(/sign in, or create an account/i);
    expect(conn.sent[0].text).toMatch(/personal chat/i);
    // ADR 0029 — a "Connect to Chord" URL action card rides along so
    // TG renders an inline-keyboard button. The label avoids "sign up":
    // a shadow in a shared group may already have an account.
    const signupCard = conn.sent[0].cards.find(
      (c) => c.kind === 'action' && c.url === 'https://example.test/signup',
    );
    expect(signupCard).toBeDefined();
    expect(signupCard?.title).toMatch(/connect to chord/i);
  });

  it('second invocation within cooldown → no second notice', async () => {
    await seedShadowInBoundGroup('77', '-1001');
    await maybeAnnounceShadowSignupInGroup(db, shadowMsg('77', '-1001'));
    const second = await maybeAnnounceShadowSignupInGroup(
      db,
      shadowMsg('77', '-1001'),
    );
    expect(second).toBe(false);
    expect(conn.sent).toHaveLength(1);
  });

  it('shadow user without bot @-mention → no notice (ambient message)', async () => {
    await seedShadowInBoundGroup('77', '-1001');
    const msg = { ...shadowMsg('77', '-1001'), mentionsBot: false };
    const sent = await maybeAnnounceShadowSignupInGroup(db, msg);
    expect(sent).toBe(false);
    expect(conn.sent).toHaveLength(0);
  });

  it('paired (non-shadow) sender invoking bot → no notice', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_real',
        username: 'real',
        display_name: 'Real',
        created_at: now,
        shadow: 0,
        google_sub: 'sub_real',
        email: 'real@example.test',
        email_verified: 1,
      })
      .execute();
    const group = await createGroup(db, {
      name: 'Bound Group',
      kind: 'group',
      createdBy: 'u_real',
    });
    await bindChannel(db, 'telegram', '-1002', group.id, 'telegram');
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '88',
        external_display: 'Real',
        user_id: 'u_real',
        created_at: now,
      })
      .execute();
    await maybeAnnounceShadowSignupInGroup(db, shadowMsg('88', '-1002'));
    expect(conn.sent).toHaveLength(0);
  });

  it('private DM (isPrivate=true) → skip (DM path handles its own welcome)', async () => {
    await seedShadowInBoundGroup('77', '-1001');
    const msg = { ...shadowMsg('77', '-1001'), isPrivate: true };
    await maybeAnnounceShadowSignupInGroup(db, msg);
    expect(conn.sent).toHaveLength(0);
  });

  it('connector send fails → cooldown still marked, no retry', async () => {
    await seedShadowInBoundGroup('77', '-1001');
    conn.failNextSends = 1;
    await maybeAnnounceShadowSignupInGroup(db, shadowMsg('77', '-1001'));
    await maybeAnnounceShadowSignupInGroup(db, shadowMsg('77', '-1001'));
    // Only the first attempt fires; the second is suppressed by cooldown.
    expect(conn.failedSendAttempts).toBe(1);
    expect(conn.sent).toHaveLength(0);
  });
});

describe('demo-mode auto-provision (AUTH_MODE=demo)', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    savedAuthMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'demo';
  });

  afterEach(async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('unknown DM → no nudge; real user + personal group + DM bound', async () => {
    await conn.injectInbound({
      externalChannelId: '50',
      externalUserId: '50',
      externalUserDisplay: 'Demo Dev',
      text: 'hello there',
      isPrivate: true,
    });
    // No nudge — the bot may have replied (always-on personal group),
    // but the welcome-DM signup nudge must not have fired.
    expect(conn.sent.every((s) => !/sign up/i.test(s.text))).toBe(true);

    const ident = await db
      .selectFrom('external_identities')
      .innerJoin('users', 'users.id', 'external_identities.user_id')
      .select(['users.id as user_id', 'users.shadow as shadow'])
      .where('external_identities.platform', '=', 'telegram')
      .where('external_identities.external_id', '=', '50')
      .executeTakeFirst();
    expect(ident).toBeDefined();
    expect(ident?.shadow).toBe(0);

    const personal = await db
      .selectFrom('groups')
      .select(['id'])
      .where('kind', '=', 'personal')
      .where('created_by', '=', ident!.user_id)
      .executeTakeFirst();
    expect(personal).toBeDefined();

    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('external_channel_id', '=', '50')
      .executeTakeFirst();
    expect(binding?.group_id).toBe(personal!.id);
  });
});
