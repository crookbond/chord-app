import { Router, type Request, type Response } from 'express';
import { sql, type Selectable } from 'kysely';
import { nanoid } from 'nanoid';
import {
  API,
  AppleAuthRequest,
  appleReturnPath,
  appleStateOrigin,
  GoogleAuthRequest,
  MicrosoftAuthRequest,
  ReviewAuthRequest,
  SESSION_COOKIE,
  type GoogleConsentResponse,
  type SessionResponse,
} from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type { UsersTable } from '../db/schema.js';
import { cookieWriteLacksCsrf, loadSession, readSessionToken, requireSession } from '../middleware/auth.js';
import { sessionCookieMaxAgeMs, sessionCookieOptions } from '../utils/session-expiry.js';
import { hashSessionToken, newSessionToken } from '../utils/session-token.js';
import { runInBackground } from '../utils/background.js';
import { buildCorsOriginCheck } from '../utils/cors-origins.js';
import {
  APPLE_FALLBACK_NAME,
  appleSignInConfigured,
  appleWebRedirectUri,
  appleWebSignInConfigured,
  exchangeAppleCode,
  moveAppleIdentity,
  persistAppleRefreshToken,
} from '../services/apple/apple-auth.service.js';
import { foldSignInAccountInto } from '../services/apple/apple-fold.service.js';
import { consumeSignupIntent } from '../services/connectors/signup-intents.service.js';
import { claimFamilyInvitesFor } from '../services/family-plan.service.js';
import { claimChatInvitesFor } from '../services/chat-invites.service.js';
import { ensurePersonalGroup } from '../services/groups.service.js';
import { recordPrimaryGmailAddress } from '../services/email/primary-gmail-address.js';
import { exchangeCode, persistRefreshToken } from '../services/google/oauth.service.js';
import { attachOutlookMailbox, moveMailboxesTo } from '../services/email-accounts/accounts.service.js';
import { exchangeOutlookCode } from '../services/email-accounts/outlook-oauth.js';
import { tellAboutSecondAccount } from '../services/microsoft/second-account-notice.js';
import {
  microsoftSignInConfigured,
  moveMicrosoftIdentityIn,
  parseMicrosoftIdToken,
} from '../services/microsoft/microsoft-auth.service.js';
import {
  reviewAccount,
  reviewCredentialsMatch,
  reviewSignInConfigured,
} from '../services/review-sign-in.service.js';

export const authRouter = Router();

/** Chord's own web origins - the only ones a browser may be sent back to. */
function isOwnWebOrigin(origin: string): boolean {
  return buildCorsOriginCheck({
    production: true,
    extra: env.CORS_ALLOWED_ORIGINS,
    webOrigin: env.WEB_ORIGIN,
    signupUrl: env.SIGNUP_URL,
  })(origin);
}
authRouter.use(loadSession);

/**
 * The tail every sign-in shares once a provider has resolved the user row:
 * soft-link a welcome-DM referrer, ensure the personal group, open a session.
 */
async function completeSignIn(
  req: Request,
  res: Response,
  opts: {
    user: Selectable<UsersTable>;
    email: string | null;
    signupRef?: string;
    fallbackDisplay: string;
    fallbackFirst: string | null;
    fallbackLast: string | null;
  },
): Promise<void> {
  const { user } = opts;

  // ADR 0031 (Telegram) / ADR 0053 (WhatsApp) — soft-link an external
  // identity via the UUID referrer token. The token carries its own
  // platform, so this one path covers every referrer-flow connector.
  // Best-effort: a missing or stale token never blocks sign-in; the
  // user can still pair via /chord pair afterwards (Telegram).
  if (opts.signupRef) {
    try {
      const result = await consumeSignupIntent(req.db, {
        token: opts.signupRef,
        ownerUserId: user.id,
        ownerEmail: opts.email,
        ownerDisplay: user.display_name ?? opts.fallbackDisplay,
      });
      if (!result.ok) {
        logger.info('signup-ref consume skipped', {
          userId: user.id,
          reason: result.reason,
        });
      }
    } catch (err) {
      logger.warn('signup-ref consume failed', {
        userId: user.id,
        err: (err as Error).message,
      });
    }
  }

  // Ensure the personal group AFTER the referrer consume. When a WhatsApp
  // taster shadow is merged in (ADR 0053), `mergeOrLinkExternalIdentity`
  // re-attributes the shadow's personal group to this user; running
  // `ensurePersonalGroup` now finds that group (idempotent on
  // `created_by`) instead of creating a duplicate. Idempotent + a no-op
  // for returning users.
  await ensurePersonalGroup(req.db, user.id);

  // ADR 0237 — an invite sent before this person had an account covers them
  // the moment they sign in, with no link to find. Best-effort.
  await claimFamilyInvitesFor(req.db, user.id).catch((err) => {
    logger.warn('family invite claim failed', { userId: user.id, err: (err as Error).message });
  });
  // ADR 0318 - chat invites emailed before they had an account now wait in the app.
  await claimChatInvitesFor(req.db, user.id).catch((err) => {
    logger.warn('chat invite claim failed', { userId: user.id, err: (err as Error).message });
  });

  const now = new Date().toISOString();
  const token = newSessionToken();
  await req.db
    .insertInto('sessions')
    .values({
      token: hashSessionToken(token),
      user_id: user.id,
      created_at: now,
      last_seen_at: now,
    })
    .execute();

  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: sessionCookieMaxAgeMs() });

  const body: SessionResponse = {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name ?? undefined,
      firstName: user.first_name ?? opts.fallbackFirst ?? undefined,
      lastName: user.last_name ?? opts.fallbackLast ?? undefined,
      preferredName: user.preferred_name ?? undefined,
      email: opts.email ?? undefined,
      createdAt: user.created_at,
    },
    token,
  };
  res.json(body);
}

/**
 * Sign in with Google (ADR 0014). Mobile runs the PKCE flow against the
 * native Google client and posts the resulting code + verifier here. We
 * exchange them server-side using the web client secret, verify the id_token,
 * upsert a `users` row keyed by Google `sub`, persist the encrypted refresh
 * token, and return a Chord session token in the same shape as POST /session.
 *
 * The client asks for Calendar and, when the server reads Gmail, Gmail in the
 * same consent (ADR 0230). Whatever Google reports as granted is stored; the
 * consent routes below add a scope the user left unticked.
 */
authRouter.post(API.authGoogle, async (req, res, next) => {
  try {
    if (env.AUTH_MODE !== 'google') {
      res.status(403).json({ error: 'google login disabled; set AUTH_MODE=google' });
      return;
    }
    const parsed = GoogleAuthRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const exchange = await exchangeCode(parsed.data).catch((err: Error) => {
      logger.warn('google code exchange failed', { err });
      return null;
    });
    if (!exchange) {
      res.status(401).json({ error: 'google sign-in failed' });
      return;
    }
    const { identity } = exchange;
    if (!identity.emailVerified) {
      logger.warn('google sign-in rejected: email not verified', { sub: identity.sub });
      res.status(403).json({ error: 'google account email is not verified' });
      return;
    }

    const now = new Date().toISOString();

    let user = await req.db
      .selectFrom('users')
      .selectAll()
      .where('google_sub', '=', identity.sub)
      .executeTakeFirst();

    const desiredDisplay = identity.name ?? identity.email.split('@')[0];
    const nameParts = desiredDisplay.trim().split(/\s+/);
    const desiredFirstName = identity.givenName ?? nameParts[0] ?? null;
    const desiredLastName = identity.familyName ?? (nameParts.slice(1).join(' ') || null);

    // Pre-seeded users (SEED_TG_EMAIL_PAIRS) and other email-only rows
    // exist with `google_sub IS NULL`. Claim them on first Google login
    // with a matching verified email so the dev's TG-linked record is
    // adopted in place instead of a parallel user being created.
    if (!user) {
      const byEmail = await req.db
        .selectFrom('users')
        .selectAll()
        .where(sql`lower(email)`, '=', identity.email.toLowerCase())
        .where('google_sub', 'is', null)
        .where('shadow', '=', 0)
        .executeTakeFirst();
      if (byEmail) {
        await req.db
          .updateTable('users')
          .set({
            google_sub: identity.sub,
            email_verified: 1,
            display_name: byEmail.display_name ?? desiredDisplay,
            first_name: byEmail.first_name ?? desiredFirstName,
            last_name: byEmail.last_name ?? desiredLastName,
          })
          .where('id', '=', byEmail.id)
          .execute();
        user = await req.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', byEmail.id)
          .executeTakeFirstOrThrow();
        logger.info('claimed pre-seeded user on first google login', {
          userId: user.id,
          email: identity.email,
        });
      }
    }

    if (!user) {
      const id = `u_${nanoid(12)}`;
      // Username is derived from email local-part; collisions are de-duped
      // with a short suffix. Username is no longer the auth key under
      // AUTH_MODE=google but other code (mentions, persona memories) still
      // keys off it for human readability.
      const baseUsername = identity.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, '');
      let username = baseUsername || `user${nanoid(6)}`;
      const taken = await req.db
        .selectFrom('users')
        .select('id')
        .where('username', '=', username)
        .executeTakeFirst();
      if (taken) username = `${username}-${nanoid(4)}`;

      user = await req.db
        .insertInto('users')
        .values({
          id,
          username,
          display_name: desiredDisplay,
          first_name: desiredFirstName,
          last_name: desiredLastName,
          created_at: now,
          shadow: 0,
          google_sub: identity.sub,
          email: identity.email,
          email_verified: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      logger.info('created google user', { userId: user.id });
    } else {
      // Refresh email + display name in case they changed in Google.
      await req.db
        .updateTable('users')
        .set({
          email: identity.email,
          email_verified: 1,
          display_name: user.display_name ?? desiredDisplay,
          first_name: user.first_name ?? desiredFirstName,
          last_name: user.last_name ?? desiredLastName,
        })
        .where('id', '=', user.id)
        .execute();
    }

    if (exchange.refreshToken) {
      await persistRefreshToken(
        req.db,
        user.id,
        exchange.refreshToken,
        exchange.grantedScopes,
        exchange.clientId,
      );
      await recordPrimaryGmailAddress(req.db, user.id, identity.email);
    }

    await completeSignIn(req, res, {
      user,
      email: identity.email,
      signupRef: parsed.data.signupRef,
      fallbackDisplay: desiredDisplay,
      fallbackFirst: desiredFirstName,
      fallbackLast: desiredLastName,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Where Apple sends the browser back after a web sign-in. Asking for the name
 * and email forces `response_mode=form_post`, so this arrives as a cross-site
 * form POST the single-page app cannot receive itself.
 *
 * It only relays: the values go back to the web app in the URL FRAGMENT (never
 * sent to a server, so never in an access log), and the app redeems the code
 * through the ordinary sign-in route below. Nothing here is trusted - the
 * state is checked by the browser that started the flow, and the code is
 * worthless without the server's own exchange.
 */
authRouter.post(API.authAppleCallback, (req, res) => {
  const registered = appleWebRedirectUri().replace(API.authAppleCallback, '');
  if (!appleWebSignInConfigured() || !registered) {
    res.status(503).send('Sign in with Apple is not available.');
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const field = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
  // Back to the origin the browser started on, when that is one of Chord's
  // own - never an origin the request alone chose.
  const asked = appleStateOrigin(field('state'));
  const target = asked && asked.startsWith('https://') && isOwnWebOrigin(asked) ? asked : registered;
  const out = new URLSearchParams();
  const code = field('code').slice(0, 4096);
  if (code) out.set('apple_code', code);
  else out.set('apple_error', (field('error') || 'no_code').slice(0, 100));
  out.set('apple_state', field('state').slice(0, 200));
  // Apple sends the name once, as JSON, on the first authorization only.
  try {
    const user = JSON.parse(field('user')) as { name?: { firstName?: unknown; lastName?: unknown } };
    const first = typeof user.name?.firstName === 'string' ? user.name.firstName.slice(0, 80) : '';
    const last = typeof user.name?.lastName === 'string' ? user.name.lastName.slice(0, 80) : '';
    if (first) out.set('apple_first', first);
    if (last) out.set('apple_last', last);
  } catch {
    /* no name this time */
  }
  res.redirect(303, `${target}${appleReturnPath(field('state'))}#${out.toString()}`);
});

/**
 * Sign in with Apple (ADR 0156) - the iOS app, and the web app once the
 * callback above has handed it the code. The app posts Apple's
 * authorization code; the server exchanges it and resolves the user by
 * `apple_sub`, then by a verified, non-relay email an existing account
 * already holds, else creates one. 503 until the APPLE_* keys are set —
 * the flow is only offered when revocation on account deletion also works.
 */
authRouter.post(API.authApple, async (req, res, next) => {
  try {
    if (!appleSignInConfigured()) {
      res.status(503).json({ error: 'sign in with apple is not available' });
      return;
    }
    const parsed = AppleAuthRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const client = parsed.data.client ?? 'ios';
    if (client === 'web' && !appleWebSignInConfigured()) {
      res.status(503).json({ error: 'sign in with apple is not available on the web' });
      return;
    }
    const exchange = await exchangeAppleCode(parsed.data.authorizationCode, client).catch((err: Error) => {
      logger.warn('apple code exchange failed', { err: err.message });
      return null;
    });
    if (!exchange) {
      res.status(401).json({ error: 'apple sign-in failed' });
      return;
    }
    const { identity } = exchange;
    const givenName = parsed.data.givenName || null;
    const familyName = parsed.data.familyName || null;
    const providedName = [givenName, familyName].filter(Boolean).join(' ') || null;
    // A relay address's local part is noise, not a name.
    const ownEmail = identity.email && !identity.isPrivateEmail ? identity.email : null;
    const fallbackDisplay = providedName ?? ownEmail?.split('@')[0] ?? APPLE_FALLBACK_NAME;

    let user = await req.db
      .selectFrom('users')
      .selectAll()
      .where('apple_sub', '=', identity.sub)
      .executeTakeFirst();

    // Bind to an existing account only on proof of the same mailbox: Apple
    // says verified, and it is the user's real address, not a relay.
    if (!user && ownEmail && identity.emailVerified) {
      const byEmail = await req.db
        .selectFrom('users')
        .selectAll()
        .where((eb) => eb(eb.fn('lower', ['email']), '=', ownEmail))
        .where('shadow', '=', 0)
        .where('apple_sub', 'is', null)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      if (byEmail) {
        await req.db
          .updateTable('users')
          .set({
            apple_sub: identity.sub,
            display_name: byEmail.display_name ?? fallbackDisplay,
            first_name: byEmail.first_name ?? givenName,
            last_name: byEmail.last_name ?? familyName,
          })
          .where('id', '=', byEmail.id)
          .execute();
        user = await req.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', byEmail.id)
          .executeTakeFirstOrThrow();
        logger.info('apple sign-in bound to existing account by verified email', {
          userId: user.id,
        });
      }
    }

    if (!user) {
      const id = `u_${nanoid(12)}`;
      const base = (ownEmail?.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '');
      let username = base || `apple-${nanoid(6).toLowerCase()}`;
      const taken = await req.db
        .selectFrom('users')
        .select('id')
        .where('username', '=', username)
        .executeTakeFirst();
      if (taken) username = `${username}-${nanoid(4)}`;
      user = await req.db
        .insertInto('users')
        .values({
          id,
          username,
          display_name: fallbackDisplay,
          first_name: givenName,
          last_name: familyName,
          created_at: new Date().toISOString(),
          shadow: 0,
          apple_sub: identity.sub,
          email: identity.email,
          email_verified: identity.emailVerified ? 1 : 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      logger.info('created apple user', { userId: id, relay: identity.isPrivateEmail });
    } else if (providedName && (!user.first_name || !user.last_name)) {
      // Apple only shares the name on the first authorization — fill blanks,
      // never overwrite what the user set.
      await req.db
        .updateTable('users')
        .set({
          first_name: user.first_name ?? givenName,
          last_name: user.last_name ?? familyName,
        })
        .where('id', '=', user.id)
        .execute();
    }

    if (exchange.refreshToken) {
      await persistAppleRefreshToken(req.db, user.id, exchange.refreshToken);
    }

    await completeSignIn(req, res, {
      user,
      email: identity.email,
      signupRef: parsed.data.signupRef,
      fallbackDisplay,
      fallbackFirst: givenName,
      fallbackLast: familyName,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sign in with Microsoft (ADR 0293). The app runs the same Microsoft consent
 * the Outlook connect uses and posts the PKCE code here. One exchange yields
 * the identity (id_token) and the mailbox (refresh token): the user is resolved
 * by `microsoft_sub` (`<tid>:<oid>`), then by an existing account's email only
 * when Microsoft proves the email, else created — and the Outlook mailbox is
 * attached with no second consent.
 */
authRouter.post(API.authMicrosoft, async (req, res, next) => {
  try {
    if (!microsoftSignInConfigured()) {
      res.status(503).json({ error: 'sign in with microsoft is not available' });
      return;
    }
    const parsed = MicrosoftAuthRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const exchange = await exchangeOutlookCode(parsed.data)
      .then((ex) => {
        if (!ex.idToken) throw new Error('microsoft response missing id_token');
        return { ex, identity: parseMicrosoftIdToken(ex.idToken) };
      })
      .catch((err: Error) => {
        logger.warn('microsoft sign-in exchange failed', { err: err.message });
        return null;
      });
    if (!exchange) {
      res.status(401).json({ error: 'microsoft sign-in failed' });
      return;
    }
    const { ex, identity } = exchange;
    // The id_token's email, else the mailbox address Graph reports. Either is
    // stored; only a proven one may claim an existing account.
    const email = identity.email ?? ex.emailAddress;
    const displayFromName = identity.name ?? ex.displayName;
    const nameParts = (displayFromName ?? '').trim().split(/\s+/).filter(Boolean);
    const givenName = identity.givenName ?? nameParts[0] ?? null;
    const familyName = identity.familyName ?? (nameParts.slice(1).join(' ') || null);
    const fallbackDisplay = displayFromName ?? email.split('@')[0];

    let user = await req.db
      .selectFrom('users')
      .selectAll()
      .where('microsoft_sub', '=', identity.sub)
      .executeTakeFirst();

    if (!user && identity.email && identity.emailProven) {
      const byEmail = await req.db
        .selectFrom('users')
        .selectAll()
        .where((eb) => eb(eb.fn('lower', ['email']), '=', identity.email!))
        .where('shadow', '=', 0)
        .where('microsoft_sub', 'is', null)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      if (byEmail) {
        await req.db
          .updateTable('users')
          .set({
            microsoft_sub: identity.sub,
            display_name: byEmail.display_name ?? fallbackDisplay,
            first_name: byEmail.first_name ?? givenName,
            last_name: byEmail.last_name ?? familyName,
          })
          .where('id', '=', byEmail.id)
          .execute();
        user = await req.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', byEmail.id)
          .executeTakeFirstOrThrow();
        logger.info('microsoft sign-in bound to existing account by proven email', { userId: user.id });
      }
    }

    const created = !user;
    if (!user) {
      const id = `u_${nanoid(12)}`;
      const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, '');
      let username = base || `microsoft-${nanoid(6).toLowerCase()}`;
      const taken = await req.db
        .selectFrom('users')
        .select('id')
        .where('username', '=', username)
        .executeTakeFirst();
      if (taken) username = `${username}-${nanoid(4)}`;
      user = await req.db
        .insertInto('users')
        .values({
          id,
          username,
          display_name: fallbackDisplay,
          first_name: givenName,
          last_name: familyName,
          created_at: new Date().toISOString(),
          shadow: 0,
          microsoft_sub: identity.sub,
          email,
          email_verified: identity.emailProven ? 1 : 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      logger.info('created microsoft user', { userId: id, tenant: identity.tenantId });
    } else if (!user.first_name || !user.last_name) {
      // Fill blanks only; never overwrite a name the user set.
      await req.db
        .updateTable('users')
        .set({ first_name: user.first_name ?? givenName, last_name: user.last_name ?? familyName })
        .where('id', '=', user.id)
        .execute();
    }

    // The mailbox that came with the grant. A failure here must not fail the
    // sign-in: the person can still connect Outlook from Settings.
    await attachOutlookMailbox(req.db, user.id, ex).catch((err: Error) => {
      logger.error('microsoft sign-in mailbox attach failed', { userId: user!.id, err: err.message });
    });
    await completeSignIn(req, res, {
      user,
      email: user.email ?? email,
      signupRef: parsed.data.signupRef,
      fallbackDisplay,
      fallbackFirst: givenName,
      fallbackLast: familyName,
    });

    // A new account for a mailbox another account already reads: tell both
    // how to combine them (ADR 0293 addendum 2026-11-02). After sign-in, which
    // makes the personal chat: ensurePersonalGroup has no lock, so two callers
    // at once would make two personal chats.
    if (created) {
      runInBackground(tellAboutSecondAccount(req.db, user.id, ex.emailAddress), 'second-account notice');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * ADR 0345 - the app-review account's sign-in. 404 when not configured, so
 * the route says nothing about whether one exists; one answer for any wrong
 * email or password. The /api/v1/auth limiter already applies.
 */
authRouter.post(API.authReview, async (req, res, next) => {
  try {
    if (!reviewSignInConfigured()) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = ReviewAuthRequest.safeParse(req.body);
    if (!parsed.success || !reviewCredentialsMatch(parsed.data.email, parsed.data.password)) {
      logger.warn('review sign-in refused', { ip: req.ip });
      res.status(401).json({ error: 'wrong email or password' });
      return;
    }
    const user = await reviewAccount(req.db);
    logger.info('review sign-in', { userId: user.id, ip: req.ip });
    await completeSignIn(req, res, {
      user,
      email: user.email,
      fallbackDisplay: user.display_name ?? 'App Review',
      fallbackFirst: user.first_name,
      fallbackLast: user.last_name,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post(API.sessionLogout, async (req, res, next) => {
  try {
    const found = readSessionToken(req);
    if (found && cookieWriteLacksCsrf(req, found.via)) {
      // Else any site could sign a visitor out with a hidden form.
      res.status(403).json({ error: 'missing CSRF header' });
      return;
    }
    if (found) {
      await req.db.deleteFrom('sessions').where('token', '=', hashSessionToken(found.token)).execute();
    }
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * The tail both incremental consents share: bind the Google identity to the
 * signed-in user, then store the refresh token.
 *
 * A user with no `google_sub` (Apple-only, ADR 0156; demo seed users) takes
 * this Google identity — unless another row already holds it, in which case
 * the session is re-pointed there (sub is UNIQUE). An Apple-only row then
 * folds into that account (identity, profile, phone, devices, groups incl. the
 * personal chat), and the response carries the account's profile so the
 * client switches too.
 */
async function finishGoogleConsent(
  req: Request,
  res: Response,
  exchange: Awaited<ReturnType<typeof exchangeCode>>,
): Promise<void> {
  const me = await req.db
    .selectFrom('users')
    .select(['id', 'google_sub', 'email'])
    .where('id', '=', req.userId!)
    .executeTakeFirst();
  if (!me) {
    res.status(404).json({ error: 'user missing' });
    return;
  }
  let existingId: string | null = null;
  if (me.google_sub === null) {
    const existing = await req.db
      .selectFrom('users')
      .select('id')
      .where('google_sub', '=', exchange.identity.sub)
      .executeTakeFirst();
    existingId = existing?.id ?? null;
  } else if (me.google_sub !== exchange.identity.sub) {
    res.status(403).json({ error: 'consent account does not match signed-in user' });
    return;
  }
  if (!exchange.refreshToken) {
    // Google withholds the refresh token if the user previously consented
    // and we didn't pass prompt=consent. Mobile must include it.
    res.status(400).json({ error: 'no refresh token in response — re-prompt with prompt=consent' });
    return;
  }

  const targetUserId = existingId ?? me.id;
  if (existingId) {
    await req.db
      .updateTable('sessions')
      .set({ user_id: existingId })
      .where('user_id', '=', me.id)
      .execute();
    // A fold that fails must not also fail the mail/calendar connect. It rolls
    // back whole, so at least carry the Apple / Microsoft login, or the next
    // sign-in with it lands back in the row we just left.
    const fold = await foldSignInAccountInto(req.db, me.id, existingId).catch(async (err: Error) => {
      logger.error('sign-in account fold failed; moving the logins only', {
        from: me.id,
        to: existingId,
        err: err.message,
      });
      await moveAppleIdentity(req.db, me.id, existingId!);
      await req.db
        .transaction()
        .execute((trx) => moveMicrosoftIdentityIn(trx, me.id, existingId!));
      return null;
    });
    // ADR 0293 addendum — the folded account's mailboxes follow it.
    if (fold?.folded) await moveMailboxesTo(req.db, me.id, existingId);
  } else if (me.google_sub === null) {
    await req.db
      .updateTable('users')
      .set({
        google_sub: exchange.identity.sub,
        email: me.email ?? exchange.identity.email ?? null,
      })
      .where('id', '=', me.id)
      .execute();
  }
  await persistRefreshToken(
    req.db,
    targetUserId,
    exchange.refreshToken,
    exchange.grantedScopes,
    exchange.clientId,
  );
  // The Gmail on this account is the Google account just connected - not the
  // sign-in email, which for a Microsoft or Apple account is another address.
  await recordPrimaryGmailAddress(req.db, targetUserId, exchange.identity.email);

  const body: GoogleConsentResponse = { ok: true, scopes: exchange.grantedScopes };
  if (existingId) {
    const row = await req.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', existingId)
      .executeTakeFirstOrThrow();
    body.user = {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? undefined,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
      preferredName: row.preferred_name ?? undefined,
      email: row.email ?? undefined,
      createdAt: row.created_at,
    };
  }
  res.json(body);
}

/**
 * Incremental consent for Google Calendar read access (ADR 0015 read half).
 * The mobile client kicks off a fresh PKCE flow with calendar.readonly added
 * to the requested scopes; on success it posts the new code+verifier here.
 * We exchange, verify the same Google `sub` is in play, and replace the
 * refresh token + scopes on the user row. Login session is unaffected.
 */
authRouter.post(API.authGoogleCalendar, requireSession, async (req, res, next) => {
  try {
    const parsed = GoogleAuthRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const exchange = await exchangeCode(parsed.data).catch((err: Error) => {
      logger.warn('google calendar consent exchange failed', { err });
      return null;
    });
    if (!exchange) {
      res.status(401).json({ error: 'google consent failed' });
      return;
    }
    await finishGoogleConsent(req, res, exchange);
  } catch (err) {
    next(err);
  }
});

/**
 * Incremental consent for the Gmail reader (ADR 0062). Identical shape to the
 * calendar consent above: the mobile client runs a fresh PKCE flow with
 * gmail.modify added to the requested scopes and posts the code+verifier here.
 * Google returns the CUMULATIVE granted scope set, so persistRefreshToken
 * (which overwrites refresh_token_scopes) keeps any previously-granted calendar
 * scope working. gmail.modify is a RESTRICTED scope — gate the client entry
 * point behind GMAIL_ENABLED / verification.
 */
authRouter.post(API.authGoogleGmail, requireSession, async (req, res, next) => {
  try {
    const parsed = GoogleAuthRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const exchange = await exchangeCode(parsed.data).catch((err: Error) => {
      logger.warn('google gmail consent exchange failed', { err });
      return null;
    });
    if (!exchange) {
      res.status(401).json({ error: 'google consent failed' });
      return;
    }
    await finishGoogleConsent(req, res, exchange);
  } catch (err) {
    next(err);
  }
});
