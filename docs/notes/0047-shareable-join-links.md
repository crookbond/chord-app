# 0047 — Shareable group-invite links

**Status**: accepted
**Date**: 2026-06-09
**Related**: [ADR 0031 — UUID-referrer soft-link from TG welcome DM](./0031-uuid-signup-soft-link.md),
[ADR 0045 — Group lifecycle (invite regeneration)](./0045-group-lifecycle.md),
[ADR 0014 — Google-only auth](./0014-google-only-auth.md)

## Context

Joining a group meant hand-carrying a short invite **code**: the inviter
copied it from Group settings, sent it over some channel, and the recipient
opened Chord → Chats → "Join by code" → pasted → Join. The code mechanism
already works end-to-end (`POST /api/v1/groups/join`, `joinGroupByCode` in
`server/src/services/groups.service.ts`); the friction was entirely in the
manual hand-off and the recipient having to find the right screen.

We want a single clickable artifact: a URL that, when opened, joins the
recipient to the group and drops them in the chat — no typing, no hunting for
the join screen.

## Decision

Add a client route `/join/<CODE>` (`mobile/app/join/[code].tsx`) that consumes
an invite code. The shared link is `<web-origin>/join/<CODE>`. No server
change — the route calls the existing join endpoint.

- **Signed in** → join immediately and `router.replace('/groups/<id>')`.
- **Signed out** → stash the code in AsyncStorage (`chord.pendingJoinCode`),
  redirect to the landing page to sign in; after sign-in the welcome screen
  reads the stashed code and redirects back to `/join/<CODE>`, where `user` is
  now set and the join completes.

The link points at the **web** app and is always an absolute `http(s)://`
URL — never a bare relative `/join/...`. `inviteUrl()` (`mobile/src/api.ts`)
resolves the base in order: `window.location.origin` on web (so dev / preview
/ prod work with zero config) → `EXPO_PUBLIC_WEB_BASE` when set on native →
the Expo dev-server `hostUri` (same Metro instance serves the web app, so
`http://<hostUri>/join/...` is valid in native dev) → `http://127.0.0.1:8081`
as a last resort.

### Why the AsyncStorage stash

Google OAuth on web is a full-page navigation (`/` → Google →
`/oauthredirect` → `/`), which drops in-memory React state and URL params.
This is the **same problem ADR 0031 solved for the Telegram `?ref=` referrer**,
and we reuse its proven shape verbatim: write to AsyncStorage before the
redirect, re-read after. The pending-join code and the signup-ref are
independent keys and compose — a user can arrive via a Telegram link and an
invite link is not in play, or vice-versa.

### Properties

- **The code is the authorization, the link is just transport.** The link
  carries the same code shown in settings; possession of the link == possession
  of the code. Resetting the invite (ADR 0045) invalidates every old link, as
  expected — a stale link surfaces "invite not found" on the join screen.
- **Idempotent.** `joinGroupByCode` no-ops if the user is already a member, so
  re-opening a link is safe.
- **Personal groups reject.** `joinGroupByCode` returns null for `kind =
  'personal'`; the join screen shows the standard error.
- **Redirect gating.** The welcome screen waits until it has read storage
  (`joinChecked`) before its post-auth redirect, so a freshly signed-in user
  never flashes past a pending join into `/groups`.
- **Paste-tolerant.** The legacy "Join by code" box also accepts a pasted full
  link via `extractInviteCode()` (`mobile/src/join-code.ts`), so either
  artifact works there.

## Alternatives considered

1. **Query param on the landing page (`/?join=CODE`).** Works, but overloads
   the landing route and reads worse when shared. A dedicated `/join/<CODE>`
   path is self-describing and keeps the join logic in one screen. Rejected.
2. **Server-minted single-use link tokens (à la ADR 0031's referrer).** The
   referrer token exists because a Telegram identity must not *create* an
   account. Group join has no such invariant — the invite code is already the
   shared secret and is revocable via reset. A second token layer would add
   schema + endpoints for no security gain. Rejected as over-engineering.
3. **Native `https://` deep-linking into the app.** Requires Apple
   App-Site-Association / Android App Links domain verification. Out of scope
   at the time; the link opens the web app, which is the demo surface.
   **No longer deferred — see [ADR 0048](./0048-native-deeplinks-for-invite-links.md),
   which adds the verified-domain hand-off on `chordapp.ai`.**

## Implementation

- **Route** — `mobile/app/join/[code].tsx`; registered in
  `mobile/app/_layout.tsx` (`headerShown: false`).
- **Shared helpers** — `mobile/src/join-code.ts`: `PENDING_JOIN_CODE_KEY`,
  `readPendingJoinCode`, `clearPendingJoinCode`, `extractInviteCode`.
- **Link builder** — `inviteUrl()` in `mobile/src/api.ts`.
- **Welcome consume** — `mobile/app/index.tsx` loads the pending code on mount,
  shows an "invited to a group" banner when signed out, and redirects to
  `/join/<CODE>` after sign-in.
- **Invite UI** — `mobile/app/groups/[id]/settings.tsx` leads the Invite
  section with the copyable link; the raw code stays as a secondary affordance.
- **Config** — optional `EXPO_PUBLIC_WEB_BASE` documented in `example.env`.

## Open questions / follow-ups

- **QR code** for the invite link (in-person sharing). Easy add, not requested.
- **Native deep-link** — done in [ADR 0048](./0048-native-deeplinks-for-invite-links.md)
  via verified Universal Links / App Links on `chordapp.ai`.
