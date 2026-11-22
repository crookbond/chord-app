# 0080 — Multi-account email: Outlook / Microsoft 365 + Yahoo (generic IMAP)

Date: 2026-07-24
Status: accepted

## Context

The email reader (ADR 0060–0079) is single-account and Gmail-shaped: sync
state lives in `gmail_*` columns on `users`, threads key on
`(user_id, gmail_thread_id)`, OAuth is Google-only and shared with Calendar,
and the only provider seam is mock-vs-real `GmailApi`. Users asked to attach
additional mailboxes — Outlook.com / Microsoft 365 and Yahoo.

Provider landscape:

- **Outlook.com and Microsoft 365 are the same API** — Microsoft Graph serves
  both consumer and work/school accounts through one multi-tenant app
  (`/common` endpoint, `Mail.ReadWrite` + `Mail.Send` + `offline_access`).
  Microsoft disabled basic-auth IMAP in 2024, so Graph is the only sane route.
- **Yahoo's mail API is approval-gated**; the practical third-party route is
  IMAP + a user-generated app password. An IMAP provider is inherently
  generic: AOL, iCloud Mail, and any custom IMAP server are the same code
  with different host presets.

## Decision

### 1. Additive `email_accounts` table; Gmail does not move

One row per attached mailbox: `provider ('outlook'|'imap')`, `email_address`,
sealed auth blob (`auth_ciphertext/iv/tag` via `utils/crypto-tokens.ts` —
Outlook: `{refreshToken}`; IMAP: `{host,port,smtpHost,smtpPort,username,password,preset}`),
per-account sync state (`sync_cursor` JSON text, `synced_at`,
`backfill_done`, `status 'ok'|'reconnect'`). Unique
`(user_id, provider, email_address)`.

The user's Gmail mailbox stays exactly where it is (columns on `users`,
threads with `account_id NULL`). Migrating Gmail into `email_accounts` is a
follow-up, not this ADR — the additive shape means zero migration risk for
every existing mailbox and no rewrite of the Google OAuth/Calendar token
sharing (ADR 0014/0062).

### 2. `account_id` threading + account-prefixed provider ids

`email_threads` / `email_messages` gain a nullable `account_id`
(FK → email_accounts ON DELETE CASCADE). Provider-native thread/message ids
are stored **account-prefixed** (`<accountId>:<nativeId>`) in the existing
`gmail_thread_id` / `gmail_message_id` columns — semantically those columns
are now "provider thread/message key". Rationale: every downstream surface
(classifier, tiles, magics provenance `gmail:<threadId>`, extraction marks,
routing, retraction) keys on those strings and only needs them unique per
user; prefixing guarantees that without touching any consumer. Renaming the
columns is deliberate churn we skip.

### 3. Outlook provider — bare-fetch Microsoft Graph

`services/email-accounts/outlook-*.ts`, no SDK (mirrors the Google style):

- **OAuth** (`outlook-oauth.ts`): `login.microsoftonline.com/common/oauth2/v2.0`,
  auth-code + PKCE from the client, confidential exchange server-side
  (`MS_CLIENT_ID` / `MS_CLIENT_SECRET`). Identity read from Graph `/me`.
  Refresh-per-call like Google; `invalid_grant` marks the account
  `status='reconnect'` (no cross-contamination with the Google nudge).
- **Sync** (`outlook-api.ts` + `outlook.service.ts`): **Inbox delta query**
  (`/me/mailFolders/inbox/messages/delta`, initial request filtered to the
  `GMAIL_BACKFILL_DAYS` window) — the `deltaLink` is the per-account cursor.
  A message `@removed` from Inbox (archive/delete/move) marks the mirror
  message archived — matching ADR 0073's "archived is hidden everywhere"
  semantics. Bodies lazy-fetch on thread open, like Gmail. Sent replies are
  upserted locally at send time (v1 does not delta the SentItems folder).
- **Write-back**: reply via the Graph `reply` action (recipient overrides +
  comment), `isRead` via PATCH, archive via `move` to the well-known
  `archive` folder. Gmail label operations are a no-op for Outlook threads.

### 4. IMAP provider — generic, preset-driven (Yahoo first)

`services/email-accounts/imap-*.ts` using `imapflow` + `mailparser` (read)
and `nodemailer` (SMTP send) — the one place hand-rolling the protocol would
obscure more than it helps. Presets (`yahoo`, `aol`, `icloud`, `custom`)
live in kernel so the client renders the right app-password instructions.

- **Backfill**: `SINCE <window>` UID search on INBOX, envelope+flags+source
  fetch, parse via mailparser. **Incremental**: UIDs greater than the stored
  `lastUid` (cursor `{uidValidity,lastUid}`); a `UIDVALIDITY` change wipes
  and re-backfills the account mirror. Flags for recent known UIDs are
  re-read each tick so read/unread converges; a UID that vanishes from INBOX
  marks the message archived.
- **Threading**: IMAP has no thread ids — pure helpers thread by
  `References`/`In-Reply-To` root, falling back to normalized subject +
  counterpart. Deterministic, unit-tested.
- **Send**: SMTP with `In-Reply-To`/`References` from the stored headers;
  the sent message is upserted locally (IMAP APPEND to Sent is best-effort).

### 5. One reader, dispatch by account

Reads stay merged and account-blind (`listThreads`, tiles, magics — all
user-scoped, so extra accounts flow into the classifier/magics/briefing
pipeline automatically). The three provider-touching paths — thread body
fetch, reply, modify — dispatch on the thread's `account_id`:
NULL → existing Gmail path; else the account's provider service.
`afterSync` (classify → magics → persons) is shared verbatim.
**Attachment import (ADR 0071) stays Gmail-only in v1** (guarded on
`account_id IS NULL`); Graph/IMAP attachment import is a follow-up.

Route guards change from "has gmail scope" to "has gmail scope OR the
target is an account thread"; `/me/email/status` reports
`accounts: EmailAccountSummary[]` plus `outlookClientId` so the client can
run the Microsoft AuthSession flow without new env plumbing.

### 6. Mock seams

`OUTLOOK_PROVIDER` / `IMAP_PROVIDER` = `'real' | 'mock'` mirror
`GMAIL_PROVIDER`: mock fixtures implement the same api seams, the connect
routes skip the network (mock code / skipped IMAP verify), and the full
connect → backfill → merged-list → reply → archive → disconnect flow runs
keyless in tests and demos.

## Alternatives considered

- **Move Gmail into `email_accounts` now** — cleanest end-state, but forces
  a data migration of every existing mailbox plus a rewrite of the
  Google-token/Calendar sharing for zero user-visible gain. Deferred.
- **A neutral `provider_thread_id` rename** — same churn argument as above;
  prefixed ids in the existing columns are indistinguishable to consumers.
- **Yahoo via OAuth** — Yahoo's API program is approval-gated with no
  self-serve path; app-password IMAP is what every mainstream client uses.
- **Graph change notifications (webhooks) instead of delta polling** —
  needs a public HTTPS endpoint + subscription lifecycle management;
  polling matches the existing Gmail cadence and infrastructure.

## Consequences

- A user can attach any number of Outlook/IMAP mailboxes; all land in the
  same reader, tiles, and AI passes. Per-account disconnect cascades its
  mirror via FK.
- Outlook v1 mirrors Inbox (+ locally-upserted sent replies), not the full
  label graph; IMAP flag convergence is bounded to recent UIDs. Both are
  documented cadence/coverage tradeoffs, not correctness bugs.
- `email_accounts.status='reconnect'` is per-account; the proactive
  reconnect nudge (ADR 0042/0062) extension to non-Google accounts is a
  follow-up.
- New deps in `server`: `imapflow`, `mailparser`, `nodemailer` (IMAP/SMTP
  only — Graph and Google stay SDK-free).

## Addendum 2026-07-25 — secondary Gmail mailboxes (provider `'gmail'`)

A user's OTHER Google accounts attach through the same abstraction
(migration `034` relaxes the provider CHECK). The primary Gmail — the
login + calendar anchor — stays on `users` untouched; a secondary Gmail
is an `email_accounts` row whose sealed blob holds `{refreshToken,
clientId}` (Google binds refresh tokens per client, so the issuing client
is stored and reused — `refreshAccessTokenWith` in `oauth.service.ts`).
The connect flow reuses the existing Google OAuth client and
`gmail.modify` scope with `prompt=consent select_account`; the exchange
lands on the account row, never `users`, and attaching the primary's own
address is rejected (`AccountValidationError` → 400).

Sync (`gmail-account.service.ts`) reuses the `GmailApi` seam verbatim —
bounded backfill + History-API incremental with an account-scoped
`{historyId}` cursor and account-scoped reverse-delete. Unlike
Outlook/IMAP, thread modify passes the FULL Gmail label API through.
Category-label write-back (`maybeSyncCategoryLabels`) and attachment
import remain primary-only for now. `GMAIL_PROVIDER=mock` serves each
secondary account its own fixture mailbox, so the flow tests keyless;
`EmailStatus.gmailProviderMock` lets the client skip the OAuth browser
in mock demos.

**Provider-aware invite probe** (`email-accounts/invite-probe.ts`): the
ADR 0074 deterministic calendar-invite probe runs for attached accounts
through each provider's own representation — secondary Gmail via the
same Gmail wire format on the account's token; Outlook via Graph's
native `eventMessage` (`meetingMessageType` + expanded `event` with
`iCalUId`, UTC-preferred times; `meetingCancelled` retracts by UID,
accept/decline notifications mark-without-staging); IMAP via the
`text/calendar` MIME part captured off the fetched source
(`ImapFetchedMessage.icsText`). Same defer-on-failure contract as the
primary probe. The original v1 shipped the probe primary-only, which
400-deferred account threads — fixed 2026-07-25.

**Spam posture + junk peek (2026-07-25).** Junk never enters the mirror:
Outlook deltas the Inbox folder only, IMAP opens INBOX only, Gmail
backfill excludes spam by API default, and the Gmail History path (which
DOES report spam arrivals) now skips SPAM-labeled adds — a later
"not spam" rescue arrives as a SPAM-removal label change for an unknown
row and is fetched then. Attachment import and the magics selection carry
belt-and-suspenders SPAM/archived guards. Because codes and password
resets land in junk constantly, the reader offers an on-demand **junk
peek** (`GET /me/email/junk`, `junk.service.ts`): a live read of every
mailbox's spam folder (Gmail `in:spam`, Graph `junkemail` folder, IMAP
SPECIAL-USE `\Junk` with name fallback) — returned directly, never
stored, never classified. `POST /me/email/junk/rescue` moves a message
to that mailbox's inbox and nudges a sync so it mirrors like normal
mail. Mobile: a "Junk" link on the Email tab header → `/email/junk`.

**Attachments in the reader (2026-07-25).** The thread view shows each
message's attachments (receipts/statements/coupons) as tappable chips.
Metadata only is mirrored (`email_messages.attachments_json`, migration
035; null = undiscovered, `[]` = none): Gmail/Outlook discover it on
thread open (riding the existing lazy body fetch — Gmail
`listAttachmentParts`, Graph `hasAttachments` + `/attachments` list),
IMAP knows it at sync (the source is already parsed; calendar parts
excluded, ids are `i<index>`). Bytes are NEVER stored — `GET
/me/email/messages/:id/attachments/:attId` streams from the owning
provider via `attachment-fetch.ts` (Gmail `attachments.get`, Graph
`contentBytes`, IMAP re-fetch + parse). The client reuses the chat-file
open pattern: blob-URL tab on web, cache-download + share sheet on
native. Distinct from ADR 0071 (knowledge-base import): this is the
reading surface; 0071 remains the background KB pipeline.

Two follow-ons the same day: (1) KB copies imported from email carry
`attachments.origin_email_thread_id` (migration 036, SET NULL on mirror
wipe) — the Attachments tab shows "View original email" deep-linking
`/email/<thread>`; (2) the **magics extractor reads attachment text**:
`MagicThreadInput.attachmentText` carries the KB copies' extracted text
(newest 3 files, 4k chars each, 8k cap) found via that same origin link,
and `afterSync` imports attachments BEFORE running magics so a
newsletter PDF's dates are visible to the to-do/event extraction on the
arrival tick. Gmail-mailbox threads only in v1 (import scope).

**A flagged mailbox retries before it re-asks (2026-08-21).** Reported
symptom: the Yahoo app password "keeps disappearing" and has to be
retyped. It was never lost — `email_accounts.auth_ciphertext` is written
once at connect and no code path clears it. What actually happened is
that a *transient* failure got classified as a dead credential, and the
recovery path was "type it again."

Two independent defects, both fixed:

1. **Over-eager auth classification.** `isAuthFailure` in `imap-api.ts`
   matched `/auth|login|credential|password/i` against the response
   text, and Yahoo answers connection throttling with an auth-*shaped*
   error (it sets `authenticationFailed` on a `[UNAVAILABLE]` /
   rate-limit response). A throttle, a socket reset, or a `LOGIN command
   timed out` all read as "wrong password." Transient markers now win
   over the auth shape, and the positive arm matches real rejections
   (`AUTHENTICATIONFAILED`, `invalid credentials`, `LOGIN failed`)
   rather than any message containing the word "login."

2. **No way back except re-entry.** `markAccountReconnect` sets
   `status='reconnect'`; both bulk sync paths `continue` past such a
   row, and the mobile Sync chip is gated on the row being on — so the
   one endpoint that would have retried with the stored blob was
   unreachable. `POST /me/email/accounts/:id/reconnect` (`retryAccount`)
   now syncs with the credential already on file and returns
   `{ok, needsReconnect, account}`; every provider already resets
   `status` to `ok` after a clean tick, so the row heals itself. The
   mobile slide-on calls this FIRST and opens the app-password form only
   when the server reports `needsReconnect`. 200 either way —
   "your stored password is genuinely dead" is a result, not a
   transport error. Row copy: "Sign-in expired" → "Paused - slide on to
   retry."

Also closed a silent sibling: `openAuthBlob` raised a bare `Error` when
the sealed blob wouldn't decrypt, so a rotated `MASTER_KEY` left every
account claiming `status='ok'` while silently never syncing. It now
raises `AccountAuthError{needsReconnect}` like the missing-columns case.

**Why Yahoo can't just use OAuth**, restated since this is where it
bites: Yahoo's `mail-r`/`mail-w` scopes are approval-gated with no
self-serve path, so there is no "Sign in with Yahoo" to move to — the
app password IS the mechanism, which makes not discarding it on a
hiccup the whole game. Deliberately NOT added: a strike counter before
flagging. With a working retry the false-positive flag is one tap to
clear, so a schema column to make flagging slower isn't worth it.

**One trash lookup per tick, not per message (2026-08-21).** Root cause
upstream of the retry fix above. Every `ImapApi` method opens its own
`ImapFlow`, logs in, and logs out — the seam was modelled on the
Gmail/Graph adapters, where each method really is an independent
stateless HTTP call. IMAP is a stateful *session* protocol, so wearing
that shape means paying a TLS handshake + LOGIN per operation. A quiet
sync tick cost 3 logins (`listWindow`, `fetch`, `fetchFlags`), which is
survivable; but `isInTrash` was called **inside the vanished-message
loop**, so archiving 20 messages in Yahoo's web UI made the next tick
fire 23 logins back to back. Login rate is precisely what Yahoo
throttles, and its throttle response is auth-shaped — so the burst
flagged the account and cost the user their app password. That is the
full causal chain.

`isInTrash(id)` becomes `findInTrash(ids) → Set<id>`: one connection,
one Trash lock, the searches share the session (the login is the
expensive part, not the SEARCH). The caller collects vanished rows in a
first pass, resolves the batch once, then applies. Bounded at
`IMAP_TRASH_LOOKUP_BATCH` (200) per tick; overflow is left **unapplied**
rather than defaulted to archived, because stripping INBOX makes a row
stop looking vanished — a wrong "archived" is sticky and would silently
skip the ADR 0073 retraction. Deferred rows are logged and picked up
next tick.

This does NOT fix the underlying shape — a tick is still 3 connections,
and the AOL preset rides the same Yahoo backend with the same exposure.
Threading one connected client through the whole tick (3 → 1) is the
correct end state; it reshapes the `ImapApi` seam and its mock, so it is
deliberately deferred rather than bolted onto this fix. Note also that
Gmail and Outlook are NOT on this path (API and Graph respectively), so
the connection-per-operation cost is only ever paid against the
strictest providers we support.

**IMAP as a stateful session (2026-08-21).** The end state deferred by
the previous addendum, done. `ImapConnection` (`imap-api.ts`) holds one
login across operations: lazily connected (constructing one is free, so
the SMTP-only `send` path pays nothing) and re-established mid-flight
when `client.usable` goes false, since a long tick can outlive a
server-side idle timeout and silently reusing a dead socket would
surface as a spurious sync failure.

All ten methods are written **once**, in `imapApiOn(auth, conn)`,
against that connection. Two entry points wrap it:

- `withRealImapSession(auth, fn)` — one login for the whole callback.
  `syncImapAccount` now wraps its entire tick, so `listWindow` + `fetch`
  + `findInTrash` + `fetchFlags` cost **1 login instead of 3+N**.
- `realImapApi(auth)` — one-shot, a connection per call, still correct
  for the single-operation route paths (send a reply, peek at junk,
  download an attachment) where there is nothing to amortise over.

`withImapSession(accountKey, auth, fn)` is the seam; the mock has no
connection to amortise so it simply hands over its API.

Tested by counting logins against a faked `imapflow`
(`imap-session.test.ts`): a session spends 1, the same four calls
one-shot spend 4, a 50-id trash lookup still spends 1, a dropped socket
mid-session spends 2, and a session doing no IMAP work spends 0. Worth
pinning as tests because connection count — not returned data — is the
property that keeps Yahoo from throttling us, and it is exactly the kind
of thing a later refactor breaks invisibly.

**Deliberately NOT a connection pool.** Keeping logins warm ACROSS ticks
would drop the steady state to ~0, but providers cap *simultaneous*
connections as well as login rate (Yahoo is commonly cited around 10),
so a pool spanning many users trades a rate problem for a concurrency
one, plus eviction and staleness handling. At one login per account per
`GMAIL_SYNC_THROTTLE_MINUTES` (5), the remaining cost is ~12 logins/hour
for an actively-used mailbox, which is unremarkable. IDLE-based push is
a different design again and out of scope here.

**The invite probe stops re-fetching (2026-08-21).** Audit of every
remaining IMAP call site after the session work, looking for the same
shape as the `isInTrash` bug: a per-item network call inside a loop.
One more was hiding.

`probeImap` runs once per thread inside the magics extraction loop, and
it called `api.fetch([uid])` to pull the whole message back off the
server for its `.ics` part — a login per probed thread. Yet IMAP already
parses the complete source at sync (that is how `attachments_json` is
known at sync for IMAP but only at thread-open for Gmail/Outlook), and
`parseFetchedMessage` already extracted `icsText`. We were throwing it
away and buying it again.

Migration `040_email_message_ics` adds `email_messages.ics_text`, with
the same three-state convention as `attachments_json`: **NULL** = never
parsed (rows predating the column), **`''`** = parsed, carries no
invite, **text** = the VCALENDAR. The distinction is load-bearing —
collapsing '' into NULL would send the probe to the wire for every
ordinary message, which is worse than the bug being fixed. `probeImap`
reads the column and only falls back to `fetch` on NULL, so the fallback
drains as old rows age out rather than persisting.

Gmail and Outlook are unaffected: they probe natively (wire format and
`eventMessage` respectively) and leave `icsText` undefined, which the
upsert writes as NULL — they never read the column.

The rest of the audit came back clean, and the reasoning is worth
recording so the next reader does not redo it: `setSeen`,
`fetchAttachment`, `rescueJunk` and `verify` are each a single operation
with nothing to amortise; `send` is SMTP and opens no IMAP connection at
all; `listJunk` is one connection per account because separate accounts
are separate credentials. Those stay on the one-shot `realImapApi` by
design, not by oversight.
