# 0014 — Google-only auth for real users

**Status**: accepted
**Date**: 2026-05-03

## Context

Chord today signs users in with a username only — `POST /session`
takes `{ username }` and returns an opaque token. Fine for a demo,
useless for an app multiple developers can work on with real users.

We need real auth before we can:

- Hold any per-user data more sensitive than chat history (Google
  refresh tokens, profile JSON, family-graph PII).
- Distinguish "demo John" from "actual John" when two devs run the
  app from the same data dir.
- Talk to Google APIs at all (OAuth or nothing).

Three viable shapes: roll our own email/password, add a third-party
identity provider (Auth0, Clerk, Supabase Auth), or piggyback on
Google. The product also needs Google Calendar access regardless, so
"Google" is on the table whether or not it's the only login.

## Decision

**Google-only login for real users.** No email/password, no other
social providers. The existing username-only `POST /session` endpoint
is retained behind a `LLM_PROVIDER=mock`-style guard for tests and
local CI runs only — it is unreachable in any deployment where
`AUTH_MODE !== 'demo'`.

Implementation shape:

- **Mobile**: `expo-auth-session` PKCE flow against Google.
- **Server**: receives the authorisation code, exchanges it for an
  access + refresh token, fetches the userinfo, upserts a `users` row
  keyed by Google `sub`, and returns a Chord session token (same
  `x-chord-token` shape as today).
- **Token storage**: refresh token encrypted at rest with AES-GCM
  using a server-side `MASTER_KEY`. Access token is short-lived; not
  persisted, fetched on demand from the refresh token.
- **Calendar scope is requested separately** — see ADR 0015. Login
  only asks for `openid email profile`.
- **Three OAuth clients per project**: a Web client used by the
  server for code exchange, plus iOS and Android clients used by the
  Expo build at sign-in time. The mobile client never sees the web
  client secret. Server accepts whichever `redirect_uri` the client
  used in the code exchange request and forwards it verbatim to
  Google. All redirect URIs are configurable via env so each
  deployment (dev / staging / prod) registers its own.

## Alternatives considered

- **Email/password.** Lowest friction to start, highest ongoing cost:
  password reset flows, breach disclosure obligations, MFA, account
  recovery. None of that is the product.
- **Auth0 / Clerk / Supabase Auth.** Would handle the password +
  social + magic-link surface for us. Rejected for now: another
  vendor, another bill, another thing devs have to provision in
  staging. We can still adopt one later if we add non-Google providers.
- **Google + Apple + email/password from day one.** Apple sign-in is
  a real possibility (iOS app store may eventually require it if we
  add other social providers). Deferred: it's free to add later when
  we have a reason. Right now Google is also our calendar provider,
  which is what justifies the dependency.
- **Keep the username-only login as a fallback for users without
  Google.** Rejected: the product is "AI for family life with your
  calendar." A user without a Google account is not in the target
  segment for the MVP. We can revisit if Apple Calendar / iCloud
  surfaces become a target.

## Consequences

### What this commits us to

- **Hard dependency on Google as identity provider.** If Google is
  down, no one can sign in. Acceptable: same SLA story as Calendar.
- **`MASTER_KEY` becomes a real production secret.** Add to
  `example.env` with a clear "rotate this" warning. Rotating it
  invalidates all stored refresh tokens — users have to re-grant.
- **Demo session path stays in the codebase.** Tests and local mock
  development still need it. Gate it behind `env.AUTH_MODE === 'demo'`
  and never default to `demo` in any deployed config.
- **Schema additions on `users`**: `google_sub TEXT UNIQUE`,
  `email TEXT`, `email_verified INTEGER`, `refresh_token_ciphertext
  BLOB`, `refresh_token_iv BLOB`, `google_connected_at INTEGER`.
- **Account-deletion story**. Deleting a user must zero the refresh
  token row, not just mark deleted. Capture in a follow-up task.

### What we explicitly do NOT do

- **No password storage.** Ever.
- **No "link an email" flow.** Email comes from Google, period.
- **No multi-account-per-user.** One Chord user maps to one Google
  account. If a user wants both work + personal Google calendars in
  Chord, they sign in twice with two Chord users.
