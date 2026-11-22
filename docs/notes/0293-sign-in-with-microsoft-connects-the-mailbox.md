# ADR 0293 — Sign in with Microsoft, and the mailbox comes with it

**Status:** Accepted (built; not yet run against a live Microsoft account)
**Date:** 2026-10-23
**Amends:** ADR 0014 (Google-only login), ADR 0156 (Apple beside Google), ADR 0080 (Outlook mailbox)

## Context

Chord's logins are Google (ADR 0014) and Apple (ADR 0156). Outlook,
Hotmail and Microsoft 365 are only an *extra* mailbox attached from Settings
after sign-in (ADR 0080), which needs a session first. Someone whose only
mail is Outlook therefore had to sign in with Apple (iPhone only, or a web
Services ID) and then connect Outlook as a second step — and on Android or a
browser without Apple configured, could not get in at all without a Google
account they may not use.

The Outlook connect already runs an authorization-code + PKCE flow against
the multi-tenant `/common` Microsoft identity platform endpoint with the same
app (`MS_CLIENT_ID` / `MS_CLIENT_SECRET`), and its scope list already starts
with `openid email offline_access`. So the token response that attaches the
mailbox already carries an `id_token` — the identity is in hand and was being
discarded.

## Decision

**One consent, one code, two results.** A third login,
`POST /api/v1/auth/microsoft`, takes the same `{ code, codeVerifier,
redirectUri }` the Outlook connect takes. The server exchanges it once
(`exchangeOutlookCode`, which now also returns the `id_token`) and gets:

1. the **identity**, from the `id_token` in the token response (arrived over
   TLS from the token endpoint, so — like ADR 0156 — it is trusted after
   checking `aud` = `MS_CLIENT_ID`, `iss` =
   `https://login.microsoftonline.com/<tid>/v2.0`, `exp`, and that `tid` and
   `oid` are present); the client's copy of anything is never read;
2. the **mailbox**, attached through the same `attachOutlookMailbox` the
   Settings connect now calls (sealed rotating refresh token, Outlook
   calendar flag from the granted scopes per ADR 0228, push arm, first sync).
   No second consent screen.

Scopes asked at sign-in = the Outlook connect's list plus `profile` (for the
`name` claim), plus `Calendars.ReadWrite` when Outlook calendars are on —
identical to Settings, so the grant is the same whichever door was used.

**Identity is `tid:oid`**, stored in a new partial-unique
`users.microsoft_sub` (migration `120`). `oid` is unique only within a
tenant, and `sub` is pairwise per app (fine, but `oid` is what Graph and
every other Microsoft surface also call the user), so the pair is the key.

**Binding to an existing account needs a proven email.** Microsoft's `email`
claim is whatever the tenant says it is — the "nOAuth" class of attack is an
attacker's own tenant setting `mail` to a victim's address. The resolution
order is:

1. a user whose `microsoft_sub` matches;
2. else a non-shadow user with no `microsoft_sub` whose email equals this
   one, **only when the email is proven**: the token carries `xms_edov: true`
   (Microsoft verified the tenant owns that email's domain; an optional claim
   the app registration must be configured to emit), OR the account is a
   personal Microsoft account (`tid` = the consumer tenant
   `9188040d-6c67-4c5b-b112-36a304b66dad`) on a Microsoft-hosted consumer
   domain (outlook.com, hotmail.*, live.*, msn.com, passport.com) — Microsoft
   runs that mailbox, so the address *is* the account;
3. else create a new user (`email_verified` set from the same proof).

An unproven email is still stored on the new row, as Apple's relay addresses
are; it just never claims someone else's account.

**The mailbox keeps its own record.** The mailbox row is keyed by the
address Graph `/me` reports, exactly as a Settings connect would be, so
signing in again re-attaches (fresh token replaces a dead one, mirror kept)
rather than duplicating.

**Account deletion forgets, it cannot revoke.** Microsoft's identity
platform has no OAuth token-revocation endpoint for a third-party app (the
only Graph call, `revokeSignInSessions`, signs the person out of *every*
app — far beyond our grant). Deletion removes `microsoft_sub` with the user
row and the sealed refresh token with the `email_accounts` row; the token
then cannot be used by anyone, and the user can remove the app's consent at
account.microsoft.com / myapps.microsoft.com. The deletion log says so.

**Shown only when on.** `MICROSOFT_SIGN_IN_ENABLED` (default off) AND the MS
keys AND `AUTH_MODE=google` AND `OUTLOOK_PROVIDER` not `mock`;
`/health.microsoftSignIn` then carries `{ clientId, calendar }` (the client
needs the id before any session exists — the Settings path reads it from
`/me/email/status`, which needs one). The route answers 503 otherwise. A
separate flag rather than "MS keys are set" because the keys are already set
in prod for Outlook connect, and the `xms_edov` optional claim must be added
to the app registration before turning sign-in on.

**Every platform, one flow.** Web, iOS and Android all run
`expo-auth-session` against `/common/oauth2/v2.0/authorize` with the redirect
the Outlook connect already registers (`<web origin>/oauthredirect` on web,
`chord://oauthredirect` in the apps, opened in a Custom Tab on Android and
an ASWebAuthenticationSession on iOS). Android therefore needs no App Link of
its own (unlike Google, ADR 0081): Microsoft accepts the custom scheme.

## Consequences

- An Outlook-only person can create an account on any platform, and their
  mail starts syncing in the same step.
- Owner steps before enabling: add the `xms_edov` optional ID-token claim in
  Entra (Token configuration → email + xms_edov); confirm the app's redirect
  URIs include both above; set `MICROSOFT_SIGN_IN_ENABLED=true`. Without
  `xms_edov`, a work/school account never binds to an existing account by
  email — it gets its own (the safe failure).
- **An attached Outlook mailbox is not a Microsoft login (owner decision,
  2026-10-23).** A person who signed up with Google (or Apple) and later
  attached Outlook in Settings does NOT become able to sign in with that
  Microsoft account; signing in with it creates a separate account unless
  Microsoft proves the email is theirs (the binding rule above).
  `users.microsoft_sub` is written by Sign in with Microsoft only, never by a
  mailbox attach, because attaching a mailbox — a child's school account, a
  spouse's work account — does not prove the Microsoft login is the same
  person. Whenever someone asks why signing in with Microsoft made a new
  account, or asks to link an attached mailbox to login, this is the answer;
  changing it needs a new owner decision and ADR. See rejected alternatives.
- The `id_token` is not validated against Microsoft's JWKS, by the same
  reasoning as ADR 0156: it came straight from the token endpoint over TLS
  in exchange for a single-use code bound to our PKCE verifier and secret.
- Apple's 4.8 rule is about offering *an* equivalent privacy-preserving
  login when a third-party one exists; Apple stays on iOS, so adding
  Microsoft changes nothing there.

## Rejected

- **Binding on any matching `email` claim** — the nOAuth attack: a tenant
  admin can set any `mail` value.
- **Recording `microsoft_sub` when a mailbox is connected from Settings**,
  so the Outlook account could later log in. Attaching a mailbox is not the
  same claim as "this Microsoft account is me" — a parent attaching a
  child's school mailbox would hand that child's Microsoft login the
  parent's Chord account.
- **JWKS verification of the id_token** — no added assurance over a token
  received directly from the token endpoint (OIDC Core §3.1.3.7), and a key
  cache to keep fresh.
- **A separate sign-in-only consent, then the Settings mail consent** — two
  screens for what one grant already covers.
- **`sub` as the key** — pairwise per app; `tid:oid` is the identity every
  other Microsoft API (and a future second app) reports.
- **Turning it on whenever the MS keys exist** — they already exist in prod
  for Outlook connect, and the Entra claim configuration must come first.

## Addendum 2026-10-28: a Microsoft-made account folds into the Google one

**Context.** The owner signed in with Microsoft as `ownertest@hotmail.com`,
a mailbox already connected to their Google account. As designed above,
that made a second, separate Chord account. Connecting their Google login
from it then switched the session to the original account (ADR 0156
`finishGoogleConsent`) but merged nothing: the fold only ran when an Apple
login moved. The Microsoft account stayed behind with its Microsoft login,
so the next Sign in with Microsoft landed there again, and both accounts
synced the same Hotmail mailbox.

**Decision.** The ADR 0156 fold now runs when an Apple **or** a Microsoft
login moves (`foldSignInAccountInto`, `services/apple/apple-fold.service.ts`;
`moveMicrosoftIdentityIn` beside the Microsoft sign-in code). The proof is
the same as Apple's: the same session has just signed in as both. Only
`users.microsoft_sub` moves, and only a real Sign in with Microsoft writes
it, so the rule above still holds: a mailbox connected in Settings never
becomes a login, before or after a fold. A Google account that already has
a different Microsoft login takes nothing (as for Apple).

**Mailboxes follow** (`moveMailboxesTo`, `services/email-accounts`), after
the fold's transaction, one mailbox at a time, a failure logged and never
thrown:
- one the Google account already reads (same address, attached or its
  primary Gmail) is **dropped**: two copies sync the same mail twice;
- any other is **connected to the Google account with the same credential**
  and mirrors afresh. Mail is sealed under its owner's key (ADR 0201), so
  re-pointing the old copy would mean opening and re-sealing every row.

This applies to an Apple-made account's mailboxes too; they used to stay on
the emptied row and keep syncing.

**Consequences.**
- Mail-derived per-user data on the emptied row (classifications, drafts,
  receipts, sealed under its key) stays there unread. A moved mailbox's mail
  is classified again on the Google account at the normal sync pace.
- Mailbox colours and the default-send choice keyed on the old account id
  are not carried.
- A Microsoft account folds only when it connects Google. An account like the
  owner's test one (`u_ESk4pQ9dJENN`) does nothing until then.

**Rejected.**
- **Moving the mirrored mail rows to the new owner** — they are sealed under
  the old owner's key; a re-seal pass for one rare event.
- **Keeping both copies of a shared mailbox** — every message twice, and the
  AI passes paid twice.
- **Folding on a matching email address** — the nOAuth reason above; only a
  session that signed in as both is proof.

## Addendum 2026-11-02: both accounts are told they are two

**Context.** The owner signed in with Microsoft again (consumer tenant,
the Hotmail mailbox already attached to their Google account), got a new
account as designed, then signed out and signed in with Google. That is a
fresh session, so nothing merged; the merge above runs only when Google is
connected from INSIDE the Microsoft-made account, and nothing said so.

**Decision.** When Sign in with Microsoft creates a NEW account and another
real account with a Google login already reads that address (an attached
mailbox, or its sign-in email), Chord posts one message in each account's
personal chat (`services/microsoft/second-account-notice.ts`, started from
the route after sign-in finishes, best-effort):
- the new account: it was just made, "if you already use Chord with a Google
  account you now have two", and the steps (Settings, Connected accounts,
  Google, connect that account);
- the existing account: someone signed in with Microsoft as that address and
  got a separate account; if it was them, sign in with Microsoft and connect
  this Google account from there; if not, nothing changed.

Nothing merges and no rule above changes. The new account is **never told
which account** reads the mailbox: it may be a parent's account reading a
child's school mailbox. The existing account already holds the mailbox, so
naming it there discloses nothing. An existing account with no Google login
(Apple or Microsoft only) is not told: connecting Google is the only way to
combine, so the steps would be wrong. A returning sign-in is not a new
account and posts nothing.

**Found with it.** `ensurePersonalGroup` checks and then creates with no lock,
so two calls at once for a brand-new user make two personal chats; the first
version of this notice ran beside sign-in's own call and did exactly that.
The notice now starts after sign-in. Existing callers run after sign-in has
made the chat, so the function is left as is; a lock is the fix if a new
caller can race sign-in.

**Rejected.**
- **Merging on the signal** — the 10-28 rule stands: a shared mailbox is not
  proof of one person.
- **Naming the other account to the new one** — the child's-mailbox case.
- **One notice in the new account only** — the person who actually reads the
  existing account is the one most likely to act.

## Addendum 2026-11-16: the apps redeem their code without the secret

Every sign-in from the iPhone app failed ("microsoft sign-in failed"):
Microsoft answered AADSTS90023, "Public clients can't send a client
secret." The apps return to `chord://oauthredirect`, which Entra registers
under "Mobile and desktop", i.e. a public client; the server sent
`MS_CLIENT_SECRET` on every token request. Android uses the same address,
and the Settings Outlook connect in the apps the same exchange, so both
were broken too; web (`https://.../oauthredirect`, "Web") worked.

Now a code that came back to a non-https address is redeemed without the
secret (`isPublicClientRedirect` in `outlook-oauth.ts`), and the mailbox
credential records `publicClient: true` so its refreshes (also refused
with a secret) leave it out too, kept across token rotation. The web
client is unchanged. No migration: no app-made Outlook credential existed.

**Addendum 2026-11-16 (the Gmail's own address)**: an account made with
Sign in with Microsoft (or Apple) that later connects Gmail showed its
Microsoft sign-in email as the Gmail mailbox - in the New message From
picker, Settings' Gmail row, the default-mailbox "from" line on chat
email, mailbox de-duplication and the AI-app connector - because every
reader took `users.email`. The primary Gmail's address is now stored at
Google sign-in / Gmail consent (`users.defaults` `gmail_address`), read
once from the Gmail profile for accounts connected before this, and
forgotten on disconnect; one reader, `primaryGmailAddress`
(`email/primary-gmail-address.ts`), falls back to `users.email` only for
an account made with Google. `EmailStatus.gmailAddress` carries it to the
app.
