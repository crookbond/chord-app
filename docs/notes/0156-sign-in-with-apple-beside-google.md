# 0156 — Sign in with Apple beside Google

**Status**: accepted
**Date**: 2026-09-10
**Relation**: amends [0014](./0014-google-only-auth.md) (Google is no longer the
only login); follows [0075](./0075-stripe-checkout-without-the-sdk.md)'s
no-SDK posture and [0043](./0043-account-deletion.md)'s revoke-on-delete. Public
release blocker O2 in [`../tasks/friends-and-family-release.md`](../tasks/friends-and-family-release.md).

## Context

The public App Store listing is bound by Apple guideline 4.8: an app that uses a
third-party login (Google Sign-In) for the user's primary account "must also offer
as an equivalent option another login service" that limits collection to name and
email, lets the user keep their email private, and does no advertising tracking.
Chord's only login is Google. The email-client exception ("a client for a specific
third-party service") is a weak fit: Chord has features that work with no mail at
all, Gmail is optional, and it reads four providers.

Two options satisfy the rule: add Sign in with Apple, or make phone the only login
(which would then be "exclusively" Chord's own account system). Phone-only would
supersede ADR 0014, migrate every Google-anchored user, pay per login, and turn a
SIM swap into an account takeover of a mailbox mirror. This ADR takes the first.

## Decision

**Sign in with Apple is a second login, on native iOS, beside Google.**

1. **Server-side code exchange, no SDK, no JWKS.** The app sends Apple's
   single-use **authorization code**; the server exchanges it at
   `https://appleid.apple.com/auth/token` with a `client_secret` it signs itself
   (an ES256 JWT from the team's `.p8` key — `node:crypto`, no dependency). The
   `id_token` in that response arrived directly from Apple over TLS, which OpenID
   Connect Core §3.1.3.7 accepts in place of a signature check; the server still
   checks `iss`, `aud` (the bundle id), `exp` and `sub`. The client's own
   `identityToken` is **not** trusted. The code is single-use and five-minute-lived,
   so the exchange is also the replay guard — which is why no nonce is added.
2. **The feature is on only when it can also be undone.** Apple requires an app
   that offers Sign in with Apple to revoke the user's tokens when they delete
   their account, which needs a refresh token (from the exchange) and the same
   signed secret. So `APPLE_TEAM_ID` + `APPLE_KEY_ID` + `APPLE_PRIVATE_KEY` must
   all be set, and `AUTH_MODE=google`, or the route answers **503** and `/health`
   reports `appleSignIn: false` — the app renders the button only when the server
   says the whole flow works. The refresh token is sealed with `MASTER_KEY` like
   Google's (`users.apple_refresh_token_*`) and revoked, best-effort, before the
   ADR 0043 teardown.
3. **Identity is `users.apple_sub`** (partial-unique, migration `068`). Resolution
   order on sign-in:
   - a user with that `apple_sub` → that user;
   - else a non-shadow user whose `email` equals Apple's email, **only when Apple
     marks it verified and not a private-relay address** → bind `apple_sub` to that
     user. Both providers proved control of the same mailbox; this is the rule the
     Google route already uses to claim pre-seeded rows. It is what stops an
     existing Google user who taps the Apple button on a new phone from landing in
     an empty second account;
   - else a new user.
4. **A name is only offered once.** Apple returns the user's name on the first
   authorization only, to the device, never in the token. The app forwards it and
   the server uses it when creating the user (or filling a blank). Without one, a
   real email's local part is used; a relay address's local part is noise, so the
   fallback is `Chord user` — the user can rename in Settings or tell the bot.
5. **Connecting Google later carries the Apple identity along.** The Calendar/Gmail
   consent routes already re-point the session when the Google account belongs to
   another Chord user. When that happens to an Apple-only account, `apple_sub` and
   its token **move** to the Google user (if it has none), so the next Apple
   sign-in lands in the same account instead of flip-flopping back to the empty
   one. The emptied Apple row is left in place, like the demo rows the re-point
   already leaves.

## Scope

- **Native iOS only** (`expo-apple-authentication`, `ios.usesAppleSignIn`).
  Guideline 4.8 is about the iOS app. Web and Android keep Google only for now.
  An Apple-only user who wants the web app connects Google from Settings once
  (point 5 makes that land in the same account) — or waits for web Apple sign-in,
  which needs an Apple Services ID, domain verification and a `form_post` callback
  route, and is a follow-up, not this change.
- Apple's private-relay addresses receive mail only from domains registered with
  Apple's relay service. Chord sends users no mail today; any future user-facing
  mail must register its sending domain first.

## Consequences

- **Owner setup in the Apple Developer portal**: enable *Sign in with Apple* on
  the `app.chord.demo` App ID (EAS syncs the capability from `usesAppleSignIn`),
  create a key with Sign in with Apple enabled, and put its id, the team id and
  the `.p8` contents in the deploy env. A **new native build** is required — the
  module is native, so an over-the-air update cannot add it.
- The privacy policy must say what Apple sign-in shares (a name if the user
  chooses, and an email that may be a relay address) before the App Store
  submission.
- `users.google_sub` is no longer guaranteed for a real user. Code that assumed
  every non-demo user has Google keeps working because the Calendar/Gmail paths
  already handle "not connected".

## Rejected

- **Phone as the only login** — see Context; it remains open as a product
  question, not as the way to satisfy 4.8.
- **Verifying the client's `identityToken` against Apple's JWKS** instead of
  exchanging the code — needs key fetching and caching, and still leaves no
  refresh token to revoke, which Apple requires anyway.
- **Linking by any matching email** — a relay address never matches, and an
  unverified one is not proof; binding on either would let an address someone
  typed into Apple claim a Chord account.
- **Web Apple sign-in in the same change** — a separate Apple configuration and
  callback route, for a surface the App Store rule does not cover.

## Addendum 2026-09-11 — the re-point folds the account, not just the identity

Point 5 moved `apple_sub` and stopped there, which fixed the *next* sign-in and
left the one in progress broken. Someone who signed in with Google, later signed
in with Apple behind a relay address (so nothing bound by email, point 3), and then
connected Gmail was re-pointed to their Google account on the server — but the
consent answered `{ ok, scopes }`, so the app kept the Apple row's profile (`Chord
user`), its id, and its cached chats until a relaunch. And whatever the Apple
session had done in the meantime — its personal chat, a verified phone, the family
joined through an invite link (ADR 0047) — stayed on a row nobody can sign in to
any more, because it now holds neither `google_sub` nor `apple_sub`.

The Google connect is proof enough to fold the whole account: the same session
just authenticated as both, the bar point 5 already relied on. So when the Apple
identity moves (`foldAppleAccountInto`, `services/apple/apple-fold.service.ts`, one
transaction, a no-op unless it did), everything else follows too:

- **Profile blanks** — `display_name`, `first_name`, `last_name`,
  `preferred_name`, `last_tz` fill the Google row only where it is empty. The
  Google account's own values win; the `Chord user` placeholder never copies.
- **A verified phone stays verified.** The person who proved the number is the
  person the Google account belongs to — ADR 0064's fresh-proof rule is about a
  number moving between *people*, and this is one person. A user row holds one
  number, so when the Google row already has its own, that one stays and the
  Apple row's is **released**, not left verified on an account nobody can reach
  (contact discovery, ADR 0065, would keep resolving people to it).
- **Linked identities** (`external_identities` — a WhatsApp or Telegram chat
  tied while Apple-only) and **this device's push tokens**.
- **Every group.** The personal chat folds into the Google account's own through
  ADR 0053's `consolidatePersonalGroupInto` (drift-guarded against new
  group-scoped tables); so does a pair group (ADR 0067) with someone the Google
  account already has a pair with. Other groups move their membership, and a
  pair group with nobody new is re-keyed. The roster persona is handed over by id
  (facts filed against it stay attached), renamed only if its name was the one
  seeded from the Apple row.
- **Everything the Apple row authored** — messages, and the user-FK columns ADR
  0053's shadow merge already enumerates (`reattributeUserFkColumns`, exported
  from it rather than copied), plus `personas.managed_by` and both directions of
  `contact_links`. The briefing collapses to one via `rescheduleDailyScanForUser`.
- **Event copies** (ADR 0040 gives each member their own, keyed by `ical_uid`)
  move where the Google row has none — they are its only view of groups the
  Apple row joined — and are dropped where it already holds that event, which
  would otherwise show twice.

The consent response gains `user` (`GoogleConsentResponse`) **only** when the
session was re-pointed; the app treats a different id as an account switch —
clears cached chats, adopts the profile, reloads Settings.

A fold that throws rolls back whole and does **not** fail the connect: the route
logs it at `error` and falls back to moving only the Apple identity (point 5's
old behaviour), since blocking someone's mail on a merge edge case is worse than
a partial one.

The emptied Apple row itself **stays**: deleting a real user row means ADR 0043's
teardown list, and with both login identities gone nothing can reach it. Mailboxes
or calendars connected while Apple-only are not moved — their mirrors are keyed by
user (and ADR 0106 scopes category ids by it) — but connecting Google is the very
act that triggers the fold, so in practice there are none.

The consent routes also stopped writing before they could fail: a response with
no refresh token now answers 400 **before** re-pointing anything, where it used to
re-point the session and then refuse.

## Addendum 2026-10-01 — Sign in with Apple on the web

Scope said web keeps Google only. That left someone who made their account with
Apple on the phone with no way into chordapp.ai except connecting a Google
account first, and the web login said nothing about it. The web login now
offers the same sign-in, when `APPLE_SERVICES_ID` is set.

- **A second Apple client, same team and key.** A browser cannot use the app's
  bundle id; Apple issues web codes to a *Services ID*. A code, its id_token
  audience and the refresh token behind it all belong to ONE client, so
  `exchangeAppleCode`, `parseAppleIdToken` and `buildAppleClientSecret` take the
  client (`ios` | `web`), and `AppleAuthRequest.client` says which one a code
  came from. A token issued to the other client is refused (401). `apple_sub`
  is the same for both (it is scoped to the team), so the web sign-in lands in
  the account the phone made.
- **Redirect, not Apple's JS.** Asking for name and email forces
  `response_mode=form_post`: Apple POSTs the result cross-site to a registered
  Return URL. `POST /api/v1/auth/apple/callback` receives it and only relays -
  a 303 to the web app with the code, state and (first time only) name in the
  URL **fragment**, which never reaches a server or an access log. The web app
  then redeems the code through the ordinary `POST /auth/apple`, so identity
  resolution, the invite/referrer hand-off and the session are the one code
  path. The callback trusts nothing: `state` is generated and checked by the
  browser that started the flow (sessionStorage), and the code is worthless
  without the server's exchange.
- **Offered only when it can work.** `/health` returns
  `appleWeb: { clientId, redirectUri } | null`; null unless the iOS flow is
  configured, a Services ID is set, and the web origin is https (Apple refuses
  http and localhost, so it is off in local dev by construction). The web login
  shows the button and says "Apple or Google" only then.
- **Revocation asks as both clients.** The stored refresh token is the newest
  sign-in's and we do not record which client issued it; Apple revokes only for
  the issuing client. On account deletion we call revoke as each configured
  client and count it done if either is accepted. Chosen over a
  `apple_refresh_token_client` column: one extra best-effort call at deletion,
  no migration.

Owner setup: create the Services ID in the Apple Developer portal (primary App
ID = the Chord app, domain `chordapp.ai`, Return URL
`https://chordapp.ai/api/v1/auth/apple/callback`), set `APPLE_SERVICES_ID`, deploy.
No new app build is needed - this is web only.

Rejected: Apple's `appleid.auth.js` popup (third-party script on the login page,
popup blockers, and it still needs the Return URL registered); putting the code
in the query string (reaches nginx and the access log); completing the sign-in
inside the callback and handing the web app a session token in the URL (a
session credential in an address bar, and a second copy of the sign-in path);
dropping the email scope to allow a plain query redirect (no email means no
match to an existing Google account - ADR point 3). Since run against Apple by
the owner (2026-10-25).
