# Backlog — raw capture

Unrefined bug reports + feature asks, captured as-is. Not triaged into ADRs
or the [roadmap](./README.md) yet. Favour capture over polish — promote items
out of here once they're scoped. Items are a mix of **bugs** (something is
broken) and **aspirational features** (something we'd like to build).

`cf.` links point at existing ADRs/subsystem docs that touch the same area —
context for whoever picks the item up, **not** a sign it's been triaged.

## Long-term vision

- **Contacts-aware social layer.** Read the user's contact list, point out who
  else is already on Chord, and let the user chat to them. "Always listening"
  assistant mode that helps the user manage those interactions.
  *Largely landed (2026-07):* phone identity ([ADR 0064](../notes/0064-phone-as-attribute-identity.md)),
  hashed contact discovery ([ADR 0065](../notes/0065-deterministic-contact-discovery.md)),
  and pair-group messaging via `message_user`
  ([ADR 0067](../notes/0067-pair-groups-and-cross-user-messaging.md)) cover the
  discovery + chat halves; still open are the mobile contacts upload (F&F
  Workstream C) and the "always listening" mode itself.
  *(cf. [ADR 0018](../notes/0018-listening-modes.md) listening modes,
  [ADR 0004](../notes/0004-group-scoped-agent.md) group scope, the
  `lookup_contact` tool in [bot.md](../subsystems/bot.md).)*

## Performance — hot-path redundancy (2026-06-19 audit)

Findings from a four-way audit of the per-message / per-SSE / per-bot-turn /
per-render hot paths. Surgical fixes, no rewrites. Impact = how often it fires.

- [x] **Outbound publisher runs 1–3 wasted queries on every message broadcast.**
  `forward()` ([outbound-publisher.ts:76](../../server/src/services/connectors/outbound-publisher.ts))
  fires for every text/bot/file broadcast app-wide and queried the message row,
  group `kind`, and trigger row **before** the cheap indexed `listBindingsForGroup`
  — which returns empty for the common no-connector group. **Fixed:** moved the
  `listBindingsForGroup` early-return to the top of `forward()` so a no-connector
  group costs exactly one indexed lookup instead of 1–3 queries. Behavior-
  preserving (everything below was dead code when bindings is empty). Connector
  test sweep green. **HIGH.**
- [x] **`eventsBlock` N+1: one `listRsvps` per upcoming event, serial.**
  [context.ts:296](../../server/src/services/bot/context.ts) — **Fixed:** added
  `listRsvpsForEvents(db, ids)` ([events.service.ts](../../server/src/services/events.service.ts))
  doing a single `where event_id in (...)` grouped into a Map; `eventsBlock` now
  fetches all RSVPs in one query before the loop. Every bot turn in groups with
  events. Context/events tests green. **HIGH.**
- [x] **Snapshot loads creator display names it never renders (3×/turn).**
  `groupSnapshotBlock` called `listTasks`/`listLists`/`listSaves`, each doing a
  `loadDisplayNames` `users` query for a `createdByName` the snapshot discards.
  **Fixed:** added a `withNames?: boolean` opt (default-on, preserves all other
  callers) to the three list fns; the snapshot passes `withNames:false` to skip
  the lookup. Saves 3 `users` queries per bot turn.
  [context.ts](../../server/src/services/bot/context.ts). **MED-HIGH.**
- [ ] **Trigger user's `users` row fetched 3× per turn** (model cols, `about_me`,
  memory-extract). Fetch once in `runBotTurn`, pass down. **Deferred:** the three
  reads pull *different* columns from different functions, and one is
  `getLlmForUser` — a shared fn also called from `executor.ts` and mocked across
  ~8 test files, so threading a pre-fetched row through it is high-churn for
  what are cheap PK lookups. Revisit only if profiling flags it. **MED.**
- [x] **Sequential awaits on independent pre-context queries** —
  [bot.service.ts](../../server/src/services/bot/bot.service.ts): **Fixed** —
  att-mime, `recentRetrievalText`, and `getLlmForUser` now run in a `Promise.all`
  (excerpt selection stays sequential since it consumes `retrievalText`). **MED.**
- [x] **Retrieval bulk-fetches full `extracted_text` for every visible
  attachment, inlines only 2.** **Fixed:** dropped `extracted_text` from the
  bulk visibility query (and `AttachmentRow`); a new `hydrateFulltext` fetches
  it for just the top `FULLTEXT_DOC_CAP` (2) docs of the final ordered list —
  the only ones `attachmentBlock` inlines. `FULLTEXT_DOC_CAP` now lives in
  retrieval (owner) and context imports it so the hydrate/inline caps can't
  drift. Pinned/empty-keyword fallbacks hydrate too. Retrieval + full-text +
  comprehensive/realistic suites green.
  [retrieval.ts](../../server/src/services/bot/retrieval.ts). **MED.**
- [ ] **Last-4 messages read twice** (retrieval + context both hit `messages`).
  Fetch the 30-window once, derive both. **Deferred:** `recentRetrievalText` is an
  exported, separately-tested fn whose contract is "last 4 *human* turns, reaching
  back as far as needed"; deriving it from the 30-msg context window changes its
  semantics in a bot-heavy tail, changes its signature (breaks 2 tests), and
  touches the ADR-0035 recency fetch — all to save one `LIMIT 4` indexed read per
  turn. Revisit only if profiling flags it. **MED.**
- [x] **Inbound: sender `users` row re-fetched** right after `resolveIdentity`
  already joined it. **Fixed:** new `resolveIdentityWithMeta` returns
  `listening_mode` + `last_tz` from the same joined `users` row (fresh shadow
  users return the column defaults); `resolveIdentity` stays as a thin alias
  for its ~15 other call sites. The pipeline's post-`postMessage` re-select is
  gone — one query saved per inbound connector message.
  [inbound-pipeline.ts](../../server/src/services/connectors/inbound-pipeline.ts),
  [identity-resolver.ts](../../server/src/services/connectors/identity-resolver.ts). **MED.**
- [x] **`maybeAnnounceShadowSignupInGroup` queries on every shared-group
  message** — **already handled (no change).** The fn early-returns at
  `if (!m.mentionsBot) return false` **before any DB query**, so it only queries
  on bot-mention messages (which run a full LLM turn anyway), not on every
  message. Backlog claim was stale.
  [welcome-dm.service.ts:227](../../server/src/services/connectors/welcome-dm.service.ts). **MED.**
- [x] **Group-list query (opens the app) computes `unread_count` + `MAX(created_at)`
  twice each** (SELECT and ORDER BY). **Fixed:** wrapped the per-group columns in
  a `group_rows` CTE so the ORDER BY sorts on `unread_count` / `last_message_at`
  by name instead of re-running the COUNT + MAX subqueries. (Postgres won't honor
  a SELECT alias inside a CASE/COALESCE ORDER BY expression, hence the CTE.)
  Ordering unchanged; group-list tests green.
  [groups.service.ts:109](../../server/src/services/groups.service.ts). **HIGH (hottest read).**
- [x] **Missing partial index** for the `chord_visible=1` predicate on the hot
  message reads. **Fixed:** migration `014_messages_visible_index` adds
  `idx_messages_group_visible_created ON messages (group_id, created_at) WHERE
  chord_visible = 1` ([migrate.ts](../../server/src/db/migrate.ts)) so visible-
  message reads skip the invisible bot rows. Idempotent. **HIGH on message-heavy data.**
- [x] **Per-write N+1 fan-outs.** **Fixed both:**
  - Catchup assignment ([folders.service.ts](../../server/src/services/catchup/folders.service.ts)):
    `fanoutAssignment` now bulk-ensures seed folders for all members (one
    select + one insert) and bulk-loads their folder sets (one select), then
    `assignEntityForUser` resolves from that snapshot via a new
    `preloadedFolders` opt instead of a seed-check + per-name select per member.
    The delicate insert/promotion logic is untouched. ~4–6 ×N queries → ~2 + the
    per-member upsert.
  - Event create ([events.service.ts](../../server/src/services/events.service.ts)):
    pre-resolves all fanned-out owners' target calendars before the loop — one
    group-default query, else one batched `users.default_calendar_id` query —
    instead of `resolveTargetCalendarId` per owner. Added an events-fanout test
    asserting the per-copy calendar (group default → user default → primary).
  Catchup (40) + event fan-out (10) suites green. **MED-HIGH.**
- [ ] **Shadow-merge N+1s:** `reattributeShadowFkColumns` 21 serial UPDATEs
  ([pairing.service.ts:607](../../server/src/services/connectors/pairing.service.ts));
  membership + trip-participant per-row SELECT+INSERT. Batch. **Low priority:**
  this runs **once per shadow→real account merge** (a rare lifetime event), not a
  hot path, so the ROI of batching 21 UPDATEs is minimal. **MED.**
- [x] **Mobile: chat `Bubble` not memoized + inline `renderItem`** → every
  visible bubble re-renders per keystroke and per SSE event.
  **Fixed:** `React.memo(Bubble)` with a content comparator (receipt /
  proposals / cards / tools compared by value; `busyProposalIds` only
  checked for this bubble's proposal ids so an unrelated busy toggle
  doesn't bust every row) + stable `renderChatItem` /
  `onResolveProposal` / save-offer callbacks.
  [index.tsx](../../mobile/app/groups/[id]/index.tsx). **HIGH (chat jank).**
- [x] **Mobile: full `/files` refetch + map rebuild on every inbound attachment
  message.** **Fixed:** every inbound attachment not already cached triggered a
  full `listGroupFiles` + whole-map rebuild — so a multi-photo share fired N full
  fetches. Now a stable `refreshFiles` **coalesces** concurrent triggers into one
  fetch (with a queued follow-up so a file landing mid-fetch still converges) and
  **merges** into the map instead of rebuilding it.
  [index.tsx](../../mobile/app/groups/[id]/index.tsx). **MED-HIGH.**
- [x] **Mobile: calendar refetches full event list twice per focus** — **Fixed:**
  the focus effect rendered local data, synced gcal, then refreshed again
  unconditionally. The mobile sync only *imports* new events (never mutates
  existing local rows), so it now gates the post-sync `refresh()` on
  `inserted > 0`. [calendar.tsx:190](../../mobile/app/calendar.tsx). **MED.**
- [x] **Mobile: pairing poll keeps ticking after `expired`.** The polling
  effect set an interval whenever `pairing` was set; the `expired` branch only
  flipped state and returned, never clearing the interval, so it polled
  `getPairingStatus` forever. **Fixed:** guard the effect on `pairingExpired`
  and add it to the deps — `expired` (or `bound`) re-runs the effect, the
  cleanup clears the interval, and the guard stops a new one. A fresh pairing
  resets `pairingExpired=false`, re-enabling polling.
  [settings.tsx](../../mobile/app/groups/[id]/settings.tsx).
- [x] **Mobile: `setMessages` full re-sort on every reconnect backfill** →
  **Fixed:** `upsertMessage` / `appendBotDelta` keep the list ascending-sorted
  (binary insert); `setMessages` linear-merges two sorted lists, with a
  patch-in-place fast path when the backfill only updates already-present
  ids at the same sort key. [store.ts](../../mobile/src/store.ts).

## Bugs / fixes

- [x] **Bot-written items land in the wrong scope, and some entity types have no
  app surface at all (2026-08-22).** **Fixed 2026-08-22** across four ADRs —
  [0094](../notes/0094-symmetric-list-name-resolution.md) (one list-name rule
  for reads and writes + migration 042 merging existing forks + merge-on-
  colliding-rename), [0095](../notes/0095-tasks-fold-instead-of-multiplying.md)
  (`create_task` had no dedup at all — the actual source of the to-do pile-up),
  [0096](../notes/0096-personal-chat-reads-across-groups.md) (`get_list` /
  `list_tasks` / `search_saves` now follow the ADR 0059 scope rule from the
  personal 1:1, and `get_list` falls back to saves when no list matches — the
  two halves of why "veeray" was unfindable), and
  [0097](../notes/0097-email-routing-is-a-choice.md) (the LLM group matcher is
  deleted; routing is a standing user rule or a tap at confirm time). Original
  capture below. Reported: to-dos and tasks are
  "probabilistically going to groups" when they should be personal; duplicate
  lists / to-dos pile up for the same person; and a restaurant ("veeray") added
  to a list in **RDMS** is findable by the bot but **not visible in the app**.
  Three distinct problems are tangled here — separate them before fixing:
  1. **The item is reachable, just not where it was looked for.** ~~Invisible
     entity types~~ — **wrong, corrected 2026-08-22:** `save_place` does NOT
     land in the orphaned `places` table; the executor deliberately routes it
     through saves ([executor.ts:898](../../server/src/services/bot/executor.ts))
     so it shows in `/me/saves`, and `save_media`/`save_contact` do the same.
     (`places` is written only by an unused REST route.) The real pair of
     causes, both confirmed:
     **(a)** "veeray" was stored as a *place save*, while the question asked
     about a *list* — and `get_list` reads lists only, returning
     `{list: null, candidates: […]}` with no look at saves.
     **(b)** The Lists tab renders **no item text until a card is expanded**
     (`{expanded && list.items.map(…)}`, `mobile/app/catchup/[tab].tsx`) and
     has no search box, so browsing for one item means opening every card.
  2. **Both read paths scope by membership, so a mismatch means the row is not
     in one of the user's groups.** `/me/lists` spans every group the user is a
     member of ([lists.service.ts:73](../../server/src/services/lists.service.ts)),
     and the ADR 0059 cross-group search resolves scope the same way
     ([search.service.ts:271](../../server/src/services/search.service.ts)) — a
     `group_members` join in both. They agree by construction, so "the bot finds
     it, the app doesn't" is **not** a scoping gap between those two. Remaining
     suspects: the write landed under a **different user** (a WhatsApp shadow
     whose number was never tied — [ADR 0064](../notes/0064-phone-as-attribute-identity.md)),
     or the client cache was stale (`CACHE_FRESH_MS = 30s`,
     `mobile/app/catchup/[tab].tsx:156`). **Next step: read the actual row** —
     what `group_id` and `created_by` does veeray carry, and is it a `list_items`
     row at all or a `places` row (see 1).
  3. **A write targets the turn's group, with no "is this private?" judgement.**
     The executor writes to whichever group the message arrived in, so anything
     said in a shared group — or over a connector channel bound to one — becomes
     group-visible even when the content is personal. The user's framing is that
     a *personal query* should read personal + groups (it does), but a *write*
     should default to personal unless it is clearly group business. That
     inverts [ADR 0004](../notes/0004-group-scoped-agent.md)'s strictly
     group-scoped posture, so it needs its own ADR, not a patch.
  **Duplicates:** `getListByName` is exact-match *and* group-scoped
  ([lists.service.ts:111](../../server/src/services/lists.service.ts)), so the
  same logical list re-created from another group is a genuinely new row. That
  is intended under [ADR 0058](../notes/0058-no-list-consolidation.md) (no
  consolidation), but it reads as duplication once (3) scatters writes across
  unexpected groups — i.e. fixing (3) probably dissolves this without touching
  the list code.
  **On the security framing:** the report calls this a security-model violation.
  Nothing found so far crosses a membership boundary — both read paths gate on
  `group_members` — so the exposure looks like *over-sharing inside groups the
  user already belongs to*, not a cross-tenant leak. That conclusion is provisional
  until the veeray row is inspected; if its `group_id` is a group the user is not
  a member of, this is a real breach of
  [ADR 0032](../notes/0032-strict-per-group-scope.md) and jumps the queue.

- [x] **Flaky vitest exit on Windows: tinypool `ERR_IPC_CHANNEL_CLOSED` at
  worker teardown (2026-07-19).** ✅ **Fixed** (`pool: 'forks'`, generous
  `teardownTimeout`, per-worker `worker-setup.ts` that swallows only known-
  benign post-teardown DB/IPC errors so a late rejection can't crash the
  forked worker and make the parent report IPC-closed with zero real
  failures). See `server/vitest.config.ts` + `__test-helpers__/worker-setup.ts`
  (landed in the suite-harden pass). Historical: ~1-in-3 full-suite runs on
  the Windows dev box exited 1 after every test passed.
- [x] **Drop list consolidation — render one card per list.** Users keep a
  separate list per store on purpose and buy different things at each, so the
  Grocery super-bucket + grocery cross-pull + fuzzy name-merge worked against
  them. **Fixed** ([ADR 0058](../notes/0058-no-list-consolidation.md)): removed
  `bucketLists` and all consolidation machinery; the catchup Lists tab now
  renders each list as-is, with toggle/edit/delete acting on that list's own
  rows. Kept `listKindLabel` (card icon only) in `kernel/src/list-kind.ts` and
  moved the generic `normalizeText` to `kernel/src/text.ts`. View-layer change
  only — no DB migration. Decided remove-entirely (not opt-in).

- [x] **Account deletion scope — investigated, no change needed.** Captured as
  "delete the user from everywhere," then clarified (2026-06-30): the intent is
  just *delete the account + logins, delete the user's own solo content, and
  leave shared / 1×1 channel content alone (user detached, not deleted)*. That
  is exactly what [ADR 0043](../notes/0043-account-deletion.md) already does —
  `deleteAccount` deletes the `users` row (cascading sessions + memberships +
  tokens), deletes solo/personal groups + the user's private files + contacts,
  and in shared groups reassigns NOT NULL ownership to a remaining member while
  nulling the user's authorship. Going further (deleting the user's items *from*
  shared channels) was explicitly rejected — it destroys co-members' data.
  Closed as working-as-designed.

- [x] **Editing an event's duration/time created a duplicate (no `update_event` tool).**
  Repro: a Giant ticket event auto-filed correctly at Jun 25 7:00 PM; asking the
  bot to "make it last 2.5 hrs vs 30 min" produced a **new** event at 11 PM
  instead of editing the existing one. Root cause: the bot tool registry had
  `create_event` / `get_event_status` / `find_conflicts` / `delete_event` but **no
  update path**, so the model fell back to `create_event` (a duplicate), and the
  11 PM was a timezone slip in that create (7 PM EDT = 23:00 UTC). The HTTP layer
  already had `updateEvent` (PATCH); it just wasn't exposed to the bot. **Fixed**
  by adding an `update_event` tool (`server/src/services/bot/tools.ts` +
  `executor.ts`): resolves the event by `eventId` or `titleContains`/`date`
  (ambiguous → returns candidates, never guesses), patches `title`/`location`/
  `startsAt`/`endsAt` in place with tz-strict datetimes, and a `durationMinutes`
  convenience that computes `endsAt = start + duration` server-side (so the model
  needn't know/restate the start — the path that previously forced a duplicate).
  Fans out per-owner `eventUpdated` SSE + Google two-way push via `updateEvent`.
  Honesty-gated (`updated` flag). Tests in
  `server/src/services/bot/__tests__/executor.test.ts`.
  *(cf. [ADR 0040](../notes/0040-user-owned-two-way-calendar.md) two-way edit;
  `delete_event` resolution pattern.)*

- [x] **Bot posts a redundant chatty reply on auto-filed attachments.** When an
  image/calendar/itinerary upload is handled by the deterministic auto-filer
  (`classifyAndAutoFileAttachment` / `classifyAndProposeContent` in
  `server/src/services/attachments.service.ts`), the bot *turn* ALSO fired on
  the same upload and posted a generic reply like *"The image shows a calendar for
  Stuyvesant… How can I assist you with this?"* — redundant with the auto-import,
  which already posts its own specific `📎 Indexed — … Added N calendar events`
  acknowledgment (`postIndexed` in `trip_classifier.ts`). **Fixed** in
  `runBotTurn` (`server/src/services/bot/bot.service.ts`): a new
  `isBareAttachmentUpload(body)` detector + `silent-autofile` surface mode — when
  the trigger carried a file, fired no tool, and the body has no real
  question/instruction once the `@`-mention is stripped, the turn persists for LLM
  context at `chord_visible=0` but renders nothing (and isn't sent to the source
  bridge), leaving the auto-filer's line as the single acknowledgment. A real
  question alongside the upload ("@Chord what's the total?") still gets a reply.
  Tests: `server/src/services/bot/__tests__/bare-attachment-upload.test.ts`.
  *(cf. [bot.md](../subsystems/bot.md) "Attachment turns — auto-file gating",
  [ADR 0022](../notes/0022-quiet-mode-bot-replies.md) surface modes.)*

- [x] **`npm run migrate` is a silent no-op on Windows.** **Fixed.**
  `server/src/db/migrate.ts` guarded its entry point with
  `import.meta.url === ` + "`file://${process.argv[1]}`" + `; on Windows
  `process.argv[1]` is a backslash path (`C:\…\migrate.ts`) which never equals
  `import.meta.url`'s `file:///C:/…/migrate.ts`, so `runMigrations()` never ran
  and the command exited 0 having created nothing. Now compares against
  `pathToFileURL(process.argv[1]).href`. Verified: against a fresh DB,
  `npm run migrate` went 0 → 46 tables with proper "applying migration…" logs
  (was a silent no-op before). Discovered 2026-06-18 while migrating a sim DB.
- [x] **Sim "@Chord turn timeouts" were a bot-alias mismatch, not a server bug.**
  The load sim reported ~35–55% of @Chord turns timing out. Root-caused (traced
  the dispatch step by step): this deployment's `.env.local` sets
  `BOT_MENTION_ALIASES=chord-beta`, so the bot only answers to **`@chord-beta`**,
  but the sim's prompts hardcode **`@Chord`** → `mentions_bot=0` → the bot
  correctly never reacts → the sim logs a "timeout." There is **no** server
  throughput/concurrency bug: the dispatch path (`reactToMessage`) is
  fire-and-forget with no concurrency cap, the mock provider is stateless, and
  `buildMentionRegex` is a fresh non-global regex. Proof: with `--bot-alias
  chord-beta` the same run goes **7/7 (0 timeouts)**; with the default `@chord`
  it's 7/12. Fixed in the sim: new `--bot-alias` flag + `addressBot()` rewrites
  "@Chord" → "@<alias>" (`server/scripts/sim/run.ts`); default stays `chord`
  (example.env). *(Two non-bugs noted while digging: the mock vision provider
  returns unparseable JSON for screenshots so `screenshot_classify` setup
  scenarios fail — a mock gap; and the Telegram 409 in earlier runs was just two
  local servers sharing one bot token.)*
  *(cf. [bot-persona.ts](../../kernel/src/bot-persona.ts) mention grammar,
  `bot-personas.service.ts` `getDefaultPersona`.)*
- [x] **Follow-up: let the sim auto-detect the bot alias.** **Done.** `/health`
  now advertises `botAlias` (the active persona's primary mention alias) in
  `server/src/routes/health.ts`; the sim reads it on startup and rewrites
  `@Chord` → `@<alias>` unless `--bot-alias` was passed explicitly
  (`server/scripts/sim/run.ts`). Verified end-to-end: against this deployment
  (`.env.local` `BOT_MENTION_ALIASES=chord-beta`) the sim auto-detected
  `@chord-beta` and went 6/6 @Chord turns with no `--bot-alias` flag. Test:
  `health.integration.test.ts` asserts the field. *(Note: the `resetDemo`
  cache-invalidation worry was unfounded — `resetDemo` does not wipe
  `bot_personas` (it isn't in the wiped-tables list), so the in-memory persona
  can't outlive a row it never deleted. No change needed there.)*

- [x] **RSVPs/attendees leaked beyond the event's group + cross-group route IDOR.**
  Two related strict-scope holes, fixed together (2026-06-09).
  - **Bot RSVP (id-not-name):** `record_rsvp`
    (`server/src/services/bot/executor.ts`) gated the *event* to the group but
    wrote a free-text `displayName` with **no membership check**, so the bot could
    record RSVPs for people outside the group (repro: event in a Bob+Carol group
    filed RSVPs for the broader Doe roster). Now resolves the attendee to a
    **member of the event's group by id** via a new `resolveGroupMember` helper;
    stores `user_id` + canonical name; a non-member name is refused and reported,
    never recorded.
  - **HTTP route IDOR:** every entity-id route (`/api/v1/<entity>/:id`) for tasks,
    lists, list-items, saves, events + their RSVPs, and trip reservations ran only
    `requireSession` — any signed-in user could read/mutate **any** group's data by
    id. Now each loads the entity and verifies `isMember(entity.groupId, userId)` →
    404 (matching the existing `memories.ts` / `proposals.ts` pattern). Also bound
    `DELETE /groups/:id/trips/:tripId` to its path group so a member of A can't
    delete B's trip. Added `getSave` to `saves.service.ts`. Regression test:
    `server/src/services/__tests__/cross-group-route-scope.integration.test.ts`.
    Also validated under load: the load sim (`server/scripts/sim`) now joins via
    invite links and runs an adversarial phase where non-members try to mutate each
    group's seeded task/list/save/event by id — **312 probes across 24 groups, 0
    leaks**, member controls all pass.
  Bot **read** path was already sound (pre-filter `WHERE group_id` + post-filter
  `scrubCrossGroupLeak`, `cross-group-scope.integration.test.ts`). Service-layer
  defense-in-depth (required `groupId` on `get*/update*` signatures) left as a
  follow-up.
  *(cf. [ADR 0004](../notes/0004-group-scoped-agent.md) group scope,
  [ADR 0032](../notes/0032-strict-per-group-scope.md) strict per-group scope.)*

- [x] **Trip file lifecycle.** Resolved as view-layer archiving (no deletion):
  a trip archives once its last day has passed (`endDate < today`), and its
  source documents (leg/stay `sourceDocId`) archive with it. Both the Trips and
  Files tabs hide archived items by default and reveal them by scrolling up
  (calendar metaphor). Design in [ADR 0046](../notes/0046-trip-lifecycle-archive.md);
  pure logic in `kernel/src/trip-lifecycle.ts`, UI in
  `mobile/app/catchup/[tab].tsx`. Out of scope: manual archive/un-archive,
  per-trip retention policies, archiving non-trip files.
  *(cf. [ADR 0037](../notes/0037-file-management-and-delete.md) file delete,
  [ADR 0040](../notes/0040-user-owned-two-way-calendar.md) trip/event model.)*
- [x] **Long list item fails.** Root cause: list items were capped at 200 chars
  on every layer (kernel `AddListItemRequest`/`UpdateListItemRequest`, the bot
  `add_list_item` tool, mobile `LIST_ITEM_MAX`), so a long item was blocked in
  the UI (`maxLength`) and — worse — a single >200 item failed zod validation on
  the bot path and silently dropped the whole `add_list_item` call. Raised the
  cap to 2000 (new kernel `LIST_ITEM_TEXT_MAX`, matching task details / notes);
  mobile now imports the constant so the UI cap can't drift. DB column is
  already unbounded `TEXT`. *(cf. [resources.md](../subsystems/resources.md);
  related asks: "Long notes", "Free-form list items".)*
- [x] **Delete list with unresolved items.** Not a server guard — `list_items`
  already cascade-deletes with its list (`list_id … ON DELETE CASCADE`), so item
  state never blocks deletion. The block was client-side: `confirmDelete` used a
  multi-button `Alert.alert`, which React Native Web can't render, so on web
  clicking ✕ produced no actionable dialog and the list "appeared blocked".
  Fixed in `mobile/app/catchup/[tab].tsx` with a `confirmDestructive` helper
  (`window.confirm` on web, `Alert.alert` on native) wired into `confirmDelete`.
  *(cf. [resources.md](../subsystems/resources.md).)*

  > **Swept (2026-06-08):** added one shared `mobile/src/confirm.ts`
  > `confirmDestructive` (web `window.confirm` / native `Alert`) and routed every
  > destructive confirm through it. Most sites already had ad-hoc web branches
  > (delete person, delete file, file-missing, connector disconnect /
  > cancel-pairing / invite-reset / leave / delete group, reset demo, disconnect
  > Google Calendar) — those were de-duplicated onto the helper. The one
  > genuinely web-broken destructive path, **task delete** via `openTaskActions`
  > (a multi-button sheet RN Web can't render), now collapses to a delete confirm
  > on web (edit is the inline ✎). Remaining out of scope: the single-button
  > *informational* "Possible conflict" alert in `groups/[id]/index.tsx` (not a
  > destructive confirm; would need a separate `notify` helper for web).
- [x] **Edit individual tasks / list items.** List items + list name were
  already inline-editable (✎). Task editing existed (`TaskEditModal`, edits
  title/details/due) but was only reachable through `openTaskActions`, a
  6-button `Alert.alert` action sheet that React Native Web can't render — so
  on web (the demo surface) the ✏️ Edit callback never fired and tasks looked
  uneditable. Fixed in `mobile/app/catchup/[tab].tsx` by adding a direct inline
  ✎ edit button to the task row (matching the list-item/save pattern); the ⋯
  menu stays for the demo deep-link placeholders.
  *(cf. the "Delete / edit UI" gap in
  [README.md](./README.md); [resources.md](../subsystems/resources.md).)*

  > Note: task **delete** on web is gated behind the same `Alert` action sheet
  > and likely has the same web-reachability issue — out of scope for this
  > edit-focused fix, captured here for a follow-up.
- [x] **Trip → source artifact.** Done in `mobile/app/catchup/[tab].tsx`: a
  new `SourceDocButton` (📎) opens the attachment a leg/stay was extracted from
  (`TravelLeg.sourceDocId` / `Accommodation.sourceDocId`, set by
  `trip_classifier.ts`). Surfaced at the trip level (first available source
  doc), per-leg, and per-stay; opens an authed blob in a new tab on web
  (native binary download still TODO). The flight PNR (`leg.confirmation`) now
  also renders in the leg sub-line, matching stays/reservations.
  *(cf. [ADR 0008](../notes/0008-whatsapp-import.md) `source_raw_context`
  provenance, [ADR 0040](../notes/0040-user-owned-two-way-calendar.md).)*

- [x] **Short-event text truncation in calendar.** Fixed in
  `mobile/app/calendar.tsx`: day-view event/leg blocks shorter than
  `TWO_LINE_PX` (~46px, i.e. under ~1h) collapse to a single time-prefixed
  line instead of rendering the two-line title+meta layout that clipped under
  `overflow:hidden`. The tiny-pill height bump (`SHORT_BLOCK_PX`) stays
  separate; week-view (compact) behaviour is unchanged. *(cf.
  [ADR 0024](../notes/0024-event-ends-at-and-leg-rendering.md) leg/event
  rendering, [ADR 0040](../notes/0040-user-owned-two-way-calendar.md).)*

- [x] **School-calendar PDF with many events dropped / cluttered free-busy.**
  The attachment calendar-classifier capped `events` at 40; a school-year
  calendar exceeded it, failing zod validation so *no* events were filed.
  Fixed in `server/src/services/bot/trip_classifier.ts`:
  cap raised to 180 (`CALENDAR_EVENTS_MAX`) + token budget 8000 so a full
  academic year fits one response; over-cap responses **clamp** (not reject);
  and for calendars longer than the cap the filer **paginates** — re-queries for
  events after the last date (deduped, bounded by `MAX_CALENDAR_PASSES`) so all
  dates are captured. Date-only entries are filed as **all-day** events (free,
  no free/busy clutter) via a new explicit `allDay` flag on `createEvent`.
  Regression test in `__tests__/calendar-events-clamp.test.ts`.

- [x] **Frequent-flyer/loyalty numbers misclassified as phone contacts.** A
  JetBlue frequent-flyer file had its membership numbers stored as phone
  contacts (John/Alice/… "phone numbers"). Tightened guidance so loyalty /
  frequent-flyer / rewards / membership / account / confirmation numbers are
  never treated as phone numbers and a roster of them is not saved as contacts —
  in both the bot `save_contact` tool (`server/src/services/bot/tools.ts`) and
  the image content-classifier (`content_classifier.ts`). Such files stay
  indexed and answerable from their contents instead. (Already-saved bad
  contacts can be deleted in the Contacts UI.)

- [x] **Memory proposal ✓/✕ did nothing.** Confirm/reject on a pending memory
  fired the API but the row never changed — the handler relied on an SSE
  `memory.resolved` event, but the catchup screen is a polling cache with no SSE
  subscription. Fixed in `mobile/app/catchup/[tab].tsx` with an optimistic local
  status override so the row resolves immediately (reconciles on next refetch).

- [x] **Re-uploading the same itinerary duplicates the trip/calendar.** Uploading
  the same flight/hotel (same dates, same PNR, same passengers) as one already in
  trips added it again. Legs had only an exact-timestamp dedup (LLM datetime
  variance slipped through → duplicate leg + duplicate calendar event) and
  accommodations had no dedup at all. Fixed in `server/src/services/trips.service.ts`
  with tolerant `findExistingLeg` / `findExistingAccommodation` (match on trip +
  passenger + date + flight-number/PNR/route, or property + dates/PNR), wired into
  `addTravelLeg` / `addAccommodation` for idempotency. The auto-filer
  (`trip_classifier.ts`) now detects the duplicate, skips the re-add, and tells the
  user it's already in their trips/calendar — keeping the re-uploaded file (both
  remain in Files) but showing only one event in the UI / Google calendar.
  Follow-up: link multiple source files to one entity (single `source_doc_id`
  today, so the re-uploaded file isn't yet attached as a second source).

- [x] **Unify photo + file picking under one composer "+".** Done — the chat
  composer now shows a **single `+`** (`attachBtn` in
  `mobile/app/groups/[id]/index.tsx`) that opens a WhatsApp-style attach sheet
  with tiles: **Photos** (`expo-image-picker`), **Camera**, **Paste image**, and
  **Files** (`expo-document-picker`). The separate 🖼️ button is gone; every tile
  routes into the same `pendingAssets → SharePicker → finalizeUpload` upload →
  index/classify path. On web the `+` opens the document dialog directly (which
  already lists image types), so no multi-button `Alert` is needed.
  *(cf. `mobile/app/groups/[id]/index.tsx` composer + AttachSheet;
  [ADR 0008](../notes/0008-whatsapp-import.md) ingest,
  [attachments.md](../subsystems/attachments.md).)*

- [x] **Google-side deletion of a Chord-created event doesn't converge — event
  persists, keeps nudging, and won't delete.** Core convergence fixed (2026-07).
  Manual delete already drops the local row regardless of Google reachability;
  nudge/render already exclude tombstones; full-window pull now
  `reverseDeleteAbsent` for in-window rows the snapshot omits. Original repro
  and the two compound failures are kept below as the investigation record.

  Repro (historical): Chord creates an event and pushes it to Google; the user
  deletes it **in Google Calendar**. The local copy survived in the Chord DB,
  kept rendering, and stayed in the daily nudge/briefing. Trying to delete it
  again from Chord failed with a *"can't find that calendar"*-style error.
  Two failures compounded:
  1. **Reverse-delete (pull) didn't catch the Google removal.** The pull's
     `delete-local` action only fired when the incremental sync surfaced the
     cancelled/removed event. Stale sync token / gone `calendar_sources` /
     wholesale calendar delete left the row lingering.
  2. **Manual delete throws before the local drop.** (Already fixed — 
     `deleteEvent` unconditionally `deleteFrom('events')` after a swallowed
     push.)

  - [ ] **Remainder (deferred): wholesale calendar delete/unshare ghosts.**
    When a calendar drops out of discovery, `pullCalendarChanges` is never
    called for it, so its rows are not reverse-deleted. Auto-converging on a
    calendar-list 404/403 is risky (transient errors would nuke real events).
    Safe direction if revisited: surface the orphaned source in Settings
    (`needs_reconnect` / "calendar gone") rather than auto-deleting on
    discovery failure. Manual delete still clears individual ghosts.
  *(cf. [ADR 0040](../notes/0040-user-owned-two-way-calendar.md) two-way sync +
  tombstoned deletes, [ADR 0042](../notes/0042-proactive-calendar-reconnect-nudge.md)
  dead-token handling, the "Live calendar refresh" parked item in
  [review-followups.md](./review-followups.md).)*

- [x] **Bot-only connector actions leave no trace in the Chord app (UX confusion).**
  In a **shared** group, a Telegram (or any connector) message that `@`-mentioned
  **only the bot** — no other humans — was force-persisted with `chord_visible=0`
  by the inbound visibility policy regardless of `mirror_inbound`
  (`isBotOnly = mentionsBot && !mentionsOthers`). The bot acted on it, but the
  triggering message, the bot's reply, **and** the ADR-0022 receipt strip were all
  invisible in the Chord app (the list query filters `chord_visible=1`; the
  receipt strip needs a *visible* trigger anchor). The reconnect "re-pull last 50"
  backfill goes through the same visible-only `listMessages` path, so it couldn't
  surface them either — confirmed **not** a backfill/missing-data bug; the rows
  were in the DB, deliberately hidden. Read as lost messages.
  **Fixed** ([ADR 0055](../notes/0055-bot-only-connector-visibility-follows-mirror.md)):
  bot-only messages now follow the group's `mirror_inbound` preference like every
  other message. A bot-only message was still posted in the shared connector
  channel, so every member there already saw it — there was no privacy to
  preserve, only a clutter trade-off the group already controls via
  `mirror_inbound`. Mirroring groups (`mirror_inbound=1`) now surface the bot
  thread + receipt strip on the Chord side; clean-mirror groups
  (`mirror_inbound=0`) still hide the chatter. One-line change in
  `inbound-pipeline.ts`, no schema. (The 3 options weighed: per-sender visibility
  — rejected, needs per-viewer modeling the global `chord_visible` boolean can't
  express and there's nothing to hide from the group anyway; always-mirror —
  rejected, ignores the clean-mirror opt-in; receipt-strip-only/empty-state cue —
  drop the actual content.) *(cf.
  [ADR 0022](../notes/0022-quiet-mode-bot-replies.md) receipt strip — `silent-bridge`
  still keys off a `chord_visible=0` trigger so clean-mirror groups are unaffected;
  [ADR 0051](../notes/0051-post-invocation-followup-window.md) follow-up window.)*

## Feature asks

- [ ] **Fold last-24h chat messages into the daily briefing — summary +
  extraction parity with email (2026-07-17).** Email now gets first-class
  attention treatment (classified tiles, magics proposals, a briefing
  section — ADR 0066/0068/0072) while chat messages get none. Ask: read all
  the user's messages from the last 24 hours (across their groups) and
  (a) include a short per-group summary in the "daily updates" briefing, and
  (b) run the same suggestion extraction over them — staged list items,
  tasks, events, saves — surfaced as owner-confirmed proposals exactly like
  email magics. Design questions to settle first:
  - **Attention equivalence: how many messages ≈ 1 email?** The email map
    weights tiles by unread/pending-magic counts (ADR 0068); if chat joins
    the same attention model, we need an exchange rate (a message is much
    lighter than an email — 10:1? weight by group, by mention, by length?)
    so one noisy group chat doesn't drown the inbox.
  - **This deliberately revisits D1** (no silent background extraction,
    decided 2026-04-17) — the boundary that keeps it consistent with D1/D8
    is the same one email magics use: ambient content may be *scanned*, but
    everything surfaces as a staged proposal in an already-consented surface
    (the briefing), never an unconsented write or an unprompted bot post.
  - Cost: a daily cross-group summarization pass is an LLM call per active
    group per day — bound it (skip quiet groups, cap tokens) and gate it
    behind an env flag like the email features.
  *(cf. ADR 0072 one-briefing, ADR 0034 nudge time, ADR 0035 context window,
  `proactive.service.ts`, the email magics pipeline in
  `server/src/services/email/magics.service.ts`; D1 in
  [README.md](./README.md).)*

- [x] **Active listening window — keep responding for N turns after an invocation.**
  Shipped as the **post-invocation follow-up window** ([ADR 0051](../notes/0051-post-invocation-followup-window.md)):
  after an `@`-mention the bot answers the GROUP's next `BOT_FOLLOWUP_TURNS`
  messages from any member (default 3, server-configurable, hard-capped at 20,
  TTL-bounded) without a re-mention. In-memory + **group-scoped**;
  `decideReaction` gained an `inFollowupWindow` input + `followup` action, wired
  in `routes/messages.ts` and `connectors/inbound-pipeline.ts`, store in
  `services/bot/followup-window.ts`. Original capture below for context.
  Today a group only gets a bot reply when the message `@`-mentions Chord
  (`decideReaction` in `server/src/services/bot/bot.service.ts`): every turn of a
  back-and-forth has to re-tag `@Chord`, which is unnatural mid-conversation
  ("@chord import the school calendar" → "from online" → "the county is Fairfax"
  each needs the mention). Ask: once invoked, Chord stays "active" and answers the
  **next N turns** (or for **T minutes**) from the triggering user without a
  re-mention, then falls back to silent. The `ListeningMode` enum already has an
  `'active'` value (`bot.service.ts`, alongside `'invocation'`/`'passive'`) but it
  is **state with no TTL/turn-count window** — nothing opens, counts down, or
  closes it. Scope: persist a per-(group,user) active-until marker (timestamp or
  remaining-turn counter) set when the bot reacts, checked in `decideReaction`,
  decremented/expired each turn; probably scope to the invoking user so one
  person's thread doesn't make Chord answer everyone. Watch for noise (don't barge
  into unrelated chatter) and cost (every in-window message becomes a bot turn).
  *(cf. [ADR 0018](../notes/0018-listening-modes.md) listening modes,
  [ADR 0035](../notes/0035-recency-aware-context-window.md) for the time-window
  precedent, the Long-term-vision "always listening" note above.)*
- [ ] **Background crawler to auto-populate the school-calendar registry.** The
  `import_calendar` district lookup (ADR 0050) resolves a county/district/school
  name to an ICS feed against a small **hand-maintained** map
  (`server/src/services/ingest/ics/district-registry.ts`) — coverage is whatever
  is seeded by hand. Ask: a background crawler/job that builds a list of schools
  by **district and county** and discovers each one's public ICS/webcal feed,
  feeding the registry automatically so "import the Fairfax County calendar"
  works without us hand-adding every district. Scope to sketch: a seed source for
  the district/county/school taxonomy (NCES district lists, state DOE rosters, or
  a search pass), per-district calendar-page discovery + ICS-link extraction,
  validate each feed through the existing SSRF-guarded `fetchIcsBuffer`
  + `parseIcsBuffer` before storing, and persist into a table (the registry moves
  from a TS literal to DB-backed). Run it offline/periodically — NOT in the
  request path. Watch for: stale/moved feed URLs (re-validate on a schedule),
  name collisions across states (key by county+state), and politely respecting
  robots/rate limits on district sites. This is the durable answer to the
  "curated registry vs. live web-search" tradeoff ADR 0050 deferred — precompute
  the lookup table instead of searching per request.
  *(cf. [ADR 0050](../notes/0050-online-calendar-import.md) online calendar import
  + district registry, `fetch-ics.ts` SSRF guard, `parse.ts` ICS parser.)*
- [x] **Shareable join link.** Turned the invite **code** into a clickable
  `<web-origin>/join/<CODE>` URL: opening it joins the group and drops you in
  the chat. Signed-out visitors get the code stashed in AsyncStorage so it
  survives Google's full-page OAuth redirect, then auto-join after sign-in —
  same trick as the Telegram `?ref=` referrer. New route
  `mobile/app/join/[code].tsx`, helpers in `mobile/src/join-code.ts` +
  `inviteUrl()` in `mobile/src/api.ts`; the Invite section in group settings
  now leads with the copyable link (code kept as secondary), and the legacy
  "Join by code" box accepts a pasted link too. No server change — the join
  endpoint already did the work. Design in
  [ADR 0047](../notes/0047-shareable-join-links.md).
  *(cf. [ADR 0031](../notes/0031-uuid-signup-soft-link.md) referrer pattern,
  [ADR 0045](../notes/0045-group-lifecycle.md) invite regeneration.)*
- [x] **Catchup tab consistency: add/ingest + photo picking + rendering + affordance hints.**
  Parts 1 and 3 shipped. Original inconsistency: **Saves / Lists / Tasks** let
  you add *and* edit inline, but **Trips** and **Files** were read-only, and
  Files rendered attachments differently from chat/trip source docs.
  1. ✅ **Done — `+` on Files and Trips that ingests an upload.** Shared
     `UploadAddRow` + group picker; uploads go through `uploadFile` → `saveFile`.
  2. ✅ **Done — pick screenshots/photos (+ camera) at the tab level.** Native
     shows **📄 File** + **🖼 Photos** + **📷 Camera**; web uses one document
     dialog. Same `uploadFile` path as the composer.
  3. ✅ **Done — consistent file rendering in the Files tab** (image thumbnails
     matching chat `AttachmentCard`). Broader card unification deferred.
  4. ✅ **Done — empty-state affordance hints** on Trips / Files pointing at +.
  *(cf. `mobile/app/catchup/[tab].tsx` sections;
  [ADR 0036](../notes/0036-bot-sends-files-not-links.md) file delivery,
  [ADR 0037](../notes/0037-file-management-and-delete.md) Files tab,
  [ADR 0008](../notes/0008-whatsapp-import.md) ingest pipeline +
  `trip_classifier.ts`, the shipped composer image-pick + "Unify photo + file
  picking" items, [attachments.md](../subsystems/attachments.md),
  [resources.md](../subsystems/resources.md).)*
- [x] **Pick screenshots / pictures from the mobile app (chat composer).** The
  composer's `+` used `expo-document-picker`, which on native opens the Files app
  and can't reach the camera roll where screenshots and photos live. Added a 🖼️
  button next to `+` in `mobile/app/groups/[id]/index.tsx` that uses
  `expo-image-picker` (`launchImageLibraryAsync`, multi-select, images) and feeds
  the **same** `pendingAssets → SharePicker → finalizeUpload → uploadFile →
  postMessage` path the file picker already used — so images go through the
  existing upload → index / classify pipeline unchanged. Works on iOS, Android,
  and web (the picker falls back to an `image/*` file input on web). iOS
  photo-library permission string added via the `expo-image-picker` config plugin
  in `app.json`. **Update:** the 🖼️ button has since been folded into a single
  `+` attach sheet (Photos / Camera / Paste image / Files), and catchup
  Files/Trips `+` now offers Camera too (see Catchup residue above).
  *(cf. the tab-level "pick a file/screenshot → upload" ask in "Catchup tab
  consistency" above; [ADR 0008](../notes/0008-whatsapp-import.md) ingest
  pipeline, [attachments.md](../subsystems/attachments.md).)*
- [ ] **Add Chord to the OS share sheet (forward content *into* Chord).** Let
  users share a screenshot / photo / link / file / text *from* another app
  (Photos, Safari, WhatsApp, Files, Mail) into Chord via the native Share Sheet,
  like every other messaging app. Needs a native share target (iOS Share
  Extension + Android `ACTION_SEND` intent filter) via the community
  `expo-share-intent` config plugin — no first-party Expo module exists. The
  received payload routes into the **existing** `uploadFile` / `postMessage`
  paths (images/files upload, URLs/text post as messages), so no server change.
  **Decided:** the receive flow **always shows a group picker** (no silent
  default to "My Chord"). Signed-out shares stash + resume after OAuth (same as
  the join-code pattern). Requires an EAS dev build — not testable in Expo Go or
  on web. Full design + decisions in
  [ADR 0049](../notes/0049-os-share-target.md) (status: proposed — implement on
  confirm).
  *(cf. [ADR 0008](../notes/0008-whatsapp-import.md) ingest, the 🖼️ composer
  image-pick above, [ADR 0048](../notes/0048-native-deeplinks-for-invite-links.md)
  for the complementary inbound-navigation deep links,
  [attachments.md](../subsystems/attachments.md).)*
- [ ] **On-device AI helper (Apple Foundation Models) — composer smart-reply.**
  A privacy-preserving, **client-side** use of Apple's on-device LLM
  (`LanguageModelSession`, `FoundationModels`, iOS 26) that does NOT touch the
  server bot loop. **Decided surface: smart-reply / draft suggestions in the chat
  composer** — generate 1–3 short reply drafts from the last few visible messages
  (small input fits the ~4k context); instant, offline, private. Mobile-only,
  additive: preview-stage community bridge (`@react-native-ai/apple` preferred, or
  `react-native-apple-llm`) + config plugin in `app.json`; **EAS dev build only**
  (unavailable in Expo Go / web / simulator-without-model; needs iPhone 15 Pro+ /
  iOS 26). Gate every call on `isFoundationModelsEnabled()`. **Decided fallback:
  on unsupported devices (iPhone 14 / non-Pro-15 and older, non-iOS, web) route
  the same draft request through the existing server-side `LlmService`** so the
  affordance is always available. New wrapper `mobile/src/on-device-ai.ts`
  (`isAvailable()` + `suggestReplies(context)`) + a composer UI hook in
  `mobile/app/groups/[id]/index.tsx`; the server-fallback path adds a small
  draft-suggestion endpoint over `LlmService`. **Not buildable/verifiable in the
  current Windows/web harness — implement on a device build.**
  *(cf. [ADR 0052](../notes/0052-apple-on-device-ai-and-imessage.md) — device
  matrix + why it can't be the server bot engine;
  [ADR 0044](../notes/0044-byok-failure-and-future-billing.md) LLM providers.)*

  > **Closed (not buildable): "@Chord inside an iMessage / RCS conversation."**
  > No public API lets a third-party app participate in a user-to-user iMessage
  > or RCS thread — iMessage extensions are user-initiated UI only; RCS Business
  > Messaging is business→consumer. The achievable form of "@Chord in a chat" is
  > the connector pattern (ADR 0010) on bot-API platforms (Telegram shipped,
  > Slack/Discord). See [ADR 0052](../notes/0052-apple-on-device-ai-and-imessage.md).

- [ ] **Fresh message load on new-device login — never reuse device cache.** When
  a user signs in on a **new device** (or a fresh install), each chat's messages
  must be pulled fresh from the DB and rendered, not served from any device-local
  cache. Today the message store is in-memory only (`mobile/src/store.ts`
  `messagesByGroup`, hydrated per chat via `setMessages` in
  `mobile/app/groups/[id]/index.tsx`) — there's no AsyncStorage/`persist` layer,
  so a brand-new device already fetches from the server. This item is the
  **invariant + guard**: if/when we add offline message persistence (zustand
  `persist`, AsyncStorage, SQLite), it must be **keyed by user id** and dropped on
  logout/account-switch so a new login never renders a previous session's cached
  thread. Watch the `setMessages` merge-by-id behavior — on a new login it should
  *replace*, not merge into, any residual state. Add a regression check that a
  login flushes `messagesByGroup` (`reset()` already clears it on logout — confirm
  it's called on every auth transition).
  *(cf. `mobile/src/store.ts` `reset()`/`setMessages`, the
  AsyncStorage join-code stash in `mobile/src/join-code.ts` for the per-device
  storage pattern, [ADR 0014](../notes/0014-google-only-auth.md) auth.)*
- [ ] **File intent prompt.** Let the user say what they want done with an
  uploaded file — indexed for retrieval, or just kept for info (not indexed).
  *(cf. [ADR 0006](../notes/0006-keyword-retrieval.md) +
  [ADR 0021](../notes/0021-fts5-attachment-index.md) indexing,
  [attachments.md](../subsystems/attachments.md).)*
- [ ] **Long notes.** Ability to add long-form notes.
  *(cf. [resources.md](../subsystems/resources.md).)*
- [ ] **Free-form list items.** Listicles should allow free-form text, not just
  bulleted items. *(cf. [resources.md](../subsystems/resources.md).)*
- [ ] **Separate lists from tasks (later).** Current implementation treats lists
  and tasks as the same thing — split the data model / UX. Explicitly deferred.
  *(cf. [resources.md](../subsystems/resources.md).)*
- [ ] **Lock "About me" (passcode / Face ID).** Let the user lock their persona /
  about-me behind a device-local secret — Face ID / Touch ID on iOS, a passcode or
  platform authenticator (WebAuthn) on web. The unlock key lives **on the device**
  (iOS Keychain / Secure Enclave; web platform credential or local passcode), never
  on the server. The about-me is stored **encrypted**, and decrypted **on-device**
  only when the user authenticates to read or edit it. Platforms: web + iOS (Android
  follows the same shape via the Android Keystore / BiometricPrompt).
  - **Decided: UI-only lock + cross-device sync.** The about-me stays as **server
    plaintext** so the bot keeps using it for personalization; the lock is a
    client-side gate on *viewing/editing in the app*, not encryption. This is a
    privacy / shoulder-surfing deterrent, **not** a cryptographic boundary — the
    server and bot still see the plaintext. (Picked over true client-side
    encryption, which would have cost the bot its about-me context.)
  - **What syncs vs. what's per-device:** the **lock-enabled flag** is a server-side
    per-user setting (e.g. `about_me_locked`), so locking on iOS also gates the web
    app — that's the cross-device sync. The **unlock secret** (Face ID / Touch ID /
    passcode) is enrolled **locally per device** and does not sync; each device sets
    up its own.
  - **Open questions:** first unlock on a *fresh* device when the flag is already on
    (the lock flag synced but no local secret is enrolled yet — likely require the
    device's own auth / re-enroll on first view); the web "biometric" story (WebAuthn
    platform credential vs. a plain app passcode); whether a global app-passcode is
    reused or this is a standalone about-me gate.
  *(cf. [ADR 0007](../notes/0007-user-identity-in-turn.md) identity,
  [ADR 0020](../notes/0020-cross-group-personal-context.md) personal context,
  [ADR 0043](../notes/0043-account-deletion.md) data teardown; related asks below:
  "Lock what chat knows about me", "E2E encryption".)*
- [ ] **Lock what chat knows about me.** Security feature — user control over
  what the assistant has learned/retains about them. (Related to "lock About me".)
  *(cf. [ADR 0020](../notes/0020-cross-group-personal-context.md),
  [ADR 0043](../notes/0043-account-deletion.md) data teardown.)*
- [ ] **Slack app + nudge edits.** Slack connector; ability to edit nudges.
  *(cf. [ADR 0010](../notes/0010-im-connectors.md) +
  [im-connectors.md](./im-connectors.md) +
  [connectors.md](../subsystems/connectors.md);
  [ADR 0034](../notes/0034-configurable-nudge-time.md) for nudges.)*
- [x] **Calendar moves with time.** Done in `mobile/app/calendar.tsx` (mobile +
  web) via a shared `useNowTracking` hook: Day/Week views now open centered on
  the current time (not a fixed 7am), the red now-line ticks every 30s so it
  advances live, and the view re-centers when "now" drifts off-screen — unless
  the user scrolled in the last minute (so it tracks time without fighting
  manual scrolling). Non-today days still open at 7am; "Today" re-centers on now.
  *(cf. [ADR 0040](../notes/0040-user-owned-two-way-calendar.md).)*
- [x] **Search.** Done — shipped as global + in-group search
  ([ADR 0062](../notes/0062-global-search-fts.md): per-table `search_tsv` +
  GIN, `GET /me/search` + `GET /groups/:id/search`, 🔍 `SearchModal` in the
  composer) and the bot-side `search` tool ([ADR 0059](../notes/0059-unified-search-tool.md)).
  Remaining polish tracked in the F&F doc (Workstream L): message-anchor
  deep-link, converging the bot tool onto the FTS path.
- [ ] **Link previews.** Render previews for shared links.
  *(cf. `save_link` in [resources.md](../subsystems/resources.md).)*
- [ ] **Background tagging.** Auto-tag content in the background.
  *(cf. [ADR 0006](../notes/0006-keyword-retrieval.md) retrieval.)*
- [ ] **Recipe detection + ingredient extraction.** Detect recipes and pull out
  ingredients (→ list?). *(cf. lists in [resources.md](../subsystems/resources.md).)*
- [ ] **Finance tab.** Add finance as a tab for managing finances.
  *Partially landed:* the To Do's hub ships a deliberate Finance scaffold
  sub-tab ([ADR 0070](../notes/0070-todos-hub-action-items-first.md)); the
  actual finance features behind it are still open.
- [x] **Model routing.** Done — three-tier per-user routing (BYOK / premium /
  OSS free tier) shipped as `resolveTurnLlm` in `llm/factory.ts` with the
  credit ledger ([ADR 0063](../notes/0063-billing-and-model-routing.md)),
  gated by `BILLING_ENABLED`. Remaining: the Stripe purchase slice + the J2
  OSS model pick (tracked in the F&F doc, Workstream J).
- [ ] **Per-app deep linking.** Appropriate deep linking by app for different
  tasks. *(cf. [ADR 0039](../notes/0039-external-action-deep-links.md).)*
- [x] **Backend mailbox for ingest.** Closed — cut with F&F Workstream K
  (2026-07-15): the in-app Gmail reader track (ADR 0060/0061/0066 + email
  magics + attachment import ADR 0071) covers the job without running an
  internet-facing SMTP server. The full SMTP design is preserved in the F&F
  doc's Workstream K section should non-users ever need to email a group
  directly.
- [ ] **Smarter file indexing.** Index uploaded files more intelligently to
  build richer context (beyond the current keyword/FTS pass).
  *(cf. [ADR 0006](../notes/0006-keyword-retrieval.md) +
  [ADR 0021](../notes/0021-fts5-attachment-index.md).)*
- [ ] **E2E encryption.** End-to-end encryption of user data.

## Business / monetization

- [ ] **Pricing strategy.** Think through BYOK vs. hosted (we run the key).
  *(cf. [ADR 0044](../notes/0044-byok-failure-and-future-billing.md) for the
  BYOK side already in place + the metered-billing direction.)*
- [ ] **Billing mechanism.** Core landed ([ADR 0063](../notes/0063-billing-and-model-routing.md)):
  credit ledger + per-premium-turn debit + tier routing behind
  `BILLING_ENABLED`. Open: the Stripe checkout/webhook slice + mobile billing
  card — release-blocking, tracked as F&F Workstream J1.
  *(cf. [ADR 0044](../notes/0044-byok-failure-and-future-billing.md).)*
