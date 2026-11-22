# Consensus-before-commit for bot writes

**Status:** proposed, not started. Supersedes the "bot fires on every `@Chord`"
assumption baked into ADRs 0003 / 0005 and the D1 decision (2026-04-17) in the
main roadmap. Pre-condition: write ADR 0009 before any code lands.

## Problem

Today every successful bot tool call writes to the DB synchronously — see
`bot.service.ts` → `executor.ts` → service → insert + SSE in one tick. There is
no "tentative" state. When people are still *discussing* (Costco list being
revised across six messages, potluck dish being argued about, trip dates being
negotiated), the bot either reacts on every turn (churn) or not at all (relies
on `@Chord` mention as the only gate). The goal is a third mode: the bot
records what it thinks the group wants, but waits for explicit consensus
before writing the entity.

Passive **memory extraction** is the most visible version of the same problem
after the 2026-04-23 commit — it now writes open-vocabulary facts to the
`memories` table on every turn with only a confidence threshold gate.

## Design decisions to make (ADR 0009 — write first)

Treat these as the checklist for the ADR; don't start implementation until
they're resolved.

- [ ] **Storage shape.** Shared `proposals` table keyed by `(group_id, kind, tool_name, args_json)` vs. `status: 'proposed' | 'confirmed'` column on each entity. Shared table is cleaner for reversibility + group-commit (trip + legs + accommodations as one proposal bundle); per-entity column is easier to surface in existing Resources UI.
- [ ] **Approval verbs.** Which of: inline Approve/Reject buttons on the bot bubble; `@Chord confirm` / `@Chord drop` natural-language; emoji reactions on the bot bubble (✅ / ❌); per-member vs. first-responder wins.
- [ ] **Commit quorum.** First member to approve commits, or N-of-M, or owner-only. For the demo: probably "any member can confirm," but note explicitly.
- [ ] **TTL.** Do unapproved proposals auto-drop after N hours, or linger until explicitly rejected? Default: 24h drop with a visible "expiring" indicator.
- [ ] **Ingest mode.** WhatsApp import (`services/ingest/whatsapp/pipeline.ts`) currently auto-commits — should it stay auto-commit (user opted into bulk) or produce a post-import proposal tray? Probably auto-commit with a review-after affordance.
- [ ] **Scope.** Which entities get gating: all bot-writable ones (tasks, lists, saves, events, trips/legs/accommodations/reservations, contacts, places, memories) vs. expensive-only (trips + memories). Recommendation: all, but ship incrementally.
- [ ] **Directive override.** Explicit directives ("@Chord, create the task 'X'") skip the gate and commit immediately; discussion-style triggers propose. How does the bot distinguish — classifier, or rely on phrasing heuristics in the prompt?
- [ ] **Provenance.** Proposals carry the triggering message id + `source_raw_context`; commits carry the proposal id so drill-down shows "proposed at <msg>, confirmed by <user> at <msg>."

## Tasks

Checkboxes; pick up the phase you want to land. ADR first.

### Phase 1 — Design + memory-only vertical slice ✅ shipped 2026-04-23

Cheapest entity with the biggest trust win. Memories already have a natural UI
surface (`MemoriesSection` in `mobile/app/groups/[id]/resources.tsx`) and
supersedable semantics — extending with a status field is low-risk.

- [x] **ADR 0009** — propose-then-confirm for bot-created entities.
- [x] `memories.status` column (`'proposed' | 'confirmed'`). New rows from passive extraction default to `'proposed'`; the migration defaults existing rows to `'confirmed'` (they predate the gate).
- [x] Migration `009_memory_proposal_status`.
- [x] `server/src/services/memory.service.ts`: `listMemoriesForUser` / `listMemories` gain an optional `status` filter (default: return both, so the mobile UI splits client-side). `queryForTurn` filters to `status='confirmed'` only — proposed rows are invisible to the LLM until accepted. `upsertMemory` accepts an optional status; when inserting `'proposed'` it no longer supersedes the existing confirmed row — supersession happens on confirmation.
- [x] New `confirmMemory` / `rejectMemory` service functions. Confirm flips status + supersedes prior confirmed rows; reject is a hard delete (audit view deferred to Phase 7).
- [x] Extraction writes `status='proposed'` and broadcasts SSE `memory.proposed`.
- [x] Kernel: `SSE.memoryProposed`, `SSE.memoryResolved`; `MemoryStatus` type on `Memory`; `API.memoryConfirm` / `API.memoryReject` constants.
- [x] Routes: `POST /api/v1/memories/:id/confirm`, `POST /api/v1/memories/:id/reject`, each gated on group membership via an inline `isMember` check (the memory id identifies the group).
- [x] Mobile: "Pending facts" sub-section inside `MemoriesSection` with inline ✓ / ✗ buttons; rejected rows delete locally via SSE `memory.resolved`, confirmed rows flip status in place without refetch.

### Phase 2 — Shared proposal infrastructure ✅ shipped 2026-04-23

Generic plumbing landed alongside the task vertical (Phase 3) — the
abstraction only pays off once a second entity uses it, so they were built
together.

- [x] Schema: `proposals` table — `id`, `group_id`, `proposed_by_user_id`, `proposed_by_message_id`, `tool_name`, `args_json`, `provenance`, `status ('pending'|'confirmed'|'rejected'|'expired')`, `resolved_by_user_id`, `resolved_at`, `resolved_by_message_id`, `bundle_id` (nullable), `expires_at` (24h default TTL), `created_at`. Index on `(group_id, status)`.
- [x] Migration `010_proposals_table`.
- [x] `server/src/services/proposals.service.ts` — `createProposal`, `getProposal`, `listProposalsForGroup`, `listProposalsForUser`, `confirmProposal` (re-validates args against `toolSchemas` then dispatches through `applyToolCall` in commit mode), `rejectProposal`, `expireStale` (lazy sweep called on list reads).
- [x] `executor.ts`: `applyToolCall` gains `mode: 'propose' | 'commit'` (default `'commit'` preserves ingest + confirmation paths) and `triggeringMessageId`. A `PROPOSABLE_TOOLS` set gates which tools respect propose mode; starts with `create_task` and extends per entity in Phase 4.
- [x] Kernel: `SSE.proposalCreated`, `SSE.proposalResolved`; `Proposal` + `ProposalStatus` + `ProposalResolvedEvent` types; `API.groupProposals`, `API.meProposals`, `API.proposalConfirm`, `API.proposalReject`.
- [x] Routes: `GET /api/v1/groups/:id/proposals`, `GET /api/v1/me/proposals`, `POST /api/v1/proposals/:id/confirm`, `POST /api/v1/proposals/:id/reject`. Confirm/reject gated on group membership via inline `isMember` check.

### Phase 3 — Task vertical ✅ shipped 2026-04-23

- [x] Bot's `create_task` tool runs in propose mode by default. Directive override is **out of scope per ADR 0009 decision #7** — always-propose is the rule. (Phase 5's `@Chord confirm` shortcut provides the fast-path instead.)
- [x] `bot.service.ts` `executeAndBroadcast` threads `triggeringUserId` + `triggeringMessageId` from the trigger message through both the text-fence and native-loop paths; the executor stages a proposal row + broadcasts `proposal.created`.
- [x] Integration test `turn.integration.test.ts` updated: "book a rental car" no longer writes a `tasks` row; asserts a pending proposal exists with the right title.
- [x] Resources → Tasks section renders "Proposed" group above confirmed tasks with yellow-bar pending style + inline ✓ / ✗ buttons. Reuses the memory-tray styling so the pattern is recognizable cross-entity.
- [x] SSE: `onProposalCreated` merges in place; `onProposalResolved` removes from proposal list, and the committed entity arrives via its own SSE event (`task.created`) which triggers `onResourceChanged` — no explicit refetch for the commit path.
- [x] **Chat bubble proposal pills with inline Approve / Reject** ✅ shipped 2026-04-23. Proposal pills render under each bot bubble (indexed by `proposedByMessageId ↔ replyToId`), live-updated via `onProposalCreated` / `onProposalResolved` SSE. Initial load fetches `listProposalsForGroup` so historical bot turns also show pending pills.
- [x] Natural-language `@Chord confirm p_abc` / `@Chord drop p_abc` verbs — shipped in Phase 5 below.

### Phase 4 — Roll out to remaining entities ✅ shipped 2026-04-23

- [x] `PROPOSABLE_TOOLS` extended to cover every write tool: `add_list_item`, `create_event`, `record_rsvp`, `save_link`, `save_place`, `save_contact`, `save_media`, `create_trip`, `add_travel_leg`, `add_accommodation`, `add_reservation`.
- [x] Generalized `proposeCardFor(call)` in `executor.ts` derives a meaningful `BotCard` (title/subtitle/meta) per tool. Propose-mode no longer hardcodes the task shape.
- [x] `create_trip` + children as a **bundle**. `bot.service.ts` tracks a per-turn `TurnBundle`: the first `create_trip` in a turn mints a `bundle_id` that subsequent `add_travel_leg` / `add_accommodation` / `add_reservation` calls in the same turn inherit.
- [x] `proposals.service.ts` bundle-aware `confirmProposal`: when a proposal has a `bundle_id`, load all pending siblings, commit `create_trip` first, then substitute the new `trip.id` into child proposals' args before their commits. `rejectProposal` rejects every pending bundle member atomically. Route broadcasts `proposal.resolved` per affected id.
- [x] `createTrip` service accepts an optional pre-allocated `id`. Not currently used by the bundle path (args-override substitution is sufficient) but available if a future caller needs determinism.
- [x] Mobile Resources uniform treatment: a shared `ProposalRow` + `useProposedBlock` hook + `describeProposal` mirror of the server helper drive the "Proposed — N" sub-block in Lists, Events, Saves, Places, Media, Contacts (plus the existing Tasks section).
- [x] Trips section: pending proposals group by `bundleId` and render as a `TripBundleCard` — trip name/destination/dates at top, legs/stays/reservations in a timeline, single "Approve all" / "Reject all" pair. Non-bundled trip proposals (e.g. an `add_reservation` extending an existing trip) render as plain ProposalRows.
- [x] Integration test updated: `@Chord add to Costco list - bread` now asserts a pending `add_list_item` proposal with the right `listName` + `items`, not an immediate list row.

### Phase 5 — Natural-language consensus verbs ✅ shipped 2026-04-23

- [x] `@Chord confirm [ref | all]?` / `@Chord drop [ref | all]?` / `@Chord approve` / `@Chord reject` — shipped via `services/bot/confirm-verb.ts`. Hooks in `routes/messages.ts` POST handler **before** `decideReaction`, so the LLM is never invoked for this path. Matches proposal id prefix (with or without `p_`), falls back to most-recent pending when no ref, or fans out across all pending when `ref === 'all'`. Bundle-aware via the shared `proposals.service` — confirming any member of a bundle cascades. Posts a short synthetic bot reply ("OK — confirmed 3.") and broadcasts `proposal.resolved` per affected id.
- [x] Unit test in `__tests__/confirm-verb.test.ts` locks the parser grammar (6 cases covering bare verbs, aliases, "all", ids, and false-positive rejection).
- [ ] `@Chord yes` / `@Chord no` — ambiguous; deferred. Needs an LLM turn reading recent pending proposals and calling a `resolve_proposal` tool. Not required for the demo path.
- [ ] Natural "everyone agree?" detection — out of scope, waits on the Phase 6 classifier.

### Phase 6 — Discussion classifier (optional, stretch)

Replaces the current binary `@Chord`-mention gate with three modes.

- [ ] `classifyTrigger(context)` returns `'directive' | 'discussion' | 'ambient'`. Directive → commit mode; discussion → propose mode; ambient → no-op (unchanged from today's no-mention-no-react).
- [ ] Signals: distinct speakers in last N, hedging language, question marks, prior unresolved proposals on the same topic.
- [ ] Decision surface: ADR update + mock provider must produce deterministic outputs for demo tests.

### Review follow-ups 2026-04-23

- [x] **Bundle commit is now atomic end-to-end.** `confirmProposal` wraps every row in a `db.transaction()`, and — crucially — SSE broadcasts are now **buffered inside the transaction and only fire on commit**. A mid-bundle throw rolls back every write and discards the buffered events, so clients never see phantom `task.created` / `trip.updated` for entities that no longer exist. Implementation: new `SseBroadcaster` type + optional `emit` field on `ApplyToolCallInput`; executor's 12 internal `sseHub.broadcast` sites route through `emit`; the proposals service wraps commits in a `createBufferedEmitter()` → flush-on-success pattern. Applies to both the bundle and standalone confirm paths.
- [x] **Trip id flows through the bundle result.** `create_trip` executor returns `data: { tripId, trip }`. `commitRow` now returns the full `ToolExecutionResult`. Child proposals read `newTripId` from that return value instead of re-querying by `(group_id, name, destination, most-recent)` — no race or same-name mis-attachment.
- [x] **Superseded memory drops from the live view immediately.** `confirmMemory` returns `{ memory, supersededId }`. The confirm route broadcasts `memory.resolved { id: supersededId, status: 'rejected' }` in addition to the accepted row, so the client's existing remove-on-rejected handler drops the stale value without a refetch. DB still records `superseded_by` for audit.
- [x] **Mobile SSE subscribes to `reservation.created`.** Both the EventSource path and the react-native-sse path now wire it to `handleResourceChanged`, matching `travel_leg.created` / `accommodation.created`. New reservations committed via bundle approval refresh Resources live.

Known remaining gap (noted, not in this round): some trip-child executor cases "soft fail" (return a summary string like `"add_travel_leg: trip not in this group"` rather than throwing). Inside a bundle transaction, a soft-failing sibling therefore does **not** trigger rollback of the already-committed trip. For bundle semantics to be fully fail-fast, those paths should either throw or signal failure through a structured result the bundle loop inspects. Separate from this review's scope.

### Phase 7 — Housekeeping ✅ shipped 2026-04-23 (partial)

- [x] `expires_at` lazy sweep — `expireStale(db)` in `proposals.service` returns `{id, groupId}[]`; the two GET routes (`/groups/:id/proposals`, `/me/proposals`) call a `sweepAndBroadcastExpired` helper that emits `proposal.resolved { status: 'expired' }` per affected row so pending pills disappear live.
- [x] Per-section "Recent activity" footer in Resources: shared `AuditBlock({ proposals })` with a toggle ("▸ Recent activity — N"); expanded view shows last 5 rejected/expired with strikethrough label, relative time, and ⌛/✗ icon. Wired into every section (Tasks, Lists, Saves, Events, Trips, Places, Media, Contacts). Resources `onProposalResolved` handler now _updates_ status in state instead of removing, so the audit reflects fresh resolutions immediately.
- [ ] Cron sweep — deferred. Lazy-on-list is correct for the demo. Add only if a background metric requires it.
- [ ] Metrics in server log (daily counts per group) — deferred. Can sit on a future observability pass.
- [ ] Memory "trained vocabulary" view — deferred. The existing `MemoriesSection` pending list surfaces newly-invented keys at propose time, which covers the most-urgent fragmentation signal; a historical-rejection aggregate is only useful after rejected-memory retention lands (currently hard-deleted).

## Non-goals

- Not adding multi-party **quorum** (N-of-M). First confirmer wins.
- Not reworking the share-offer (`bot.share.offer`) flow — it already has its own accept/reject path and is orthogonal.
- Not touching the ingest commit model in Phase 1–3. If it changes, it's a Phase 4-adjacent decision.

## References

- Pre-condition ADR: **0009** (not yet written).
- Supersedes / amends: ADR 0003 (text-fence tool protocol), ADR 0005 (iterative tool use).
- Revisits: D1 decision in `docs/tasks/README.md` (2026-04-17 — "silent background extraction: not for now").
- Bot subsystem: `docs/subsystems/bot.md`.
