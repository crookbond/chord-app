/**
 * ADR 0313 — an attached Gmail's calendar follows the scopes Google reports
 * on each token refresh, so a mailbox connected before calendars existed (and
 * whose grant already carries the calendar) gets its calendar at the next mail
 * sync with no reconnect. Google is faked at the fetch boundary; the token
 * refresh itself is real.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { sealAuthBlob, type AccountRow } from '@/services/email-accounts/account-utils.js';
import { gmailAccountApi } from '@/services/email-accounts/gmail-account.service.js';
import { gmailCalendarKey } from '@/services/gmail-calendar/ids.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { _resetAccessTokenReuseForTests } from '@/utils/access-token-cache.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';

type MutableEnv = Record<string, unknown>;
const saved = {
  GMAIL_PROVIDER: env.GMAIL_PROVIDER,
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  MASTER_KEY: process.env.MASTER_KEY,
};

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Google, answering a token refresh with `scope`, and an account's calendar list. */
function stubGoogle(scope: string): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return res({ access_token: 'acct-token', expires_in: 3600, scope, token_type: 'Bearer' });
      }
      if (u.includes('/users/me/calendarList')) {
        return res({ items: [{ id: 'second@gmail.example', summary: 'second@gmail.example', primary: true, accessRole: 'owner' }] });
      }
      return res({ items: [], nextSyncToken: 'S0' });
    }),
  );
  return urls;
}

let db: Kysely<DB>;
let userId: string;
let account: AccountRow;

async function seedAccount(calendarEnabled: number): Promise<AccountRow> {
  const id = newId('ema');
  const now = new Date().toISOString();
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider: 'gmail',
      email_address: 'second@gmail.example',
      display_name: 'Second',
      preset_key: null,
      // A fresh refresh token per test so the token cache never answers.
      ...sealAuthBlob({ refreshToken: `refresh-${id}`, clientId: 'web-client' }),
      sync_cursor: null,
      synced_at: null,
      status: 'ok',
      calendar_enabled: calendarEnabled,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await db.selectFrom('email_accounts').selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as AccountRow;
}

const calendarState = () =>
  db
    .selectFrom('email_accounts')
    .select(['calendar_enabled', 'calendar_default_id'])
    .where('id', '=', account.id)
    .executeTakeFirstOrThrow();

beforeEach(async () => {
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
  Object.assign(env as unknown as MutableEnv, {
    GMAIL_PROVIDER: 'real',
    GOOGLE_CLIENT_ID: 'web-client',
    GOOGLE_CLIENT_SECRET: 'web-secret',
  });
  _resetAccessTokenReuseForTests();
  db = await openTestDb();
  userId = await createUser(db, 'twogmails');
});

afterEach(async () => {
  await settleBackgroundWork();
  vi.unstubAllGlobals();
  Object.assign(env as unknown as MutableEnv, {
    GMAIL_PROVIDER: saved.GMAIL_PROVIDER,
    GOOGLE_CLIENT_ID: saved.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: saved.GOOGLE_CLIENT_SECRET,
  });
  if (saved.MASTER_KEY === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = saved.MASTER_KEY;
  await closeTestDb(db);
});

describe("an attached Gmail's calendar follows its grant", () => {
  it('switches on at the next mail sync for a mailbox connected before calendars, with no reconnect', async () => {
    account = await seedAccount(0);
    const urls = stubGoogle(`openid email ${GMAIL} ${CALENDAR}`);

    await gmailAccountApi(db, account);
    await settleBackgroundWork();

    expect(await calendarState()).toEqual({
      calendar_enabled: 1,
      calendar_default_id: gmailCalendarKey(account.id, 'second@gmail.example'),
    });
    expect(urls.some((u) => u.includes('/users/me/calendarList'))).toBe(true);
  });

  it('stays mail-only when the grant has no calendar', async () => {
    account = await seedAccount(0);
    const urls = stubGoogle(`openid email ${GMAIL}`);

    await gmailAccountApi(db, account);
    await settleBackgroundWork();

    expect((await calendarState()).calendar_enabled).toBe(0);
    expect(urls.some((u) => u.includes('calendar'))).toBe(false);
  });

  it('switches off, and forgets what it pulled, when calendar access was removed in Google', async () => {
    account = await seedAccount(1);
    const key = gmailCalendarKey(account.id, 'second@gmail.example');
    await db.updateTable('email_accounts').set({ calendar_default_id: key }).where('id', '=', account.id).execute();
    const now = new Date().toISOString();
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: userId,
        provider: 'google',
        google_calendar_id: key,
        summary: 'second@gmail.example',
        access_role: 'owner',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 1,
        first_seen_at: now,
        last_seen_at: now,
      } as never)
      .execute();
    stubGoogle(`openid email ${GMAIL}`);

    await gmailAccountApi(db, account);
    await settleBackgroundWork();

    expect(await calendarState()).toEqual({ calendar_enabled: 0, calendar_default_id: null });
    const sources = await db.selectFrom('calendar_sources').select('id').where('user_id', '=', userId).execute();
    expect(sources).toHaveLength(0);
  });
});
