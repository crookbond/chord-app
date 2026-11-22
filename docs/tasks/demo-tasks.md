# Demo tasks

Executable build checklist for the investor demo. Not production. Not feature-complete against [`../references/`](../references/). We pick the moments that *show the investment case* and stub everything else.

The four concise references (`Chord_Spec_v4`, `Chord_Companion`, `Chord_DocPerms`, `Chord_Identity`) describe the full product. This file translates them into demo-scoped work; the narrative + open design questions live in [`../plans/demo-plans.md`](../plans/demo-plans.md).

**Status (2026-04-17):** the four demo pillars in the root [`README.md`](../../README.md) are implemented end-to-end (memory + proactive + trips + permissions/share flow). The matrices and checklists below are the original *gap analysis + build plan*; they are useful for spotting remaining polish vs the long-form references, but they are **not** a live TODO list anymore.

## Scope rule

> **Demo objective.** LLM-driven information population is the main act (extraction, memory, proactive nudges, grounded answers, the consent loop). A live Telegram bridge is the one optional encore — included if a viewer asks "where does this run?", skipped otherwise.
>
> **Only the LLM is a *required* external call.** The four pillars below run with no other real network integrations. Mocks build a believable surface; stubs are disabled affordances.
>
> - Chat is in-app by default. **Telegram** can be wired live on the spot (BotFather token + the in-app pairing flow, ADR 0010/0011) — see [`../plans/demo-plans.md`](../plans/demo-plans.md) §3 encore. WhatsApp / Slack / Discord stay post-demo (Business API, OAuth, workspace admin — too much setup ceremony).
> - Documents, flight confirmations, school calendars, family photos — **arrive via in-app file upload** as the default path. If a demo moment benefits from *looking like* an email forward or calendar sync, mock it with a seed script or a fake-ingest button; no IMAP / SMTP / OAuth.
> - Deep-link actions (Uber, Maps, Mail, etc.) render as tappable-to-toast placeholders — the *shape* is the demo.
> - Auth is username-only (as today). Identity tiers, if shown, are decorative.
>
> The rule of thumb: **if a mock makes the investor narrative clearer and takes < ½ day to build, do it.** If it takes longer, stub it with a disabled affordance.
>
> The investment story — "Chord turns the family's shared documents + chat history into a working memory and proactive agent" — lands without any real integration. The Telegram bridge is a credibility bonus, not a load-bearing demo moment.

## The four pillars

An investor demo must land these four moments. Everything else is scenery.

| # | Moment | What it proves |
|---|---|---|
| 1 | **Chord remembers your family** | Persona + group memory survives turns, feeds replies, never leaks across groups. |
| 2 | **Chord acts before you ask** | Proactive nudge fires on a scheduled trigger; LLM-evaluated task completion closes a task from an inbound message without keywords. |
| 3 | **Chord plans a trip** | Forward a flight PDF → trip entity + travel leg created; completeness card surfaces the missing return leg. |
| 4 | **Chord respects boundaries** | Upload with group picker; cross-group fallback prompt ("found in *Doe family*, share with *Seattle trip*?"). |

If we land these four, the rest (chat polish, identity tiers, deep links) is supporting detail.

## Requirements by category — current state

Check ✓ = present and demo-ready. ~ = partial / stubbed. ✗ = absent.

| Cat | Category | Today | Demo gap |
|---|---|---|---|
| A | Identity & auth (Companion A, Identity E, Spec §3) | ~ username-only demo auth; member `tier` exists for UX | Real OTP / verified identity, revocation, abuse controls — intentionally out of scope for the demo. |
| B | Personal AI chat (Companion B) | ~ personal group + same chat stack as shared groups | Companion-only affordances (rich cards everywhere, attribution UX) still lean on the shared-group path. |
| C | External chat surface (Spec §4) | ~ Telegram via the connector subsystem (ADR 0010/0011); Slack/Discord built but unused in demo; WhatsApp not implemented | **Optional demo encore.** Telegram pairs live on the spot via BotFather token + in-app pairing flow. WhatsApp/Slack/Discord stay post-demo. |
| D | Document permissions (DocPerms D, Spec §5) | ~ upload picker grants extra groups; `document_permissions` rows enforce reads; cross-group retrieval + `bot.share-offer` | Full DocPerms spec (org policies, time-bounded grants, audit UI) is not attempted. |
| E | Tasks (Spec §6) | ~ full status model + reminders + LLM completion + auto-archive + `live_until` | More task UX polish vs the long spec (dependencies, recurring tasks, richer cards). |
| F | Lists (Spec §7) | ✓ create/add/check | Typed lists (grocery / packing / todo / custom) — cosmetic. |
| G | Trips (Spec §8) | ~ trips + legs + accommodations + bot tools + PDF classifier + completeness card | Car rentals / richer itinerary modeling from Spec §8. |
| H | Saves (Spec §9) | ~ URL-in-chat → `bot.save-offer` + saves CRUD | Stronger "visited" tracking + more save sources than URL detection. |
| I | Memory (Spec §10) | ~ `memories` table + passive extraction + query injection into bot context + Resources tab | Broader extraction vocabulary + stronger provenance UI. |
| J | Deep links (Spec §11) | ✗ none | Uber / Maps / Mail / Phone link cards filled from memory. |
| K | Backend / infra (Spec §12) | SQLite, Winston, local disk, no vector store (keyword per ADR 0006) | Stays as-is. No Pinecone / Postgres / Redis for demo. |

## Priorities

### P1 — the four pillars (do these; without them the demo fails)

> **Note:** this checklist is historical. The demo pillars are shipped; use [`README.md`](../../README.md) + subsystem docs for current behavior. The bullets below are still useful as a *diff vs the long-form references*, not as release gates.

#### Pillar 1: Memory system
- [x] Migration: `memories (id, group_id, persona_id?, scope ['persona'|'group'|'event'], key, value, source ['passive'|'extracted'|'explicit'], confidence, superseded_by?, created_at)`.
- [x] `services/memory.service.ts` — `upsert`, `queryForTurn(groupId, triggeringUserId)`, `supersede`.
- [x] Bot turn post-processing — pass last-turn text to an extraction LLM call (reuse mock for demo determinism), persist high-confidence facts silently.
- [x] Inject top-N relevant memories into `buildLlmContext` (between attachment summaries and last-30 messages).
- [x] Resources screen — new **Memory** tab, read-only list with source badge.
- [x] SSE event `memory.created` so the tab updates live.

#### Pillar 2: Proactive + LLM-evaluated completion
- [x] Migration: `proactive_messages (id, group_id, persona_id?, kind, payload, scheduled_for, fired_at?)`.
- [x] `services/proactive.service.ts` — background interval (15s ticks), picks due rows, posts as bot-authored message, broadcasts SSE.
- [~] Rules: task reminders enqueue/fire from `remind_at` via `enqueueFromTask` + `proactive_messages`. **Not implemented:** birthday / trip-gap heuristics beyond tasks (Companion §B.x story is still partial).
- [x] Task `status` enum: `open|active|done|superseded|archived` (widen existing `done` boolean to column).
- [x] `completion.service.ts` — on every incoming group message, run an LLM evaluation against open tasks (mock provider gets a regex path for demos); returns `{ taskId, outcome, reason }[]`. Writes status transitions + posts one quiet confirmation.
- [x] Auto-archive cron: done ≥ 7d, overdue ≥ 7d, action_url ≥ 24h past due. Demo cadence shortened (minutes, not days) via env flag.
- [x] `live_until` column on tasks; populated from trip end-date when a trip-linked task is created.

#### Pillar 3: Trip planning
- [~] Migrations: `trips`, `trip_participants`, `travel_legs`, `accommodations`, `car_rentals` (fields from Spec §8).
- [x] Tool: `create_trip`, `add_travel_leg`, `add_accommodation`. (No `create_car_rental` for demo — accommodation + legs is enough.)
- [x] Document-extraction enhancer: when a forwarded PDF looks like a flight / hotel confirmation (classifier heuristic on extracted text), auto-invoke the right tool.
- [x] Trip Resources screen — completeness card: per-participant inbound/outbound leg check, every-night-covered check, missing-pieces list.
- [x] Bot read-tool: `get_trip_status` (feeds the completeness card narrative into chat replies).
- [x] SSE events `trip.updated`, `travel_leg.created`.

#### Pillar 4: Document permissions + fallback
- [x] Migration: `document_permissions (id, attachment_id, group_id?, user_id?, granted_by, granted_at)` — drop the single-column `scope` and move to rows.
- [x] Upload UI — bottom-sheet permission picker (Private pre-checked + list of user's groups, multi-select). Every upload, never skipped.
- [~] Multi-namespace keyword index (ADR 0006) — retrieval helper searches union of (user's private + every group the user belongs to).
- [x] Cross-group fallback — if primary group retrieval yields nothing, silently search the asking user's *own* uploads in other groups. On a hit, append a one-tap "Share with {thisGroup}?" affordance (new SSE event `bot.share-offer`).
- [x] `POST /attachments/:id/share { groupId }` — already partially listed in the old Phase 4 plan; completes here.
- [ ] Never surface existence of a restricted doc: standard "I don't have that information" response shape (DocPerms §D.5).

### P2 — supporting (do these if the pillars land early)

- [~] **URL-in-chat detection** — regex in `routes/messages.ts` detects an `http(s)` URL and broadcasts `bot.save-offer` with `{ url, title }` where **title is the hostname** (no Open Graph fetch). Clients show a one-tap save affordance. Spec §9.1 “OG tags” polish is still out.
- [~] **Deep link placeholders on tasks** — implemented on the **Resources** task row “⋯” menu (`resources.tsx` → `Alert.alert` placeholders for Uber / Maps / Mail / Phone). **Not** inline on chat “task cards”; prefill is task title, not memory-backed addresses.
- [x] **Three-tier identity badge** — simulated. Users flagged as `tier` in `group_members`; UI shows a shield icon with tier name. No actual OTP. Demonstrates the access-matrix story (Identity §E.3) without building the resolver.
- [x] **Adults-only scope** — a group with `adults_only: true` flag that Teens can't see attachments from. Pairs with tier badge.
- [x] **Rich card renderer in chat** — `bot.card` payloads render as stacked inline blocks under bot bubbles (`groups/[id]/index.tsx`); same screen for **personal and shared** groups (Companion §B.5 depth is still thinner than the long spec, but not plain-text-only).
- [x] **Source-attribution footer** — each bot turn that used retrieved attachments now broadcasts a `bot.sources` SSE; the chat renders "based on: {filename}" (up to 4, ★-marked when pinned) in muted text under the bot bubble.

### P3 — nice if trivial, cut otherwise

- [~] Typed lists (`grocery | packing | todo | custom`) — no schema column; the mobile UI infers kind from list name (regex) and renders a coloured chip on each list header.
- [x] Seed script — `npm run demo:seed` (root → `server`) runs `server/src/scripts/seed.ts` and layers a Doe-style corpus (users, groups, tasks, trips, memories, permissions, etc.). Idempotent-ish per script header.
- [ ] Voice-note mock — accept an audio upload, show a canned transcription alongside it. No Whisper call.
- [ ] Calendar file upload — upload an `.ics` file, parse client-side or server-side, create `events` rows. Replaces Google Calendar OAuth for the demo.

## What we deliberately do NOT build

Covered by the scope rule above — the LLM is the only real network integration. Everything else is either in-app or mocked:

| Area | Real? | Demo behaviour |
|---|---|---|
| WhatsApp Business API | ✗ | Not present. Not mocked either — chat is in-app. |
| OAuth / WhatsApp OTP | ✗ | Username-only auth. Tier badge is decorative. |
| Pinecone / embeddings | ✗ | Keyword retrieval per ADR 0006. |
| Postgres / Redis | ✗ | SQLite. Exit path noted in `docs/plans/`. |
| Google Calendar / CalDAV | ✗ | Mocked via `.ics` upload or seed script. |
| Email ingestion | ✗ | Optional mock: a "Paste forwarded email" form that creates an attachment as if received. |
| Uber / Expedia / OpenTable / Maps | ✗ | Deep-link placeholders with toast. |
| Push notifications | ✗ | Proactive messages appear in-app only. |
| Whisper transcription | ✗ | Optional: accept audio upload, show pre-canned transcription. |

Distinction: **mocked = we build the surface; stubbed = we show a disabled affordance.** Choose per Q1–Q11 in [`../plans/demo-plans.md`](../plans/demo-plans.md).

## Sequencing

Build in pillar order, each as a self-contained commit chain:

1. **Pillar 1 first (memory)** — every later pillar wants memory to reference.
2. **Pillar 4 (permissions)** — unblocks retrieval for the rest. Small schema change, big demo payoff.
3. **Pillar 2 (proactive + completion)** — touches task service; lands cleanly once permissions are settled.
4. **Pillar 3 (trips)** — biggest surface. Do last so memory + permissions are stable.
5. **P2 polish** — pick 2-3 that show best on stage.

Phase 4 follow-through from [`README.md`](../../README.md) is mostly about **iterative native tool-calling** at this point — identity threading + retrieval landed alongside the pillars above. Treat iterative tools ([ADR 0005](../notes/0005-iterative-tool-use.md)) as the main remaining “Phase 4” workstream.

## Open questions — see plans doc

Decisions deferred to [`../plans/demo-plans.md`](../plans/demo-plans.md):

- WhatsApp surface: full mock panel vs. just a badge on bot messages?
- Memory extraction: silent-and-always vs. opt-in-per-group?
- Trip-completeness UI: card in Resources vs. proactive DM?
- Identity tiers: show all three vs. just Verified/Guest?
- Demo seed data: canned Doe-family corpus vs. empty start?

Pick one per question before building that pillar.
