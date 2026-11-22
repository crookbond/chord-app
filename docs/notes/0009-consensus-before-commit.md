# 0009 — Consensus-before-commit for bot-proposed writes

**Status**: accepted — sign-off on 2026-04-23 on all three open points (recommendations unchanged)
**Date**: 2026-04-23
**Covers**: D8 (see `docs/tasks/README.md`), full plan in [`../tasks/consensus-before-commit.md`](../tasks/consensus-before-commit.md)
**Relation**: extends [0003](./0003-text-based-tool-protocol.md) and [0005](./0005-iterative-tool-use.md) (tool-execution model); partially revisits the D1 decision (2026-04-17) that silent background extraction is out-of-scope — we are not re-introducing silent extraction, but we are adding a *visible* staging layer in front of every bot write.

## Context

Today every successful bot tool call writes to the DB synchronously. Tracing a `create_task` call: the LLM emits `tool_calls` → `executor.ts` `applyToolCall` → `tasks.service.ts` insert → SSE `task.created` — all in one tick. There is no tentative state; tasks, lists, events, trips, saves, memories, contacts, places all exist in a single "created" state.

Two failure modes this produces:

1. **Discussion churn.** When a group is negotiating (revising a Costco list across six messages, arguing about potluck dishes, debating trip dates), each `@Chord`-mentioned turn writes a new entity or edits an existing one. The chat feels noisy and the Resources tab fills with near-duplicates.
2. **Invisible memory extraction.** The 2026-04-23 commit made `extraction.ts` open-vocabulary: the LLM can now invent arbitrary `snake_case` keys and persist them at `confidence >= 0.6` with no user visibility. This directly reverses a guardrail the previous code called out in a comment ("keeping the set small + typed stops the LLM from inventing keys that fragment the Memory tab") without an ADR. For a demo the unpredictability is the scariest behavior on show.

The goal is a third mode between "fire on every `@Chord`" and "D1 — don't react at all": **the bot records what it thinks the group wants, and waits for explicit consensus before committing the entity.**

## Decision

Introduce a **staging layer** in front of every bot-initiated DB write. Eight concrete choices:

### 1. Storage shape — shared `proposals` table + per-entity status column for memories only

A single `proposals` table holds pending tool calls as serialized JSON args, keyed by `(group_id, tool_name, args_fingerprint)`. Confirming a proposal re-validates the stored call against the zod registry and dispatches it through the existing `applyToolCall` in commit mode. Rejecting it flips status without writing.

**Exception**: `memories` gets a `status: 'proposed' | 'confirmed'` column on the row itself, not a shared-table entry. Memories already have a specific UI surface (`MemoriesSection` in `resources.tsx`), `supersededBy` lifecycle, and a `source` field — treating them uniformly with "one-shot" entities would fight that existing shape. See point 6 for why memories ship first anyway.

Shape of the `proposals` table:

```
id                       TEXT PRIMARY KEY
group_id                 TEXT NOT NULL
proposed_by_user_id      TEXT       -- null if extracted post-turn with no clear author
proposed_by_message_id   TEXT       -- triggering chat message
tool_name                TEXT NOT NULL
args_json                TEXT NOT NULL     -- re-validated against toolSchemas on commit
provenance               TEXT              -- raw context, mirrors existing source_raw_context
status                   TEXT NOT NULL     -- 'pending' | 'confirmed' | 'rejected' | 'expired'
resolved_by_user_id      TEXT
resolved_by_message_id   TEXT
resolved_at              TEXT
bundle_id                TEXT              -- null for standalone; same value across a trip bundle
expires_at               TEXT NOT NULL
created_at               TEXT NOT NULL
```

**Bundle semantics.** An ingested flight PDF typically produces `create_trip` + `add_travel_leg` + `add_accommodation` + `add_reservation`. These share a `bundle_id` and confirm / reject atomically. Without this, users have to tap four buttons to approve one flight confirmation.

### 2. Approval verbs — buttons + `@Chord confirm` / `@Chord drop`; no reactions in v1

Inline Approve / Reject buttons on the bot bubble that surfaced the proposal, plus natural-language `@Chord confirm [ref]?` / `@Chord drop [ref]?` that dispatches without consuming an LLM turn. Short-form `@Chord confirm` with no ref resolves the most recent pending proposal in that group. Ambiguous "@Chord yes" / "@Chord no" is deferred (needs an LLM resolution pass — Phase 5 follow-up).

Emoji reactions (✅ / ❌) are a plausible third input but require new infrastructure (no reaction table exists today). Skip for v1.

### 3. Quorum — first-confirmer-wins

Any member of the group can confirm or reject. First action wins and is recorded on the proposal row. No N-of-M voting; that adds UX surface without serving the demo. The "why" is visible in every committed entity's provenance (proposed by X at message M, confirmed by Y at message N).

### 4. TTL — 24h default, visible expiry indicator

Pending proposals display a relative "expires in 22h" hint. A lazy sweep on `GET /groups/:id/proposals` flips expired rows before returning; a nightly cron handles the passive case. Expired proposals are visible in the audit view (Phase 7) but do not appear in the proposal tray.

24h is a compromise between "users need time to reach consensus" and "a proposal from three days ago is stale and probably misleading." Not exposed in UI.

**Update (2026-07-16): default raised to 72h.** The daily briefing now carries a
"Waiting on your OK" section listing pending proposals, which changes the
staleness math: at 24h a proposal staged after the morning briefing got at most
one shot at being seen, and often zero. 72h gives every proposal up to three
briefing appearances before it quietly expires. The staleness concern the 24h
chose against is mitigated by that recurring visibility (and the expiry hint
still shows the age). Correction to the original text: the TTL was never an
env var — it is the `DEFAULT_TTL_MS` constant in `proposals.service.ts`
(callers can pass `ttlMs` per proposal); keeping it a constant is deliberate,
one less knob.

### 5. Ingest mode — auto-commit, with a post-import review affordance

WhatsApp import (`services/ingest/whatsapp/pipeline.ts`) already treats the upload as bulk opt-in consent; forcing users to approve every entity extracted from a 2000-message chat would defeat the whole ingest moment. Keep auto-commit.

Add a "Recently imported" filter on the Resources screen (scoped to entities whose `source_raw_context` originated from `source='import'` within the last hour / current session) so users can quickly review and delete outliers. This reuses the existing DELETE routes and needs no new schema.

### 6. Scope — all bot-writable entities, shipped in this order

Incremental rollout so each entity validates the pattern before the next:

1. **Memories first.** Highest trust payoff (post-2026-04-23 commit this is where the user visibility is worst), simplest structural change (single `status` column), existing UI section to extend.
2. **Tasks.** Most visible demo artifact. Proves the shared `proposals` table + inline bubble buttons.
3. **Lists, events, saves.** Mechanical rollout; one tool each.
4. **Trip bundle** (`create_trip` + legs + accommodations + reservations). Proves `bundle_id` atomic commit.
5. **Contacts, places, media.** Lowest demo stakes, do last.

### 7. Commit behavior — always propose; no phrase-based directive bypass

**Every bot-initiated write is a proposal.** Even a clear imperative like "@Chord add milk to the Costco list" writes a proposal, not the list item. Confirmation is a one-message response ("@Chord confirm" or a single button tap).

We considered the alternatives (see below) and chose "always propose" because:

- The classifier needed to reliably distinguish "directive" from "discussion" is itself non-trivial (Phase 6 work). Shipping a feature whose correctness depends on that classifier adds demo risk, not trust.
- The cost of the strict rule is one extra tap or one extra message per write. The benefit is that the user's mental model is simple: *the bot never writes on its own*.
- If the classifier lands later, this ADR doesn't need to change — we just flip the default for classified-as-directive triggers to commit-mode in the executor.

### 8. Provenance — bidirectional link

Every proposal carries `proposed_by_message_id` and `provenance` (the raw chat / PDF excerpt, mirroring `source_raw_context`). Every committed entity gets its source proposal's id recorded; the "Why this entity?" drill-down (existing `ProvenanceModal` in `resources.tsx`) surfaces both the triggering message and the confirming user / message.

## Alternatives considered

- **Per-entity `status` column on every table (rejected).** Symmetric with memories' approach but doesn't express bundle atomicity (trip + 3 children), fragments the pending list across N tables (every Resources query needs a `WHERE status = 'confirmed'`), and duplicates the expiry / resolution fields N times. Shared table wins everywhere except memories, where the column approach is simpler because the lifecycle (`supersededBy`) is already leaf-shaped.
- **Reuse `bot.share.offer` flow for proposals (rejected).** Tempting because the shape is similar (accept / reject an offered action) but share offers are attachment-specific: they grant permissions to an existing row rather than creating one. Extending them to generic tool calls would force a mix of concerns; a dedicated `proposals` table is cleaner.
- **Directive-bypass classifier (deferred to Phase 6).** Classify each trigger as `directive | discussion | ambient` and skip the proposal gate on directives. Higher-fidelity UX, but the classifier is the hard part and its wrong answers are worse than the strict rule's minor friction. Leave the door open: Phase 6 can add this without changing the ADR.
- **Explicit "commit immediately" phrasing (rejected).** Options like `@Chord do: create task X` to bypass the gate. Makes the bot's behavior depend on prompt tricks the user has to remember; fails the "simple mental model" bar set in decision #7. Not worth the escape hatch.
- **Propose-only for write tools, commit for read tools (trivially true but worth naming).** `list_tasks`, `search_saves`, `lookup_contact`, `get_trip_status` are read-only — they do not touch the DB and therefore do not go through proposals. Unchanged.

## Consequences

- **Schema**: one new migration adding the `proposals` table; one migration adding `status` to `memories`. Existing tables unchanged.
- **Kernel**: `Proposal` type + zod schemas; `SSE.proposalCreated`, `SSE.proposalResolved`, `SSE.memoryProposed`, `SSE.memoryResolved`; new API constants for `/api/v1/proposals/:id/confirm`, `/reject`, `/api/v1/groups/:id/proposals`.
- **Executor refactor**: `applyToolCall` gains a `mode: 'propose' | 'commit'` parameter. Propose mode writes a proposal row + broadcasts instead of calling the service; commit mode is unchanged. WhatsApp ingest always passes `mode: 'commit'` (decision #5). Bot paths always pass `mode: 'propose'` for write tools; read tools unaffected.
- **SSE volume**: during a discussion, the bot emits proposal events per turn rather than entity events. Volume is comparable; shape differs. Mobile's SSE handlers gain `proposal.*` cases.
- **Retrieval**: the bot's context builder (`context.ts`) should surface recent **pending** proposals to the LLM so the model can reference them ("you proposed adding milk 3 minutes ago") without duplicating the request. Roughly: last N pending proposals in the group appended to the system prompt, similar to the memory block.
- **Demo narrative**: the demo script changes shape. Instead of "watch the bot create a task," it's "watch the bot propose a task and a group member confirm." This is the intended feature — the consent loop IS the story — but demo rehearsals will feel slower. Worth a demo-script revision alongside the ship.
- **Docs**: update `docs/subsystems/bot.md` to document propose/commit modes. Update ADR 0003 + 0005 status notes to reference 0009.
- **Audit surface**: the `proposals` table itself is an audit log. Keeps rejected / expired rows; useful for "what did the bot want to do yesterday" debugging and (Phase 7) a Resources audit view.
- **Ingest auto-commit asymmetry**: worth explicit docs. A user who sees "every bot write is proposed" and then imports a chat producing 50 committed entities without approval will be confused. The "Recently imported" filter is the mitigation; also add a one-line post-import banner ("Imported 50 entities — review in Resources").

---

## Open points — sign-off needed

These three decisions I resolved with a recommendation but want explicit confirmation before implementation starts. The rest I'm committed to unless pushed back on.

1. **Decision #7 — always propose, no directive-bypass.** Confirms that even imperative phrasings produce a proposal + 1-tap confirm rather than committing. The alternative (phrase-heuristic or classifier) is lower-friction but risks false directives committing without review.
2. **Decision #1 — shared `proposals` table everywhere, `status` column for memories only.** This asymmetry is deliberate but will look odd to a future reader. Confirm it's acceptable, or push for uniformity (all shared table, or all per-entity columns) with the associated trade-offs.
3. **Decision #5 — ingest auto-commits.** Confirms WhatsApp import bypasses the proposal gate. Alternative is a post-import "review tray" where every extracted entity starts as pending; more consistent but dramatically slows the import demo moment.

Mark this ADR `accepted` once the three points are signed off; at that point the ADR 0003 / 0005 status headers should also be updated to reference 0009.
