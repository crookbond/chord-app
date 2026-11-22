# Roadmap

What to build next. Organised by urgency + category, not chronologically.

> **Phase 5 — multi-developer app + Google integration.** Plan in
> [`phase-5-plan.md`](./phase-5-plan.md). Decisions: ADRs
> [0014](../notes/0014-google-only-auth.md),
> [0015](../notes/0015-server-side-google-calendar.md),
> [0016](../notes/0016-family-graph-in-sqlite.md). 0015 supersedes
> the device-calendar section of 0012.

> **🚀 Public release: [`friends-and-family-release.md`](./friends-and-family-release.md).** TestFlight + the family cohort are live (2026-09); the plan now tracks the **public launch on the iOS App Store (US storefront) + web** — native Android deferred 2026-09-10. Launch blockers: Google OAuth verification + CASA (O1), the Apple login decision (O2), Stripe subscription (J3), Sentry (N), and the App Store submission incl. an explicit AI-sharing consent screen (O3). Workstreams A–N keep their F&F-era history; K/inbound-email was cut 2026-07-15.

When to add here: any gap, rough edge, or design question you don't want to resolve right now. Favour capture over polish — one line is fine.

> Raw, un-triaged bug reports + feature asks land in [`backlog.md`](./backlog.md); promote them here once scoped.
> Email-specific capture in [`Email-bugsandbacklog.md`](./Email-bugsandbacklog.md) is **triaged (2026-08-28)** — bugs closed, backlog 3/4/11 shipped; remaining item 13 is exploratory product candidates, not an active bug queue. Open email work: [`chord_email.md`](./chord_email.md), parity / labels / signals plans above.

> **📬 Mail parity: [`email-parity-audit.md`](./email-parity-audit.md).** What a mail app does vs. what Chord does (2026-08-24) — the table-stakes inventory behind the AI roadmap in [`chord_email.md`](./chord_email.md). Outbound is reply-only, there is no folder browsing, search is reachable only from the personal 1:1 chat, and three rows are mirror bugs. Verdicts + a six-wave sequence.
>
> **⛔ [ADR 0149](../notes/0149-the-mail-surface-is-bounded-to-coordination.md) reframes the parity audit, it does not resume it.** Net-new mail-client parity/polish is frozen; a mail change ships only if it produces or improves a **shared family artifact**, and every email-touching commit must name that artifact in its body. The sanctioned email lane is the three harness workstreams (people/family extraction dogfood, routing → shared groups, the briefing digest) — see the ADR.

> **🏷️ Chord labels on every mailbox: [`email-chord-labels-plan.md`](./email-chord-labels-plan.md).** Wave 1 shipped (local `chord_label_ids`, ADR 0141). **Wave 2 shipped** (opt-in one-way push + `label:` search, ADR 0142 / migration `063`). Safe against ADR 0107 for one reason: a `Chord/<name>` tag has exactly **one writer**.

> **✉️ Email signals + reading the message: [`email-sender-signals-plan.md`](./email-sender-signals-plan.md).** Started as “why isn’t this newsletter classified as one?” and turned into: the AI passes were never shown the email — ~78 characters of real text on the mail that was failing, and bodies stored for 47 of 2,718 messages. Eleven pieces; 1-3 and 6-11 shipped (ADRs 0106, 0109, 0110), 4-5 open. Governing rule throughout: a sender-derived signal is a **signal, never a verdict** — nothing acts on it alone, and `action IN (to_do, reply_needed)` overrides it everywhere.

> **🔐 Key and secret custody: [`phase-8-key-custody.md`](./phase-8-key-custody.md).** Planned, not started. After content encryption (ADR 0201) and the Cloud SQL move (ADR 0202): `MASTER_KEY` behind KMS, third-party secrets in Secret Manager, infrastructure keys, and a least-privilege service account for the VM.

> **⭐ Active focus: [`demo-tasks.md`](./demo-tasks.md).** Categorises the four reference docs, maps each category to today's code, and defines the four demo "pillars" that carry the investment narrative. The Phase 4 bullets below are prerequisites that fold into those pillars — don't work them in isolation. The investor-demo narrative + open design questions live in [`../plans/demo-plans.md`](../plans/demo-plans.md).
>
> Scope rule: the LLM is the only real external call. Chat is in-app; other integrations can be mocked when it helps the story.

## Phase 4 follow-through

Derived from the accepted ADRs 0004–0007. Identity, retrieval, and the
iterative native-tools loop (ADR 0005) have all shipped; what remains under
this phase is small cleanup work.

### Context + identity (ADR 0004 + 0007)

- [x] **Thread `triggeringUserId` through the bot turn.** `bot.service.ts` now passes it through to context building and retrieval. (ADR 0007)
- [x] **Add identity block to the system prompt.** The system prompt now includes the triggering user's display name, username, and id. (ADR 0007)
- [x] **Replace raw attachment injection with permission-aware selection.** Retrieval now considers the triggering user's visible docs and handles adults-only guest restrictions. (ADR 0004 / 0006)

### Retrieval (ADR 0006 → ADR 0021)

- [x] **`selectAttachmentsForTurn(...)` helper** in `services/bot/retrieval.ts`. Returns up to 12 visible attachments using the keyword-score formula.
- [x] Wire the helper into `buildLlmContext` in place of the old raw attachment selection.
- [x] Fallback to "pinned + recent" when keyword extraction yields nothing.
- [x] Unit tests for the scorer (`server/src/services/bot/__tests__/retrieval.test.ts`) — covers `extractKeywords` + `scoreRow` (pinned, recency, filename vs. summary weights). Runs via `npm test`.
- [x] **FTS5 chunk index (ADR 0021)** — paragraph-level BM25 retrieval over `extracted_text` + OCR + summary. Replaces the front-of-file content dump with `«match»`-marked paragraph excerpts. ~4× token-cost reduction on long-file turns. Tests in `fts-retrieval.integration.test.ts`.

### Iterative tool use (ADR 0005)

- [x] **Extend `LlmService` interface** to yield typed chunks (`text` / `tool_call` / `done`). Providers also advertise `supportsNativeTools`.
- [x] **OpenAI path** — emits `tools` param from the registry, reassembles streaming `tool_calls.arguments` fragments, yields one `tool_call` chunk per complete call.
- [x] **Gemini path** — `functionDeclarations` + `functionCall` / `functionResponse` parts. Native tool-calling shipped 2026-05-01; `gemini.service.ts` advertises `supportsNativeTools=true` and yields `tool_call` chunks from streamed `functionCalls()`.
- [x] **Mock path** — stays on text-fence (ADR 0003); emits no tool_call chunks.
- [x] **Tool loop in `bot.service.ts`** — up to `MAX_ITERATIONS` (6), appends assistant-with-tool_calls + tool-role messages, loops until the model stops asking for tools.
- [x] **Read-side tools**: `list_tasks`, `search_saves`, `lookup_contact`, `get_event_status`, and the umbrella `search` (ADR 0059 — one full-text sweep across chats, files, tasks, reminders, saves, events, lists, places, contacts, media; cross-group from the personal chat, this-group in shared groups). Registered in the zod registry; executor cases return structured `data` that the native loop serializes into the tool-role message. Native-only (text-fence providers can't round-trip) — deliberately omitted from `TEXT_FENCE_TOOL_PROMPT`.
- [x] **SSE `bot.tool`** — broadcast per successful / failed call in both protocol paths.
- [x] **Prompt split** — `NATIVE_TOOL_PROMPT` for native-tool providers (no JSON-fence instructions) vs. `TEXT_FENCE_TOOL_PROMPT` for fallback providers.

### Sequencing

(Historical — kept for context.) Done in this order: identity → retrieval → iterative tools. Each landed as a self-contained commit; the iterative-tools rewrite was the largest. Test coverage of the loop lives at `server/src/services/bot/__tests__/iterative-loop.integration.test.ts`.

## Known gaps (shipped but incomplete)

### Bot
- [x] **File-bubble rendering.** Messages with `attachmentId` render a MIME-icon card with filename, size, and optional summary. On web the card is a tap-to-download link; native native-download wiring is still TODO.
- [x] **Re-run extraction on boot** for `attachments` rows with `indexed_at IS NULL` (interrupted uploads). Done — `requeuePendingExtractions(db)` runs at boot (`server/src/server.ts`, background, age-gated to avoid racing in-flight uploads) and only retries rows that requested indexing. Tested in `server/src/services/__tests__/extraction-recovery.integration.test.ts`.

### Groups
- [ ] `DELETE /groups/:id` + leave-group endpoint.
- [ ] Role changes (owner → member).
- [ ] Invite-code regeneration.

### Resources
- [ ] Delete / edit UI for tasks, list items, saves beyond toggle.
- [x] RSVP view on mobile — per-event list of pills (name · status · dish) plus an inline add-RSVP form; fed by `listRsvps` at refresh time.
- [x] Events creatable from the mobile UI directly (Resources → Events composer). Still no native date picker; parseable free-form string (e.g. `2026-05-01 18:30`).
- [ ] Date / time picker for task `dueAt`.
- [x] Live SSE wiring on the Resources screen — it now refreshes on task/list/save/event/trip changes. Follow-up if we want per-entity in-memory updates instead of refetch.

### Ops
- [ ] Production build path — rsync `kernel/` into `server/src/_kernel/` so `dist/` doesn't leak kernel source tree. See `docs/ops/kernel-path.md`.
- [ ] Deploy helper script for the rsync-to-VM flow (we deploy by rsyncing to the live VM, not Docker).

## Phase A — WhatsApp chat-export import (ADR 0008)

Bootstraps a demo group from a real WhatsApp `.zip` export. Parses
`_chat.txt`, copies media, runs windowed LLM extraction over 200-message
windows, and replays the results through the existing bot tool
executor. Each extracted entity gets `source_raw_context` for a "Why
this?" drill-down later.

- [x] New deps: `adm-zip` (runtime) + `@types/adm-zip` (dev).
- [x] Schema: `users.shadow`, `messages.source`, and `source_raw_context` on `tasks`, `trips`, `travel_legs`, `accommodations`, `saves`, `events` (migration `007_whatsapp_import`).
- [x] `server/src/services/ingest/whatsapp/parse.ts` — chat parser (port of `john-app/src/ingest/parse.ts`).
- [x] `server/src/services/ingest/whatsapp/unzip.ts` — extract zip, plus `media.ts` for filename-prefix classification.
- [x] `server/src/services/ingest/whatsapp/pipeline.ts` — orchestrator: create group, resolve personas → users (shadow or reuse), insert messages (backdated, `source='import'`), copy media (extraction suppressed).
- [x] `server/src/services/ingest/whatsapp/extract.ts` — windowed extraction (200/20) that returns chord-tool-registry calls, validated against the zod schemas, paired with formatted window text as provenance.
- [x] Refactor `server/src/services/bot/executor.ts` — `applyToolCall(db, { groupId, actorUserId, call, provenance })` now the primary entry; `executeTool` kept as a thin alias for the bot path.
- [x] `POST /api/v1/ingest/whatsapp` — route returns immediately after structural ingest; extraction runs async in the background and broadcasts `ingest.progress` / `ingest.done` SSE events on the group channel. Mobile chat screen renders a live banner.
- [x] Mock provider extraction path: detects `EXTRACTION_MARKER`, returns a JSON call list via regex (remind-me → task, costco+items → list, URL → save_link, "dinner at X" → save_place). Flight/hotel cases still pending.
- [x] Unit tests: parser (date formats, multi-line, attachment detection), classifier, unzip round-trip, pipeline integration, executor (actor + provenance).
- [x] Seed fixture: `server/fixtures/whatsapp-doe-family.zip` (generated by `npm run fixture:whatsapp --workspace=server` from `src/scripts/build-whatsapp-fixture.ts`). Exercises every mock-extraction pattern.
- [x] Mobile "📥 Import chat" button on the groups list — opens the document picker, POSTs to `/ingest/whatsapp`, navigates to the new group.
- [x] Provenance drill-down (`ⓘ`) on Task, Trip, Save, Event rows in Resources. Trip, TravelLeg, Accommodation, Save, Event kernel types all now expose `sourceRawContext?: string`.

## Phase B — Per-file structured extraction (deferred, follows Phase A)

For every uploaded PDF/DOCX/image, run a second extraction pass that
returns tool-call suggestions (`add_travel_leg`, `save_contact`,
`create_event`). Surface as a "Review suggestions" card in chat instead
of auto-applying. Adds DOCX (mammoth) + XLSX (xlsx) + vision for
images. Stores `source_attachment_id + source_page/line` on created
entities for provenance drill-down.

## Phase C — Demo polish (can run parallel with A)

- [ ] Source badges on bot replies: `bot.sources` event is emitted but not rendered; show filename chips under the bot bubble with tap-to-open.
- [ ] Extraction-recovery on boot: requeue any `attachments.indexed_at IS NULL` older than 60s. (Already listed under "Known gaps" above; promoted here so Phase A inherits retry semantics.)
- [x] "Why this entity?" provenance drill-down — `ProvenanceCtx` + bottom-sheet `ProvenanceModal` in `mobile/app/groups/[id]/resources.tsx`. Wired on Task, Trip, Save, Event rows. Uses `source_raw_context` plumbed through all relevant kernel types.
- [x] JSON-repair helper ported from `john-app/src/extract/llm.ts` — lives at `server/src/utils/json-repair.ts` (fence stripping, balanced extraction, trailing-comma fix, truncation repair). Wired into `extract.ts`'s `parseJsonLoose`. Unit-tested.
- [x] Dedup across overlapping extraction windows via natural-key `Set<string>` in the pipeline's `applyCallsSafe`. Covers tasks, trips, legs, accommodations, saves, events, places, media, contacts.
- [x] Shadow-user indicator on chat bubbles — `📥 imported` chip next to the sender name; kernel `GroupMember.shadow` enriched by `/groups/:id/members`, fetched in the chat screen and passed into each `Bubble`.

## After Phase 4

- **Admin UI in `client/`.** Vite + React. Read-only views of users / groups / attachments / tool-call history. Live-tail of logs. Inspect Postgres rows.
- **Reminder scheduler hardening.** Basic firing exists now; follow-up work is exact-once delivery, better UX, and cleanup of queued reminders.
- **Push notifications** (Expo Notifications) for mentions, reminders.
- **Private user-scope attachment upload UI.** Endpoint needed: `POST /users/me/files`.
- **[IM connectors (Slack / Discord / Telegram)](./im-connectors.md).** Let the bot join external channels. Design in [`../subsystems/connectors.md`](../subsystems/connectors.md), rationale in [ADR 0010](../notes/0010-im-connectors.md). Lifts ~70% of the connector code from `webapp-start`; Telegram is fresh. Parallel track to the investor-demo polish, not on its critical path.

## Open questions (deferred)

### D1 — Silent background extraction
- **Decision (2026-04-17)**: not for now. Bot stays silent unless `@Chord` is mentioned (personal groups always get a reply). Flow 4's "silently track RSVPs from ambient replies" is de-scoped; Chord tracks RSVPs via explicit `@Chord` requests or via the `record_rsvp` tool when someone addresses the bot. Revisit when we have clearer signal on false-positive tolerance.

### D7 — Tool set completeness
- Deferred — waiting on the document from the colleague that scopes the exact feature asks. `update_task` shipped 2026-09-05 (ADR 0149 lane; reschedule / rename / reassign / set-clear reminder, shares ADR 0093's per-turn mutation budget with `complete_task`). Still open: `check_list_item` / `delete_*` list tooling, standalone reminder tooling, read-side helpers (see Phase 4 above — partial answer).

### D8 — Consensus before commit
- Raised 2026-04-23. Full plan in [`consensus-before-commit.md`](./consensus-before-commit.md). Pre-condition: ADR 0009. Partially revisits the D1 decision.

### D9 — Buttons on the in-window WhatsApp briefing
- Parked 2026-08-21, after ADR 0091. A quick-reply tap is a user message to
  Meta, and `handleInbound` already stamps `last_inbound_at` on any inbound
  including taps — so buttons on the **in-window** briefing would mean one tap
  a day keeps the 24h window open indefinitely: no template send, no billed
  conversation, and the full briefing instead of five slots. In-window buttons
  need no template on Meta (`sendButtons` is free-form).
- **The cost:** buttons switch the send to `type: 'interactive'`, whose body cap
  is 1024 chars against 1600 for plain text. The briefing already exceeds both,
  so this buys the window at the price of ~576 more characters of clipping.
  Options were: buttons on the briefing (one message, harder clip), briefing
  plus a short second message carrying the buttons (full length, two
  notifications), or adaptive (buttons only when it fits under 1024).
- **Open concern:** a "thanks / helpful" button whose real job is to reopen a
  billing window is a dark pattern, and collects a signal nothing consumes.
  If this ships, the buttons should earn their place on their own — `Stop
  these` (reuses the ADR 0089 `n-` verb and finally gives in-window users the
  opt-out that today only exists on the out-of-window template), `What's on
  today?` (a normal bot turn), or `Snooze a week` (new verb). The window
  reopening should be a side effect of usefulness, not the point.
- Needs its own ADR: it changes both the cost model and the opt-out surface.

## Stretch / lowest priority

- [ ] Vector embeddings for attachment retrieval (unified retrieval layer, not in this demo).
- [ ] Email ingestion (actually receive + index forwarded docs to the group's ingest email).
- [ ] Multi-modal attachments (images via vision models).
- [ ] Calendar connect (Google OAuth → `events` sync).
- [ ] Typing indicators, read receipts, reactions.
- [ ] Real auth (OAuth / passkeys) to replace username-only sign-in.
- [ ] E2E tests (Playwright).
