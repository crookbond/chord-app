/**
 * ADR 0156 — Sign in with Apple over the real app. Apple's token and revoke
 * endpoints are faked at the fetch boundary; every other request (the test's
 * own calls to the local server) passes through.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { deleteAccount } from '@/services/account.service.js';
import { moveAppleIdentity } from '@/services/apple/apple-auth.service.js';
import type { ExchangeResult } from '@/services/google/oauth.service.js';
import { createGroup, ensurePairGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

// Google's code exchange verifies a signed id_token; the consent routes are
// exercised with the exchange itself faked.
const google = vi.hoisted(() => ({ result: null as ExchangeResult | null }));
vi.mock('@/services/google/oauth.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/google/oauth.service.js')>()),
  exchangeCode: vi.fn(async () => google.result),
}));

type AppleEnv = {
  AUTH_MODE: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  APPLE_BUNDLE_ID: string;
};
const e = env as unknown as AppleEnv;
const savedEnv = { ...e };
const savedMasterKey = process.env.MASTER_KEY;

const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
}

describe('POST /api/v1/auth/apple (ADR 0156)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tokenStatus: number;
  let claims: Record<string, unknown>;
  let revoked: string[];

  const appleClaims = (over: Record<string, unknown> = {}) => ({
    iss: 'https://appleid.apple.com',
    aud: 'app.chord.demo',
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: 'apple-sub-1',
    email: 'ann@example.com',
    email_verified: 'true',
    ...over,
  });

  beforeEach(async () => {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
    _resetCryptoCacheForTests();
    e.AUTH_MODE = 'google';
    e.APPLE_TEAM_ID = 'TEAM123456';
    e.APPLE_KEY_ID = 'KEY1234567';
    e.APPLE_PRIVATE_KEY = PEM;
    e.APPLE_BUNDLE_ID = 'app.chord.demo';
    tokenStatus = 200;
    claims = appleClaims();
    revoked = [];

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://appleid.apple.com/auth/token') {
        if (tokenStatus !== 200) {
          return new Response('{"error":"invalid_grant"}', { status: tokenStatus });
        }
        return Response.json({ id_token: idToken(claims), refresh_token: 'apple-rt-1' });
      }
      if (url === 'https://appleid.apple.com/auth/revoke') {
        revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
        return new Response('', { status: 200 });
      }
      return realFetch(input, init);
    });

    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    Object.assign(e, savedEnv);
    if (savedMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = savedMasterKey;
    _resetCryptoCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const signIn = (body: Record<string, unknown>) =>
    fetch(`${base}${API.authApple}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorizationCode: 'code-1', ...body }),
    });

  interface SignInBody {
    token: string;
    user: { id: string; firstName?: string; lastName?: string; email?: string };
  }
  const signInBody = async (body: Record<string, unknown>) =>
    (await (await signIn(body)).json()) as SignInBody;
  const health = async () =>
    (await (await fetch(`${base}${API.health}`)).json()) as { appleSignIn: boolean };

  const userRow = (id: string) =>
    db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('is refused, and not advertised, until the Apple keys are set', async () => {
    expect((await health()).appleSignIn).toBe(true);

    e.APPLE_PRIVATE_KEY = '';
    expect((await signIn({})).status).toBe(503);
    expect((await health()).appleSignIn).toBe(false);
  });

  it('creates an account with the name Apple shares only the first time', async () => {
    const res = await signIn({ givenName: 'Ann', familyName: 'Lee' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignInBody;
    expect(body.token).toMatch(/^t_/);
    expect(body.user).toMatchObject({ firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com' });

    const row = await userRow(body.user.id);
    expect(row.apple_sub).toBe('apple-sub-1');
    expect(row.display_name).toBe('Ann Lee');
    expect(row.apple_refresh_token_ciphertext).not.toBeNull();

    // Returning: Apple sends no name now; the account and its name stay.
    const again = await signInBody({});
    expect(again.user.id).toBe(body.user.id);
    expect((await userRow(body.user.id)).display_name).toBe('Ann Lee');
  });

  it('joins the existing account that already holds the same verified email', async () => {
    const existingId = await createUser(db, 'ann', 'Ann Lee');
    await db
      .updateTable('users')
      .set({ email: 'Ann@Example.com', google_sub: 'google-sub-1' })
      .where('id', '=', existingId)
      .execute();

    const body = await signInBody({});
    expect(body.user.id).toBe(existingId);
    expect((await userRow(existingId)).apple_sub).toBe('apple-sub-1');
  });

  it('does not join on an unverified email', async () => {
    const existingId = await createUser(db, 'ann', 'Ann Lee');
    await db.updateTable('users').set({ email: 'ann@example.com' }).where('id', '=', existingId).execute();
    claims = appleClaims({ email_verified: 'false' });

    const body = await signInBody({});
    expect(body.user.id).not.toBe(existingId);
  });

  it('gives a relay-address user a plain name, not the relay local part', async () => {
    claims = appleClaims({ email: 'x7k2qq@privaterelay.appleid.com', is_private_email: 'true' });
    const body = await signInBody({});
    const row = await userRow(body.user.id);
    expect(row.display_name).toBe('Chord user');
    expect(row.username).toMatch(/^apple-/);
    expect(row.email).toBe('x7k2qq@privaterelay.appleid.com');
  });

  it('answers 401 and creates nothing when Apple rejects the code', async () => {
    tokenStatus = 400;
    expect((await signIn({})).status).toBe(401);
    const n = await db.selectFrom('users').select('id').where('apple_sub', 'is not', null).execute();
    expect(n).toHaveLength(0);
  });

  it('revokes the Apple token when the account is deleted', async () => {
    const body = await signInBody({ givenName: 'Ann' });
    const result = await deleteAccount(db, body.user.id);
    expect(result.appleRevoked).toBe(true);
    expect(revoked).toEqual(['apple-rt-1']);
  });

  it('moves the Apple identity to the account a Google connect re-points to', async () => {
    const appleOnly = (await signInBody({})).user.id as string;
    const googleUser = await createUser(db, 'ann-google');

    expect(await moveAppleIdentity(db, appleOnly, googleUser)).toBe(true);
    expect((await userRow(googleUser)).apple_sub).toBe('apple-sub-1');
    expect((await userRow(googleUser)).apple_refresh_token_ciphertext).not.toBeNull();
    expect((await userRow(appleOnly)).apple_sub).toBeNull();

    // Next Apple sign-in now lands in the Google account.
    const again = await signInBody({});
    expect(again.user.id).toBe(googleUser);

    // A target that already has an Apple identity is left alone.
    const other = await createUser(db, 'other');
    await db.updateTable('users').set({ apple_sub: 'someone-else' }).where('id', '=', other).execute();
    expect(await moveAppleIdentity(db, googleUser, other)).toBe(false);
    expect((await userRow(googleUser)).apple_sub).toBe('apple-sub-1');
  });

  describe('Google connect from an Apple-only session (ADR 0156 addendum)', () => {
    const GMAIL_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.modify';

    const googleExchange = (over: Partial<ExchangeResult> = {}): ExchangeResult => ({
      identity: { sub: 'google-sub-1', email: 'ann@gmail.com', emailVerified: true },
      refreshToken: 'google-rt-1',
      grantedScopes: GMAIL_SCOPE,
      clientId: 'web-client',
      ...over,
    });

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

    /** A Google account from an earlier sign-in, with a surname Google never gave. */
    async function priorGoogleAccount(): Promise<string> {
      const id = await createUser(db, 'ann', 'Ann');
      await db
        .updateTable('users')
        .set({ google_sub: 'google-sub-1', email: 'ann@gmail.com', email_verified: 1 })
        .where('id', '=', id)
        .execute();
      await ensurePersonalGroup(db, id);
      return id;
    }

    /** Signed in with Apple behind a relay address, so nothing bound by email. */
    async function appleOnlySession(): Promise<SignInBody> {
      claims = appleClaims({ email: 'x7k2qq@privaterelay.appleid.com', is_private_email: 'true' });
      return signInBody({ givenName: 'Annie', familyName: 'Lee' });
    }

    it('folds the Apple account into the prior Google account and returns its profile', async () => {
      const googleUser = await priorGoogleAccount();
      const apple = await appleOnlySession();
      const appleOnly = apple.user.id;
      expect(appleOnly).not.toBe(googleUser);

      // What the Apple session accumulated before connecting Gmail.
      await db.updateTable('users').set({ last_tz: 'America/Chicago' }).where('id', '=', appleOnly).execute();
      const now = new Date().toISOString();
      await db
        .insertInto('push_tokens')
        .values({ token: 'ExponentPushToken[dev]', user_id: appleOnly, platform: 'ios', created_at: now, last_seen_at: now })
        .execute();
      const family = await createGroup(db, { name: 'Lee family', kind: 'group', createdBy: appleOnly });
      await insertMessage(db, { groupId: family.id, senderId: appleOnly, body: 'hi all', mentionsBot: false });
      const carol = await createUser(db, 'carol', 'Carol');
      const pair = await ensurePairGroup(db, appleOnly, carol);
      const applePersonal = await ensurePersonalGroup(db, appleOnly);
      const googlePersonal = await ensurePersonalGroup(db, googleUser);
      await insertMessage(db, { groupId: applePersonal.id, senderId: appleOnly, body: 'note to self', mentionsBot: false });
      await db
        .updateTable('users')
        .set({ phone_number: '+15551230000', phone_hash: 'hash-apple', phone_verified: 1 })
        .where('id', '=', appleOnly)
        .execute();
      await db
        .insertInto('external_identities')
        .values({
          platform: 'whatsapp',
          external_id: 'whatsapp:+15551230000',
          external_display: 'Annie',
          user_id: appleOnly,
          created_at: now,
        })
        .execute();

      google.result = googleExchange();
      const res = await connectGmail(apple.token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; user?: { id: string; firstName?: string; lastName?: string } };
      // The Google account's own name wins; the surname it lacked is filled.
      expect(body.user).toMatchObject({ id: googleUser, firstName: 'Ann', lastName: 'Lee' });
      expect((await me(apple.token)).id).toBe(googleUser);

      const row = await userRow(googleUser);
      expect(row.apple_sub).toBe('apple-sub-1');
      expect(row.display_name).toBe('Ann');
      expect(row.last_tz).toBe('America/Chicago');
      expect(row.refresh_token_ciphertext).not.toBeNull();

      const token = await db.selectFrom('push_tokens').select('user_id').executeTakeFirstOrThrow();
      expect(token.user_id).toBe(googleUser);

      // A verified number stays verified, and its WhatsApp chat follows.
      expect(row.phone_number).toBe('+15551230000');
      expect(row.phone_verified).toBe(1);
      expect((await userRow(appleOnly)).phone_number).toBeNull();
      const wa = await db.selectFrom('external_identities').select('user_id').executeTakeFirstOrThrow();
      expect(wa.user_id).toBe(googleUser);

      const members = await db
        .selectFrom('group_members')
        .select(['group_id', 'user_id', 'role'])
        .where('group_id', 'in', [family.id, pair.id, googlePersonal.id])
        .execute();
      expect(members).toEqual(
        expect.arrayContaining([
          { group_id: family.id, user_id: googleUser, role: 'owner' },
          { group_id: pair.id, user_id: googleUser, role: expect.any(String) },
          { group_id: googlePersonal.id, user_id: googleUser, role: expect.any(String) },
        ]),
      );
      const leftBehind = await db.selectFrom('group_members').select('group_id').where('user_id', '=', appleOnly).execute();
      expect(leftBehind).toEqual([]);

      // The personal chat folded into the Google account's own.
      const applePersonalGone = await db.selectFrom('groups').select('id').where('id', '=', applePersonal.id).executeTakeFirst();
      expect(applePersonalGone).toBeUndefined();
      const notes = await db
        .selectFrom('messages')
        .select(['group_id', 'sender_id'])
        .where('body', '=', 'note to self')
        .executeTakeFirstOrThrow();
      expect(notes).toEqual({ group_id: googlePersonal.id, sender_id: googleUser });

      const msg = await db.selectFrom('messages').select('sender_id').where('group_id', '=', family.id).executeTakeFirstOrThrow();
      expect(msg.sender_id).toBe(googleUser);
      const groups = await db
        .selectFrom('groups')
        .select(['id', 'created_by', 'pair_key'])
        .where('id', 'in', [family.id, pair.id])
        .execute();
      expect(groups.find((g) => g.id === family.id)?.created_by).toBe(googleUser);
      expect(groups.find((g) => g.id === pair.id)?.pair_key).toBe([googleUser, carol].sort().join('|'));
      const roster = await db
        .selectFrom('personas')
        .select(['member_user_id', 'name'])
        .where('group_id', '=', family.id)
        .execute();
      expect(roster).toEqual([{ member_user_id: googleUser, name: 'Ann' }]);

      // And the next Apple sign-in lands straight in the Google account.
      expect((await signInBody({})).user.id).toBe(googleUser);
    });

    it('folds a pair group into the one the Google account already has with that person', async () => {
      const googleUser = await priorGoogleAccount();
      const apple = await appleOnlySession();
      const carol = await createUser(db, 'carol', 'Carol');
      const existingPair = await ensurePairGroup(db, googleUser, carol);
      const applePair = await ensurePairGroup(db, apple.user.id, carol);
      await insertMessage(db, { groupId: applePair.id, senderId: carol, body: 'from carol', mentionsBot: false });

      google.result = googleExchange();
      expect((await connectGmail(apple.token)).status).toBe(200);

      const pairs = await db.selectFrom('groups').select(['id', 'pair_key']).where('pair_key', 'is not', null).execute();
      expect(pairs).toEqual([{ id: existingPair.id, pair_key: [googleUser, carol].sort().join('|') }]);
      const msg = await db.selectFrom('messages').select('group_id').where('body', '=', 'from carol').executeTakeFirstOrThrow();
      expect(msg.group_id).toBe(existingPair.id);
      const members = await db
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', existingPair.id)
        .execute();
      expect(members.map((m) => m.user_id).sort()).toEqual([googleUser, carol].sort());
    });

    it('hands over event copies the Google account lacks and drops ones it already has', async () => {
      const googleUser = await priorGoogleAccount();
      const apple = await appleOnlySession();
      const appleOnly = apple.user.id;
      // Both were in the family group; only the Apple row was in the club.
      const family = await createGroup(db, { name: 'Lee family', kind: 'group', createdBy: googleUser });
      await addMember(db, family.id, appleOnly);
      const club = await createGroup(db, { name: 'Book club', kind: 'group', createdBy: appleOnly });
      const now = new Date().toISOString();
      const copy = (id: string, groupId: string, owner: string, icalUid: string) => ({
        id,
        group_id: groupId,
        title: id,
        location: null,
        starts_at: now,
        ends_at: null,
        created_by: owner,
        created_at: now,
        source_raw_context: null,
        external_uid: null,
        ical_uid: icalUid,
        owner_user_id: owner,
      });
      await db
        .insertInto('events')
        .values([
          copy('dinner-google', family.id, googleUser, 'uid-dinner'),
          copy('dinner-apple', family.id, appleOnly, 'uid-dinner'),
          copy('book-apple', club.id, appleOnly, 'uid-book'),
        ])
        .execute();

      google.result = googleExchange();
      expect((await connectGmail(apple.token)).status).toBe(200);

      const events = await db.selectFrom('events').select(['id', 'owner_user_id']).orderBy('id').execute();
      expect(events).toEqual([
        { id: 'book-apple', owner_user_id: googleUser },
        { id: 'dinner-google', owner_user_id: googleUser },
      ]);
    });

    it('keeps the Google account’s own number and releases the Apple one', async () => {
      const googleUser = await priorGoogleAccount();
      await db
        .updateTable('users')
        .set({ phone_number: '+15559990000', phone_hash: 'hash-google', phone_verified: 1 })
        .where('id', '=', googleUser)
        .execute();
      const apple = await appleOnlySession();
      await db
        .updateTable('users')
        .set({ phone_number: '+15551230000', phone_hash: 'hash-apple', phone_verified: 1 })
        .where('id', '=', apple.user.id)
        .execute();

      google.result = googleExchange();
      expect((await connectGmail(apple.token)).status).toBe(200);

      expect((await userRow(googleUser)).phone_number).toBe('+15559990000');
      // Not left verified on an account nobody can sign in to.
      const orphan = await userRow(apple.user.id);
      expect(orphan.phone_number).toBeNull();
      expect(orphan.phone_verified).toBe(0);
    });

    it('does not re-point the session when Google withholds the refresh token', async () => {
      const googleUser = await priorGoogleAccount();
      const apple = await appleOnlySession();

      google.result = googleExchange({ refreshToken: null });
      expect((await connectGmail(apple.token)).status).toBe(400);
      expect((await me(apple.token)).id).toBe(apple.user.id);
      expect((await userRow(googleUser)).apple_sub).toBeNull();
    });

    it('answers a plain consent with no account switch', async () => {
      const googleUser = await priorGoogleAccount();
      const session = `t_${randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();
      await db.insertInto('sessions').values({ token: hashSessionToken(session), user_id: googleUser, created_at: now, last_seen_at: now }).execute();

      google.result = googleExchange();
      const body = (await (await connectGmail(session)).json()) as { ok: boolean; user?: unknown };
      expect(body.ok).toBe(true);
      expect(body.user).toBeUndefined();

      google.result = googleExchange({ identity: { sub: 'someone-else', email: 'x@gmail.com', emailVerified: true } });
      expect((await connectGmail(session)).status).toBe(403);
    });

    it('carries nothing when the Google account already has another Apple identity', async () => {
      const googleUser = await priorGoogleAccount();
      await db.updateTable('users').set({ apple_sub: 'apple-sub-other' }).where('id', '=', googleUser).execute();
      const apple = await appleOnlySession();
      const family = await createGroup(db, { name: 'Lee family', kind: 'group', createdBy: apple.user.id });
      await addMember(db, family.id, await createUser(db, 'carol'));

      google.result = googleExchange();
      const body = (await (await connectGmail(apple.token)).json()) as { user?: { id: string } };
      expect(body.user?.id).toBe(googleUser);
      expect((await userRow(googleUser)).apple_sub).toBe('apple-sub-other');
      expect((await userRow(googleUser)).last_name).toBeNull();
      const member = await db
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', family.id)
        .where('user_id', '=', apple.user.id)
        .executeTakeFirst();
      expect(member).toBeDefined();
    });
  });
});
