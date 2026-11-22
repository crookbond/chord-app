# Reinvent Tab 1 as an in-app Email reader (AI tiles + background magics)

## Context

Chord today opens on **Chats** (Tab 1 of `Chats · Catchup · Calendar · Settings`).
We want the app (and its RN-Web build) to open on **Email**: the user reads their
Gmail in-app like normal, while Chord works the inbox in the background — surfacing
insights, proposing calendar events, proposing list items, and organizing mail into
groups. Chat stays invoke-based (unchanged). Email access also strengthens calendar
fanout (flights/appointments become confirmable events).

Two reader modes behind a top **"Traditional / AI"** toggle:
- **Traditional** — a classic list (from / subject / date, tap → thread → reply).
- **AI** — a recursive **tile/treemap**: auto-titled categories rendered as tiles whose
  **area is proportional to email count**; tapping a tile drills into sub-tiles, or
  flips to the email list once a subtree is small enough (leaf threshold).

**Ownership split (important):** the **classifier** — the engine that clusters emails
into the named category tree — is built by **another team**. We do **not** build the
clusterer. We own the **contract** (a zod schema), the **landing tables**, the **tile
read/render**, the **Gmail read/reply/sync**, the **four magics**, and a **mock
classifier fixture** so the AI view works locally before their engine ships.

Access is **read + write-back** via the `gmail.modify` scope (reply, mark-read,
archive, apply labels).

This mirrors existing precedents: **ADR 0057** (device calendar as a synced source),
**ADR 0015/0040** (Google read + two-way sync), **ADR 0009** (proposals), the
**proactive scheduler** (`proactive.service.ts`), and **ADR 0042** (reconnect nudge).

## New ADRs to write (docs/notes/, next free numbers 0060+)
- **0060** Gmail as a synced source (History-API incremental sync, thread/message model).
- **0061** Recursive AI email tiling (external classifier contract, adjacency-tree, count rollup).
- **0062** `gmail.modify` incremental consent + reconnect nudge (web + iOS clients).
- **0063** Email-derived magics (calendar/list proposals, group labels, insights digest).

## Constraints honored (from the code)
- Kysely + Postgres. Tables = `interface *Table` in `server/src/db/schema.ts`, created via
  idempotent `CREATE TABLE IF NOT EXISTS` appended to `migrations[]` in
  `server/src/db/migrate.ts` (latest `015_*`; new work resumes `016_*`).
- Booleans are `integer 0/1` (compare `= 1`, never `IS TRUE`). Datetimes are ISO text.
  `LIKE` is case-sensitive (use `ILIKE`/lowercase). Ids via `newId(prefix)`.
- OAuth token is encrypted on `users` (`refresh_token_ciphertext/iv/tag`,
  `refresh_token_scopes`, `refresh_token_client_id`). `getAccessToken(db,userId)` mints
  a short-lived token and auto-clears an `invalid_grant`; `GoogleAuthError{needsReconnect}`
  on a dead token. iOS uses its own public client; web the confidential client (ADR 0041) —
  handled by `clientForRedirect`/`clientById`, no new per-client work.
- Never read `process.env` in business code — add vars to `config/env.ts` + `example.env`.

## 1. Data model — migration `016_gmail_reader`

**`users` (ALTER, mirrors `google_calendar_synced_at`):** `gmail_history_id`,
`gmail_synced_at`, `gmail_backfill_done integer default 0`, `gmail_reconnect_nudged_at`.
Scope is read off the existing `refresh_token_scopes` via `hasGmailScope()`.

**`email_threads`** (classification + tile unit; a tile count = COUNT(threads)):
`id`(emt), `user_id` FK ON DELETE CASCADE, `gmail_thread_id`, `subject`, `snippet`,
`from_name`, `from_email`, `last_message_at` (ISO sort key), `message_count`,
`is_unread 0/1`, `is_archived 0/1`, `gmail_label_ids` (JSON), `category_id`
(FK, nullable until classified), `classified_at`, `created_at`, `updated_at`.
Indexes: UNIQUE `(user_id, gmail_thread_id)`, `(user_id, last_message_at DESC)`,
`(user_id, category_id)`.

**`email_messages`** (traditional reader + reply; bodies LAZY):
`id`(emm), `user_id` FK, `thread_id` FK ON DELETE CASCADE, `gmail_message_id`,
`gmail_thread_id`, `from_name/from_email`, `to_emails`/`cc_emails` (JSON), `subject`,
`snippet`, `body_text`/`body_html` (nullable — fetched on thread open, cached back),
`internal_date` (ISO), `is_unread 0/1`, `gmail_label_ids` (JSON), `rfc822_message_id`,
`headers_json` (References/In-Reply-To for reply), `created_at`.
Indexes: UNIQUE `(user_id, gmail_message_id)`, `(thread_id, internal_date)`.

**`email_categories`** — the classifier's TREE (adjacency list; **they write, we read**):
`id` (classifier-stable text PK), `user_id` FK, `parent_id` FK self ON DELETE CASCADE
(null = root tile), `title`, `depth`, `sort_order`, `color?`, `icon?`,
`gmail_label_id?`, `updated_at`. Indexes `(user_id, parent_id)`, `(user_id)`.

**`email_message_categories`** — per-thread assignment (**they write, we read**):
`id`, `user_id` FK, `thread_id` FK ON DELETE CASCADE, `category_id` FK, `assigned_at`,
`confidence?`. UNIQUE `(user_id, thread_id)`.

**Tile counts are derived by us at read time** — `COUNT(assignments)` grouped by
`category_id`, rolled UP the tree in one in-memory pass (node total = own direct +
sum of descendants). No stored counts, no drift.

## 2. Gmail service — `server/src/services/google/gmail.service.ts` (mirror `calendar.service.ts`)

Bare `fetch()` to `https://gmail.googleapis.com/gmail/v1/users/me/...` with the user's
own bearer only (SSRF-safe — never fetch URLs from email bodies). Page `maxResults<=100`,
backoff on `429`/`rateLimitExceeded`, cap backfill per tick.

- `hasGmailScope(db,userId)` — regex `refresh_token_scopes` for `.../auth/gmail.modify`.
- `backfillGmail(db,userId,{maxPages})` — `messages.list?q=newer_than:90d` →
  `messages.get?format=metadata`; upsert threads+messages idempotently; set
  `gmail_history_id`; `gmail_backfill_done=1` at the last page.
- `syncGmailIncremental(db,userId)` — `history.list?startHistoryId=<stored>`; apply
  added/deleted/label/unread changes (LWW-cheap); on `404` (historyId expired) fall back
  to a bounded re-backfill; update cursor + `gmail_synced_at`.
- `getThread(db,userId,threadId)` — lazy-fetch missing bodies (`format=full`, decode
  base64url), cache into `email_messages`, return ordered messages.
- `sendReply(db,userId,{threadId,inReplyToMessageId,body})` — build RFC-2822 MIME
  (To=original From, `Re:`, In-Reply-To/References from stored headers), base64url,
  `messages.send`; upsert sent message + mark thread read.
- `modifyThread(...)` + `markRead`/`archive`/`applyLabel`; `ensureLabel(db,userId,name)`
  (labels.list cache → labels.create) for `Chord/<name>` write-back.
- `maybeSyncGmail(db,userId,windowMs=5min)` — throttle gate; no-op if `!hasGmailScope`
  or synced within window; else backfill-if-needed then incremental. **Never throws.**

Pure, Google-free helpers (history diff, subtree-count math, MIME builder, base64url)
live in a sibling `gmail-sync.ts` for unit tests (mirror `two-way-sync.ts`).

**Triggered from BOTH** (mirroring calendar): the Email tab's `POST /me/email/sync` on
mount/focus, and the proactive tick (so magics/digest see fresh data app-closed). No
Gmail push/watch in v1 — polling only (follow-up ADR).

## 3. OAuth upgrade — `gmail.modify` incremental consent (ADR 0062)

Server `server/src/routes/auth.ts`: add `POST /api/v1/auth/google/gmail` mirroring
`authGoogleCalendar` — exchange code, assert same `google_sub`, require a refresh token
(`prompt=consent`), `persistRefreshToken` with the CUMULATIVE granted scopes (keeps
calendar working). Client sends `access_type=offline&prompt=consent&include_granted_scopes=true`.

Mobile: add `GMAIL_SCOPE`. **Do NOT bundle at login** (large restricted scope) — gate
behind an explicit **Connect Gmail** action (Settings section + first-run CTA on the
Email tab) running `AuthSession.useAuthRequest` with the union scope set. iOS/web client
selection already handled.

Reconnect nudge (mirror ADR 0042): email endpoints return `409 {needsReconnect:true}`;
a proactive gmail-reconnect nudge keyed on `gmail_reconnect_nudged_at`, deep-linking
`chord://settings?reconnect=gmail`.

## 4. The integration seam — classifier contract (`kernel/src/types/email-classification.ts`)

Shared zod schema imported by our ingest AND (ideally) the classifier. **Snapshot-replace**:
the classifier sends the FULL current tree + assignments for a user; we upsert atomically
and prune anything absent.

```
CategoryNode = { id, parentId|null, title, depth, sortOrder?, color?, icon?, gmailLabelId? }
ThreadAssignment = { gmailThreadId, categoryId, confidence? }   // keyed by Gmail id
EmailClassificationSnapshot = { version:1, userId, categories[], assignments[] }
```

**Integration mode (recommended B):** classifier `POST`s the snapshot to
`POST /api/v1/me/email/classification` (a route WE own; optionally service-token
secured). Our handler validates (every `categoryId` present; `parentId` present-or-null;
reject cycles; map `gmailThreadId`→`email_threads.id`, skip not-yet-synced), replace-upserts
the two tables in one transaction, broadcasts `SSE.emailTilesUpdated`. Mode A (classifier
writes the tables directly in shared Postgres) is the fallback. The **mock classifier**
uses the exact same path. The read-side DTO (`EmailTile`/`EmailTileLevel`) is DERIVED from
the tables, never the raw snapshot — the two shapes stay decoupled.

**Out of scope for the original external-engine plan:** clustering owned by
another team. **Now also:** an in-repo LLM classifier (ADR 0066) gated by
`EMAIL_CLASSIFIER=llm` — still writes via this same ingest path; mock fixture
(`EMAIL_CLASSIFIER=mock`) remains for zero-LLM demos. Embeddings / vector DB
and forking OSS labellers stay out of scope.

### 4.1 Category taxonomy is recursive + deep (illustrative)

The tree the classifier produces is **multi-level** — top tiles fan out into meaningful
sub-tiles, and a sub-tile can itself split further. Our tile UI already handles arbitrary
depth (walk `parent_id`, roll up counts, flip to the email list at a leaf/threshold); the
mock fixture should mirror this shape so the drill-down is exercised. These are **examples**
of expected depth, not a fixed vocabulary — the classifier owns the actual titles/tree.

```
Inbox
├── Friends & family
│   ├── Forms to fill        → 📝 form-fill + 🏷 group label
│   ├── School notes         → 🏷 group label (+ 📅 if dated)
│   ├── Playdates & invites  → 📅 calendar + ✓ list
│   └── Personal notes
├── Travel
│   ├── Flights              → 📅 calendar
│   ├── Hotels               → 📅 calendar
│   ├── Ground transport (taxis / Ubers / rideshare) → 📅 calendar
│   ├── Car rentals          → 📅 calendar
│   └── Itineraries & confirmations → 📅 calendar
├── Finance → { Credit-card statements, Bank alerts, Paystubs, Investments }
├── Deliveries → { Shipping updates → ✓ list, Order confirmations, Returns }
└── Receipts · Coupons · Newsletters · Recipes/forwards   (flat leaf tiles)
```

**Magic hooks attach per leaf, not per top tile** (§5). A leaf carries a *kind* the magic
pass keys off: `flights/hotels/ground-transport/car-rentals/itineraries` → calendar-event
proposals (feeds fanout); `shipping/playdates` → list proposals; `forms-to-fill` →
Chord's **existing forms subsystem** (`forms` table + `forms.ts`, the schema-extraction +
fillable-PDF pipeline) — the email attachment becomes a `form` draft the user completes,
not just a generic list item; `school-notes/forms/playdates` under Friends-&-family →
group-label + `group_ids` classification into the family/school Chord group. Travel legs
detected here also strengthen calendar fanout (ADR 0040), the original motivation.

Consequence for the mock classifier + tiles endpoint: seed at least Friends-&-family and
Travel with their sub-tiles so the recursive drill-down and the leaf→magic mapping are both
demonstrable before the real classifier ships.

## 5. The four magics — plug into existing mechanisms (ADR 0063)

Run inside one proactive job after sync+classify (works app-closed); best-effort,
idempotent, dedup on source `gmail_message_id`.
- **Calendar suggestions → proposals.** New tool `propose_event_from_email` (or reuse
  `create_event`) staged as a proposal in the **personal** group; LLM extracts
  `{title,startsAt,endsAt,location,sourceMessageId}`. Confirm creates the user-owned event
  + fanout (ADR 0040). Renders in `catchup/[tab].tsx` — no new confirm UI.
- **Group classification → `group_ids` + Gmail labels.** For threads tied to a known Chord
  group, propose the mapping and (when enabled) apply a `Chord/<Group>` label via
  `ensureLabel`+`modifyThread`. Strict per-group scope by user id (ADR 0032).
- **List suggestions → proposals**, reuse `add_list_item` in the personal group.
- **Insights digest → proactive scheduler.** New `ProactiveKind = 'email_digest'` +
  `renderEmailDigest` (mirror `renderDailyMorningScan`), seeded at the user's nudge time,
  delivered to the personal group + push (ADR 0054).

New: `server/src/services/email/magics.service.ts` + tool schema(s) in `bot/tools.ts` +
`PROPOSABLE_TOOLS` membership in `bot/executor.ts`.

### 5.1 Group-label routing — the privacy model (IMPORTANT)

A Chord group has many members, but an email lives in **one** person's Gmail and the
others have no access to it. So group-label classification must **never** turn a private
email into group-visible data. The model:

1. **The email stays 1:1 with its owner, always.** `email_threads` / `email_messages` are
   `user_id`-scoped (like a personal file). They are never fanned out, never readable by
   other members. Only the connecting user's mailbox is ever read (ADR 0032: own data only).

2. **"Group label" = a routing destination, not a visibility grant.** When the magic decides
   an email is *for* a group (a school email → the School group), it does **not** share the
   email. It sets the derived **proposal's target group** (`proposals.target_group_id`, this
   PR). The suggestion is staged **privately in the owner's personal group** — only the owner
   sees it.

3. **This is a PROPOSAL. The ultimate action is the reader's.** Nothing is auto-applied. The
   owner sees "School bake sale · Jul 17 · → shares with School" in the Calendar "Suggested
   from email" strip and taps **Share**. Only *that confirm* creates the entity — and, because
   the proposal is group-routed, it's created in the **School** group, where it **fans out**
   to members as their own copies (ADR 0040). Members receive the *event*, never the *email*.

4. **Guardrails.** The matcher only ever considers the owner's **own** non-personal groups.
   `confirmProposal` re-checks the confirmer is a member of `target_group_id` before executing.
   Duplicate copies across two members who both got the mail dedup by `ical_uid` (ADR 0040).

Deferred (documented, not built): auto-applying a `Chord/<Group>` Gmail **label** to the
owner's own inbox on confirm (owner-side organization only), and a standalone
"file this thread to <group>" action independent of a calendar/list suggestion.

Seam: `GroupMatcher` in `magics.service.ts` (LLM in prod; injected stub in tests) →
`createProposal({ groupId: personalGroup, targetGroupId })` → `commitRow` executes in
`target_group_id ?? group_id`.

## 6. API surface

`kernel/src/api.ts` (Email block): `meEmailStatus`, `meEmailSync`, `meEmailDisconnect`,
`meEmailTiles` (`?parent=<catId>`), `meEmailThreads` (`?category=&mode=traditional|category&cursor=`),
`meEmailThread(id)`, `meEmailThreadReply(id)`, `meEmailThreadModify(id)`,
`meEmailClassification` (classifier ingest), `authGoogleGmail`. Suggestions reuse existing
`meProposals`/`proposalConfirm`.

`kernel/src/types/email.ts` (mirror `event.ts`): `EmailTile`/`EmailTileLevel`,
`EmailThreadSummary`, `EmailThreadDetail`, `EmailMessage`, `EmailReplyRequest`,
`EmailModifyRequest`; plus the classification contract file. Export from `kernel/src/index.ts`.

`server/src/routes/email.ts` (new router, mounted like `meRouter`): one handler per path,
all `requireSession`, mutating ones gated on `hasGmailScope`, copy the calendar
`409 needsReconnect` catch. Reads hit local tables; sync/reply/modify/body call `gmail.service.ts`.

`kernel/src/sse.ts`: add `SSE.emailSynced`, `SSE.emailThreadUpdated`, `SSE.emailTilesUpdated`
to `SSE` + `SseEventMap`, broadcast on the user's personal channel.

## 7. Mobile / Web UI (RN + RN-Web from `mobile/`)

**Tab entry — `mobile/src/group-nav.tsx`:** `MainTab = 'email' | 'chats' | 'catchup' |
'calendar' | 'settings'`; prepend `{ key:'email', label:'Email', icon:'✉' }` to
`MAIN_TABS`; add `case 'email': router.replace('/email')` to `goTo`. Web inherits.

**Screens under `mobile/app/email/`:**
- `index.tsx` — Email tab: `MainBottomNav current="email"`, a top **Traditional / AI**
  segmented control (persist in AsyncStorage), one of two subviews. On mount/focus:
  `POST /me/email/sync` then load. If `!connected`, a **Connect Gmail** CTA. Cache last
  response in AsyncStorage for instant paint (mirror `calendar.tsx`).
- `tiles.tsx` — AI recursive-tile view from `meEmailTiles?parent=`. Treemap via
  proportional flex (`flex: count`, or a squarified split): title + count, tap → push
  next `?parent=` level, or → thread list at a leaf. Same flex renders on web.
  *(v1: size-bucketed / simple split flex is acceptable; exact squarify can follow.)*
- `traditional.tsx` — classic `FlatList` of `EmailThreadSummary` (unread bold).
- `[threadId].tsx` — thread: `getEmailThread`, render ordered messages
  (sanitized `body_html` or `body_text`), actions **Reply** (composer → `replyEmailThread`),
  **Mark read**, **Archive**, **Apply label**.
- `mobile/src/api.ts` — typed fns: `getEmailStatus`, `syncEmail`, `listEmailTiles(parent?)`,
  `listEmailThreads(params)`, `getEmailThread(id)`, `replyEmailThread(id,body)`,
  `modifyEmailThread(id,patch)`, `connectGmail(...)`.

**Settings — `mobile/app/settings.tsx`:** `ConnectGmailSection` mirroring the calendar
connect block + `AppleSyncSection` toggle pattern: connect/disconnect via `getEmailStatus`,
**Connect Gmail**, **Sync now**, **Sync tiles to Gmail labels** toggle, **Digest** on/off.

## 8. Phasing (shippable increments)

- **A — Reader.** `gmail.modify` consent (auth route + Settings), `gmail.service.ts`
  backfill+incremental, `email_threads`/`email_messages`, `email.ts` status/sync/threads/thread,
  Email tab shell + Traditional list + thread screen (read-only). *Ships: an in-app Gmail reader.*
- **B — AI tiles (consume external classifier).** `email_categories`/`email_message_categories`,
  the `EmailClassificationSnapshot` contract + Mode-B ingest + MOCK fixture, `meEmailTiles`
  (rolled-up counts), the recursive-tile view + Traditional/AI toggle.
- **C — Write-back.** Reply, mark-read/archive/apply-label, label creation, "sync tiles to
  Gmail labels" toggle.
- **D — Magics.** Digest first (lowest risk), then calendar/list proposals, then group-label
  write-back.

## 9. Verification

- **Unit** (`__tests__/`, `openTestDb()`): pure `gmail-sync.ts` (history-diff, subtree-count,
  tile-vs-sublist threshold, RFC-2822 reply MIME, base64url) — Google-free; ingest-contract
  tests (bad/cyclic/dangling parent, unknown-thread skip, replace-upsert+prune, count rollup);
  route tests for `email.ts` (auth gating, `409 needsReconnect`, tile/thread shapes).
- **Mock Gmail source**: injectable `gmailFetch` seam (`GMAIL_PROVIDER=mock`) returning
  fixture `messages.list`/`history.list`/`messages.get`/`send`, so backfill+incremental+reply
  are end-to-end testable with no network.
- **E2E** (`LLM_PROVIDER=mock`): connect → backfill → tiles render with proportional counts →
  drill → open thread → reply → thread marked read → digest posts a personal-group bot message.
  Run per-bug: `npm test --workspace=server`.
- **Manual/preview**: RN-Web dev server — verify the 5-tab bar, the toggle, treemap
  proportions, and the `chord://settings?reconnect=gmail` deep-link.

## Risks / open coordination points
- **`gmail.modify` is a RESTRICTED Google scope** → OAuth app verification (possibly a
  security assessment) before production. Biggest external risk; gate Gmail behind a flag
  until verified (ADR 0062).
- **Classifier integration mode** (A shared-DB vs B ingest-endpoint) must be agreed with the
  other team — plan assumes **B**.
- **historyId expiry** (~1 week idle) → bounded re-backfill on `404` (test it).
- **Body storage/privacy** — lazy bodies by default; retention window; account-deletion
  cascade covered by FKs; open: encrypt bodies at rest?
- **Tile-title stability** — pin vocabulary once generated; add/never-rename to avoid churn.
- **Volume** — bound sync window (90d), paginate tiles/threads; never load all threads client-side.

## Critical files
- `server/src/services/google/gmail.service.ts` (new) + `gmail-sync.ts` (new, pure)
- `server/src/db/migrate.ts` + `schema.ts` (`016_gmail_reader`)
- `server/src/routes/email.ts` (new) + `routes/auth.ts` (`authGoogleGmail`)
- `kernel/src/api.ts` + `kernel/src/types/email.ts` + `kernel/src/types/email-classification.ts` (contract)
- `server/src/services/email/classification.service.ts` (ingest/upsert + count rollup) +
  `mock-classifier.ts` (dev fixture) + `llm-classifier.ts` (ADR 0066 in-repo LLM) +
  `classifier-tree.ts` (shared path/slug helpers)
- `server/src/services/email/magics.service.ts` + `proactive.service.ts` (`email_digest`)
- `kernel/src/sse.ts`
- `mobile/src/group-nav.tsx` + `mobile/app/email/*` (new) + `mobile/app/settings.tsx` + `mobile/src/api.ts`
