# 0031 — UUID-referrer soft-link from Telegram welcome DM

**Status**: accepted
**Date**: 2026-05-17
**Related**: [ADR 0014 — Google-only auth](./0014-google-only-auth.md),
[ADR 0010 — IM connectors](./0010-im-connectors.md),
[Feedback — Telegram identity = app-first only](../../) (memory note)

## Context

A first-time Telegram user who DMs the bot today gets a welcome
message: "sign up at $SIGNUP_URL, then paste the pair code from
Settings → Connectors → Telegram." Two-trip flow. The pair-code paste
is the friction. We can keep app-first identity (Google OAuth is still
the only thing that creates a real Chord user) while removing the
copy-paste step entirely — by binding the welcome link to a single-use
referrer token.

The constraint we will not break: `[[feedback_telegram_identity_policy]]`
— no magic-link email onboarding. The bot is not allowed to *create* a
Chord account from a Telegram-side action. Sign-up must complete
through Google.

## Decision

The welcome DM mints a `signup_intents` row keyed by `(platform,
external_user_id)` and appends `?ref=<token>` to the signup URL. On
successful Google sign-in the mobile client passes the token to
`POST /auth/google`. The server consumes it inside the same
transaction that runs the existing shadow-merge logic
(`mergeOrLinkExternalIdentity`), re-pointing the TG `external_identities`
row at the newly-signed-in user — same end state as a successful
`/chord pair <code>`, just without the user having to paste anything.

### Properties

- **Token is a referrer, not an authenticator.** It cannot create an
  account on its own; consume only fires after a verified Google
  session is established. The token answers "which TG identity is
  asking?", not "is this user allowed in?".
- **Single-use, time-limited.** 22-char nanoid, 14-day expiry,
  `consumed_at` flips on first successful consume. Replay = noop.
- **Idempotent mint per TG id.** Re-DMing the bot reuses the open
  intent; a stale link in chat scrollback is the same link they get
  the next time. Once consumed, a fresh DM mints a new one.
- **Soft-link only.** A second TG identity signing up against the
  same Google account, or the inverse, hits the existing
  `mergeOrLinkExternalIdentity` policy: shadows merge; conflicts with
  a different real user are logged + skipped. No new conflict modes.
- **Pair code stays the canonical fallback.** Group-side first
  sightings (user shows up in a bound group before ever DMing the
  bot) don't get a referrer token because there's no DM channel to
  bind it to. The in-group shadow nudge still points at the pair-code
  flow. Token mint failure also degrades cleanly to the pair-code
  prose.

### Why this doesn't violate the app-first policy

The policy exists because we don't want anyone to *become a Chord
user* via a Telegram-side flow — that bypasses Google email
verification and the privacy-policy consent path. With the referrer
token: Telegram only carries opaque bytes; Google still verifies the
email; the user must complete OAuth in the Chord app on a real
device. The TG → real user link is established *after* a successful
verified sign-in, not before. Same auth invariants as today; just one
fewer manual step.

## Implementation

- **Schema** — migration `040_signup_intents_email_nullable` recreates
  the `signup_intents` table with `email` nullable. The table was
  empty in every deployment (the legacy "collect email in DM" flow it
  was built for was killed before any code wrote to it).
- **Service** — `signup-intents.service.ts` exposes:
  - `mintForTg(db, externalUserId): Promise<string>` — idempotent.
  - `consumeForTg(db, { token, ownerUserId, ownerEmail, ownerDisplay })`
    — transactional, calls `mergeOrLinkExternalIdentity`.
- **Mint** — `welcome-dm.service.ts` calls `mintForTg` and threads the
  token into `renderWelcome` + `signupActionCards`. Both the prose
  link and the inline button carry `?ref=...`.
- **Consume** — `routes/auth.ts` reads `signupRef` from the OAuth
  request body (now part of the kernel `GoogleAuthRequest` schema)
  and consumes after the user record is created/claimed. Failure is
  logged, never blocks sign-in.
- **Mobile** — landing page captures `?ref=` from `window.location`,
  stashes in AsyncStorage to survive the OAuth redirect, then passes
  it on `authGoogle` and clears on success. A small banner tells the
  user "you're linking from Telegram" so the auto-link isn't
  invisible.

## Alternatives considered

1. **Keep pair-code-only.** Status quo. Two-trip flow stays. Rejected
   for friction.
2. **Email magic link from the bot.** The killed flow that migration
   037 was originally for. Violates the no-magic-link policy and
   creates a Telegram-side path to an authenticated session.
   Rejected.
3. **Telegram Login Widget.** Telegram's first-party `auth.telegram.org`
   flow returns a signed TG identity to a web page. We could trust it
   and create a real Chord user from a TG-only signal. Same policy
   violation as (2) — Chord identity would originate from a non-Google
   source. Rejected for the same reason.
4. **Bake the TG user id into the URL.** No referrer table needed;
   server reads `?tg=<id>` on sign-in and merges. Rejected: TG numeric
   ids are easily harvestable from group chats, and a leaked/shared
   link with the id in plaintext lets a third party hijack the merge.
   Opaque random token forces possession of the original DM.

## Tests

- `signup-intents.test.ts` covers mint idempotency, consume
  happy-path (shadow merge + identity re-point), consume on no
  pre-existing shadow, expired token, already-consumed token,
  unknown token.
- `welcome-dm.test.ts` (existing) updated to assert the welcome body
  carries `?ref=` and references the auto-link behavior rather than
  the pair-code paste.

## Open questions / follow-ups

- **Native deep-link.** Today the bot link only handles the web path
  (Expo dev server / chordapp.ai). Native (iOS/Android) intercept via
  `Linking.getInitialURL` is wired up in store/auth elsewhere but not
  yet plumbed into the landing page's `captureAndStoreSignupRef`.
  When we ship native, add a `Linking.addEventListener('url', ...)`
  hook with the same `?ref=` parser.
- **Group-side referrer.** A TG user who first appears in a bound
  group gets a shadow with no DM hook. The in-group nudge could carry
  a one-time deep link unique to that shadow id, but the user might
  not be the one who clicks it (links forwarded in chats). Defer until
  there's a clean way to scope a token to a TG user without a private
  DM channel.
