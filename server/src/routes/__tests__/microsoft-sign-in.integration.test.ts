/**
 * ADR 0293 — Sign in with Microsoft over the real app. Microsoft's token
 * endpoint and Graph are faked at the fetch boundary; every other request (the
 * test's own calls to the local server) passes through.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { deleteAccount } from '@/services/account.service.js';
import { getOutlookAccessToken } from '@/services/email-accounts/outlook-oauth.js';
import type { ExchangeResult } from '@/services/google/oauth.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { MICROSOFT_CONSUMER_TENANT } from '@/services/microsoft/microsoft-auth.service.js';
import { _resetAccessTokenReuseForTests } from '@/utils/access-token-cache.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

// Google's code exchange verifies a signed id_token; the consent route is
// exercised with the exchange itself faked.
const google = vi.hoisted(() => ({ result: null as ExchangeResult | null }));
vi.mock('@/services/google/oauth.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/google/oauth.service.js')>()),
  exchangeCode: vi.fn(async () => google.result),
}));

type MsEnv = {
  AUTH_MODE: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  MICROSOFT_SIGN_IN_ENABLED: boolean;
  OUTLOOK_PROVIDER: string;
};
const e = env as unknown as MsEnv;
const savedEnv = { ...e };
const savedMasterKey = process.env.MASTER_KEY;

const CLIENT_ID = 'ms-client-1';
const WORK_TENANT = '72f988bf-0000-4000-8000-000000000001';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
}

describe('POST /api/v1/auth/microsoft (ADR 0293)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tokenStatus: number;
  let claims: Record<string, unknown>;
  let graphMail: string;
  let scope: string;
  let tokenRequests: URLSearchParams[];

  const msClaims = (over: Record<string, unknown> = {}) => {
    const tid = (over.tid as string | undefined) ?? WORK_TENANT;
    return {
      iss: `https://login.microsoftonline.com/${tid}/v2.0`,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      tid,
      oid: 'oid-ann',
      sub: 'pairwise-sub',
      email: 'ann@contoso.com',
      name: 'Ann Lee',
      ...over,
    };
  };

  beforeEach(async () => {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
    _resetCryptoCacheForTests();
    e.AUTH_MODE = 'google';
    e.MS_CLIENT_ID = CLIENT_ID;
    e.MS_CLIENT_SECRET = 'ms-secret';
    e.MICROSOFT_SIGN_IN_ENABLED = true;
    e.OUTLOOK_PROVIDER = 'real';
    tokenStatus = 200;
    tokenRequests = [];
    claims = msClaims();
    graphMail = 'ann@contoso.com';
    scope = 'openid email profile offline_access User.Read Mail.ReadWrite Mail.Send';

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        tokenRequests.push(form);
        if (tokenStatus !== 200) {
          return new Response('{"error":"invalid_grant"}', { status: tokenStatus });
        }
        // Like Entra: a grant through the "Mobile and desktop" address
        // (chord://) belongs to a public client, which may not send a secret -
        // on the code or on its refresh token.
        const publicGrant =
          form.get('grant_type') === 'refresh_token'
            ? form.get('refresh_token')!.startsWith('ms-rt-pub')
            : !form.get('redirect_uri')!.startsWith('https://');
        if (publicGrant && form.has('client_secret')) {
          return Response.json(
            {
              error: 'invalid_request',
              error_description: "AADSTS90023: Public clients can't send a client secret.",
            },
            { status: 400 },
          );
        }
        if (!publicGrant && !form.has('client_secret')) {
          return Response.json({ error: 'invalid_client', error_description: 'AADSTS7000218' }, { status: 401 });
        }
        return Response.json({
          access_token: 'ms-at',
          refresh_token: publicGrant ? 'ms-rt-pub' : 'ms-rt-1',
          id_token: idToken(claims),
          scope,
          expires_in: 3600,
        });
      }
      if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) {
        return Response.json({ mail: graphMail, displayName: 'Ann Lee (Graph)' });
      }
      // The first mailbox sync: refused, so it ends quickly.
      if (url.startsWith('https://graph.microsoft.com/')) return new Response('{}', { status: 503 });
      return realFetch(input, init);
    });

    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    Object.assign(e, savedEnv);
    if (savedMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = savedMasterKey;
    _resetCryptoCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const signIn = (body: Record<string, unknown> = {}) =>
    fetch(`${base}${API.authMicrosoft}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'code-1',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'chord://oauthredirect',
        ...body,
      }),
    });

  interface SignInBody {
    token: string;
    user: { id: string; firstName?: string; lastName?: string; email?: string };
  }
  const signInBody = async () => (await (await signIn()).json()) as SignInBody;
  const health = async () =>
    (await (await fetch(`${base}${API.health}`)).json()) as {
      microsoftSignIn: { clientId: string; calendar: boolean } | null;
    };
  const userRow = (id: string) =>
    db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const mailboxes = (userId: string) =>
    db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).execute();

  it('is refused, and not advertised, until it is turned on', async () => {
    expect((await health()).microsoftSignIn).toEqual({ clientId: CLIENT_ID, calendar: false });

    e.MICROSOFT_SIGN_IN_ENABLED = false;
    expect((await signIn()).status).toBe(503);
    expect((await health()).microsoftSignIn).toBeNull();

    // The mock mailbox would be a login with no identity behind it.
    e.MICROSOFT_SIGN_IN_ENABLED = true;
    e.OUTLOOK_PROVIDER = 'mock';
    expect((await signIn()).status).toBe(503);
  });

  it('creates an account and connects the Outlook mailbox in the same step', async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignInBody;
    expect(body.token).toMatch(/^t_/);
    expect(body.user).toMatchObject({ firstName: 'Ann', lastName: 'Lee', email: 'ann@contoso.com' });

    const row = await userRow(body.user.id);
    expect(row.microsoft_sub).toBe(`${WORK_TENANT}:oid-ann`);
    expect(row.email_verified).toBe(0);

    const boxes = await mailboxes(body.user.id);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ provider: 'outlook', email_address: 'ann@contoso.com', status: 'ok' });
    expect(boxes[0].auth_ciphertext).not.toBeNull();

    // Returning: same account, the mailbox re-attached rather than duplicated.
    const again = await signInBody();
    expect(again.user.id).toBe(body.user.id);
    expect(await mailboxes(body.user.id)).toHaveLength(1);
  });

  // Prod 2026-11-16: every sign-in from the iPhone app answered "microsoft
  // sign-in failed" - Microsoft refused the code with AADSTS90023 because the
  // server sent the client secret on a code from chord://oauthredirect.
  it('signs in from the app without the secret, and the mailbox token refreshes the same way', async () => {
    const res = await signIn({ redirectUri: 'chord://oauthredirect' });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as SignInBody;
    expect(tokenRequests[0].has('client_secret')).toBe(false);

    await settleBackgroundWork();
    const [box] = await mailboxes(user.id);
    _resetAccessTokenReuseForTests();
    tokenRequests = [];
    await expect(getOutlookAccessToken(db, box)).resolves.toBe('ms-at');
    expect(tokenRequests[0].get('grant_type')).toBe('refresh_token');
    expect(tokenRequests[0].has('client_secret')).toBe(false);

    // The rotated token keeps the flag, so the next refresh is still secret-free.
    const [rotated] = await mailboxes(user.id);
    _resetAccessTokenReuseForTests();
    tokenRequests = [];
    await expect(getOutlookAccessToken(db, rotated)).resolves.toBe('ms-at');
    expect(tokenRequests[0].has('client_secret')).toBe(false);
  });

  it('still sends the secret for a sign-in that came back to the web address', async () => {
    const res = await signIn({ redirectUri: 'https://chordapp.ai/oauthredirect' });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as SignInBody;
    expect(tokenRequests[0].get('client_secret')).toBe('ms-secret');

    await settleBackgroundWork();
    const [box] = await mailboxes(user.id);
    _resetAccessTokenReuseForTests();
    tokenRequests = [];
    await expect(getOutlookAccessToken(db, box)).resolves.toBe('ms-at');
    expect(tokenRequests[0].get('client_secret')).toBe('ms-secret');
  });

  it('joins an existing account when Microsoft proves the email (xms_edov)', async () => {
    const existingId = await createUser(db, 'ann', 'Ann Lee');
    await db
      .updateTable('users')
      .set({ email: 'Ann@Contoso.com', google_sub: 'google-sub-1' })
      .where('id', '=', existingId)
      .execute();
    claims = msClaims({ xms_edov: true });

    const body = await signInBody();
    expect(body.user.id).toBe(existingId);
    expect((await userRow(existingId)).microsoft_sub).toBe(`${WORK_TENANT}:oid-ann`);
    expect(await mailboxes(existingId)).toHaveLength(1);
  });

  it('joins on a personal account at a Microsoft-run address', async () => {
    const existingId = await createUser(db, 'ann', 'Ann Lee');
    await db.updateTable('users').set({ email: 'ann@hotmail.com' }).where('id', '=', existingId).execute();
    claims = msClaims({ tid: MICROSOFT_CONSUMER_TENANT, email: 'ann@hotmail.com' });
    graphMail = 'ann@hotmail.com';

    const body = await signInBody();
    expect(body.user.id).toBe(existingId);
  });

  it('never claims an account on an email a tenant merely asserts', async () => {
    // Another tenant's admin sets `mail` to someone else's address (nOAuth).
    const victimId = await createUser(db, 'victim', 'Victim');
    await db.updateTable('users').set({ email: 'victim@gmail.com' }).where('id', '=', victimId).execute();
    claims = msClaims({ oid: 'oid-attacker', email: 'victim@gmail.com' });
    graphMail = 'victim@gmail.com';

    const body = await signInBody();
    expect(body.user.id).not.toBe(victimId);
    expect((await userRow(victimId)).microsoft_sub).toBeNull();
    expect(await mailboxes(victimId)).toHaveLength(0);

    // A personal account at a non-Microsoft address is no proof either.
    claims = msClaims({ tid: MICROSOFT_CONSUMER_TENANT, oid: 'oid-2', email: 'victim@gmail.com' });
    expect((await signInBody()).user.id).not.toBe(victimId);
  });

  it('answers 401 and creates nothing when the code or the token is not good', async () => {
    tokenStatus = 400;
    expect((await signIn()).status).toBe(401);

    tokenStatus = 200;
    claims = msClaims({ aud: 'some-other-app' });
    expect((await signIn()).status).toBe(401);

    claims = msClaims({ iss: 'https://login.microsoftonline.com/another-tenant/v2.0' });
    expect((await signIn()).status).toBe(401);

    claims = msClaims({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await signIn()).status).toBe(401);

    const n = await db.selectFrom('users').select('id').where('microsoft_sub', 'is not', null).execute();
    expect(n).toHaveLength(0);
    expect(await db.selectFrom('email_accounts').select('id').execute()).toHaveLength(0);
  });

  it('marks the mailbox calendar-capable when the grant includes calendars', async () => {
    scope += ' Calendars.ReadWrite';
    const body = await signInBody();
    expect((await mailboxes(body.user.id))[0].calendar_enabled).toBe(1);
  });

  it('forgets the Microsoft identity and the mailbox token when the account is deleted', async () => {
    const body = await signInBody();
    await settleBackgroundWork();
    await deleteAccount(db, body.user.id);
    const left = await db
      .selectFrom('users')
      .select('id')
      .where('microsoft_sub', '=', `${WORK_TENANT}:oid-ann`)
      .execute();
    expect(left).toHaveLength(0);
    expect(await mailboxes(body.user.id)).toHaveLength(0);

    // Signing in again starts a fresh account.
    expect((await signInBody()).user.id).not.toBe(body.user.id);
  });

  describe('Google connect from a Microsoft-only session (ADR 0293 addendum)', () => {
    // The prod case: ownertest@hotmail.com was connected as an Outlook mailbox
    // on the owner's Google account, then used for Sign in with Microsoft,
    // which (by design) made a second account holding the same mailbox.
    const HOTMAIL = 'ownertest@hotmail.com';
    const MS_SUB = `${MICROSOFT_CONSUMER_TENANT}:oid-crookbond`;

    const connectGmail = (token: string) =>
      fetch(`${base}${API.authGoogleGmail}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chord-token': token },
        body: JSON.stringify({ code: 'g-code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://x/cb' }),
      });
    const me = async (token: string) =>
      (await (await fetch(`${base}${API.me}`, { headers: { 'x-chord-token': token } })).json()) as {
        id: string;
      };

    async function priorGoogleAccount(): Promise<string> {
      const id = await createUser(db, 'john', 'John');
      await db
        .updateTable('users')
        .set({ google_sub: 'google-sub-john', email: 'ownertest@gmail.com', email_verified: 1 })
        .where('id', '=', id)
        .execute();
      await ensurePersonalGroup(db, id);
      return id;
    }

    async function attachMailbox(userId: string, address: string): Promise<string> {
      const now = new Date().toISOString();
      const id = `ema_${address.split('@')[0]}_${userId.slice(-4)}`;
      await db
        .insertInto('email_accounts')
        .values({
          id,
          user_id: userId,
          provider: 'outlook',
          email_address: address,
          display_name: null,
          preset_key: null,
          auth_ciphertext: Buffer.from('ct'),
          auth_iv: Buffer.from('iv'),
          auth_tag: Buffer.from('tg'),
          sync_cursor: 'cursor-1',
          synced_at: now,
          backfill_done: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return id;
    }

    async function microsoftOnlySession(): Promise<SignInBody> {
      claims = msClaims({ tid: MICROSOFT_CONSUMER_TENANT, oid: 'oid-crookbond', email: HOTMAIL });
      graphMail = HOTMAIL;
      const body = await signInBody();
      await settleBackgroundWork();
      return body;
    }

    beforeEach(() => {
      google.result = {
        identity: { sub: 'google-sub-john', email: 'ownertest@gmail.com', emailVerified: true },
        refreshToken: 'google-rt-1',
        grantedScopes: 'openid email https://www.googleapis.com/auth/gmail.modify',
        clientId: 'web-client',
      };
    });

    it('folds the Microsoft account in and drops the mailbox both accounts held', async () => {
      const googleUser = await priorGoogleAccount();
      const keptBox = await attachMailbox(googleUser, HOTMAIL);
      const ms = await microsoftOnlySession();
      const msOnly = ms.user.id;
      expect(msOnly).not.toBe(googleUser);
      expect(await mailboxes(msOnly)).toHaveLength(1);

      const msPersonal = await ensurePersonalGroup(db, msOnly);
      await insertMessage(db, { groupId: msPersonal.id, senderId: msOnly, body: 'note to self', mentionsBot: false });

      const res = await connectGmail(ms.token);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { user?: { id: string } }).user?.id).toBe(googleUser);
      expect((await me(ms.token)).id).toBe(googleUser);

      expect((await userRow(googleUser)).microsoft_sub).toBe(MS_SUB);
      expect((await userRow(msOnly)).microsoft_sub).toBeNull();

      // One copy of the Hotmail mailbox: the Google account's own, untouched.
      const kept = await mailboxes(googleUser);
      expect(kept.map((b) => b.id)).toEqual([keptBox]);
      expect(kept[0].sync_cursor).toBe('cursor-1');
      expect(await mailboxes(msOnly)).toHaveLength(0);

      const notes = await db
        .selectFrom('messages')
        .select('sender_id')
        .where('body', '=', 'note to self')
        .executeTakeFirstOrThrow();
      expect(notes.sender_id).toBe(googleUser);

      // The next Sign in with Microsoft opens the Google account.
      expect((await signInBody()).user.id).toBe(googleUser);
      expect(await mailboxes(googleUser)).toHaveLength(1);
    });

    it('moves a mailbox only the Microsoft account had, to sync afresh', async () => {
      const googleUser = await priorGoogleAccount();
      const ms = await microsoftOnlySession();
      const [source] = await mailboxes(ms.user.id);

      expect((await connectGmail(ms.token)).status).toBe(200);
      await settleBackgroundWork();

      expect(await mailboxes(ms.user.id)).toHaveLength(0);
      const moved = await mailboxes(googleUser);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({ provider: 'outlook', email_address: HOTMAIL, backfill_done: 0 });
      expect(moved[0].id).not.toBe(source.id);
      // Same credential, so no reconnect is needed.
      expect(moved[0].auth_ciphertext).toEqual(source.auth_ciphertext);
    });

    // Addendum 2026-11-02: the prod sign-in made a second account and nobody
    // was told; it took a support question to learn the Google connect step.
    const chordNotes = async (userId: string) => {
      const personal = await ensurePersonalGroup(db, userId);
      return (
        await db
          .selectFrom('messages')
          .select('body')
          .where('group_id', '=', personal.id)
          .where('sender_id', 'is', null)
          .execute()
      ).map((m) => m.body ?? '');
    };

    it('tells both accounts they are two, and how to combine them', async () => {
      const googleUser = await priorGoogleAccount();
      await attachMailbox(googleUser, HOTMAIL);
      const ms = await microsoftOnlySession();

      // One personal chat, and the notice is in it (an early version raced
      // sign-in's own ensurePersonalGroup and made a second one).
      const personals = await db
        .selectFrom('groups')
        .select('id')
        .where('kind', '=', 'personal')
        .where('created_by', '=', ms.user.id)
        .execute();
      expect(personals).toHaveLength(1);
      const toNew = await chordNotes(ms.user.id);
      expect(toNew).toHaveLength(1);
      expect(toNew[0]).toContain('you now have two');
      expect(toNew[0]).toContain('Settings, Connected accounts, Google');
      // The other account is not named to whoever signed in with Microsoft.
      expect(toNew[0]).not.toContain('ownertest@gmail.com');

      const toExisting = await chordNotes(googleUser);
      expect(toExisting).toHaveLength(1);
      expect(toExisting[0]).toContain(HOTMAIL);
      expect(toExisting[0]).toContain('ownertest@gmail.com');

      // A returning sign-in is not a new account, so nobody is told again.
      await signInBody();
      await settleBackgroundWork();
      expect(await chordNotes(ms.user.id)).toHaveLength(1);
      expect(await chordNotes(googleUser)).toHaveLength(1);
    });

    it('tells nobody when no other account reads the mailbox', async () => {
      const googleUser = await priorGoogleAccount();
      const ms = await microsoftOnlySession();
      expect(await chordNotes(ms.user.id)).toHaveLength(0);
      expect(await chordNotes(googleUser)).toHaveLength(0);
    });

    it('tells nobody when the other account has no Google login to connect', async () => {
      const appleOnly = await createUser(db, 'apple', 'Apple Only');
      await db.updateTable('users').set({ apple_sub: 'apple-sub-1' }).where('id', '=', appleOnly).execute();
      await attachMailbox(appleOnly, HOTMAIL);
      const ms = await microsoftOnlySession();
      expect(await chordNotes(ms.user.id)).toHaveLength(0);
      expect(await chordNotes(appleOnly)).toHaveLength(0);
    });

    it('moves nothing when the Google account already has another Microsoft login', async () => {
      const googleUser = await priorGoogleAccount();
      await db.updateTable('users').set({ microsoft_sub: 'other-tenant:oid-other' }).where('id', '=', googleUser).execute();
      const ms = await microsoftOnlySession();

      expect((await connectGmail(ms.token)).status).toBe(200);
      expect((await userRow(googleUser)).microsoft_sub).toBe('other-tenant:oid-other');
      expect((await userRow(ms.user.id)).microsoft_sub).toBe(MS_SUB);
      expect(await mailboxes(ms.user.id)).toHaveLength(1);
      expect(await mailboxes(googleUser)).toHaveLength(0);
    });
  });
});
