# Family-profile surface — design

**Status**: proposed (becomes an ADR when accepted)
**Date**: 2026-09-07
**Relation**: ADR 0148 sanctioned lane — the knowledge layer is the underinvested
half of the harness. Grounds the fragmented state described in the audit thread.

## Context

"Family profile" today is emergent, not built:

- **`people`** (`owner_user_id`-scoped, i.e. **personal**, not group) — `display_name`,
  free-text `notes` (`"spouse (from email)"`), `email`; plus **`important_dates`**
  (birthday / anniversary / death / other).
- **`memories`** — per-group, `persona_id` (actually a `user_id` in ADR 0076
  usage), `scope` (persona/group/event), a free-text `key`, `value`, `source`,
  `confidence`, `status` (proposed/confirmed).
- **`learnedFactsForPeople`** ties the two with a **string match**: a person's
  first name against the *value text* of the owner's confirmed persona
  memories. "Ben's school is Lincoln" attaches to person "Ben" only because
  the value contains `ben`; "his school" never attaches.
- The **People screen** (`mobile/app/people.tsx`) is a sub-screen: a flat list +
  inline add + a pending `add_person` / `add_important_date` strip.
- No household concept. No first-class non-user members (kids). No fact
  categories. No per-fact provenance. Relationship is a free-text note.

### Decisions taken with the owner (2026-09-07)

1. **Purpose: coordination facts + light memory-keeping.** Typed facts that
   drive the rest of the harness (bot context, briefing, deep-link actions),
   plus freeform notes / milestones per member. Text only — no media, no
   scrapbook.
2. **Scope: hybrid.** The personal roster stays personal (People screen). Each
   shared family group gets an **About** view — its members + the facts shared
   into that group. A private fact can be **promoted** to a group.
3. **Members: first-class personas.** A real `personas` table for managed
   non-users, linkable to a group — so a kid can later be a task assignee, show
   on the calendar, or graduate to a teen account.

## Model

### `personas` — the roster (new table)

The universal "family member" abstraction, per the v4 spec §12.2. **Every**
member of a family group is a persona row; the ones with accounts carry a
`member_id`.

```
personas(
  id, group_id,
  member_id        → group_members(id)   -- set iff this member is a user
  name,
  household_role   'parent'|'child'|'grandparent'|'caregiver'|'other'
  is_managed       0/1                    -- 1 = non-user Chord manages
  managed_by       → users(id)            -- who edits a managed persona
  birthdate        nullable
  linked_person_id → people(id)           -- optional bridge to the owner's private roster
  created_at
)
```

`group_members` stays the auth/permission truth; `personas` is the roster/profile
truth. Create-group and join auto-create a linked persona for the new member.
No clash with `bot_personas` (ADR 0027, the configurable *bot* voice).

### Facts — extend `memories`, do not add a table

A new `family_facts` table would fork the extraction, consent, and SSE plumbing
that already targets `memories` (ADR 0076 stages memory proposals; ADR 0078's
About-Me does too). That is the ADR 0148 anti-pattern. Extend instead:

```
memories +=
  subject_type   'user'|'persona'|'household'   nullable → legacy rows read as household
  subject_id     users.id | personas.id | null
  category       'health'|'school'|'contact'|'sizes'|'prefs'|'logistics'|'dates'|'note'
  provenance     'gmail:<threadId>' | 'chat:<msgId>' | 'about-me' | 'manual' | 'promoted:<origin>'
  dated_at       nullable   -- milestones, and any fact with a date
```

- Facts now join a subject on `subject_id` — `learnedFactsForPeople`'s string
  match is **retired**.
- `category` drives grouping on the surface and which consumer reads which fact.
- `provenance` is the auditability the surface needs — every fact links back to
  the email / chat / typed entry it came from. (`memories` has no provenance
  today.)
- **Dates are facts** (`category='dates'`, `value` = ISO, `dated_at` set) so the
  group profile has one fact model. The personal People screen keeps
  `important_dates` + `people` as its storage, unchanged.
- **Milestones / notes** are `category='note'` facts — freeform `value`,
  optional `dated_at`, rendered as a per-member timeline.

### Relationships — role, not a graph

Each persona carries a `household_role`; managed personas carry `managed_by`.
"Who is Ben's mom" resolves from role + `managed_by`, not a pairwise graph — no
in-law / step / divorce modeling. A `guardian_of` link is added only if a
concrete feature (emergency contact, consent) needs it.

### Visibility (the hybrid)

- **Personal roster** — People screen, your `people` + `important_dates`, private
  to you. Extraction that cannot be attributed to a shared group lands here
  (unchanged from ADR 0076).
- **Per-group About** — for each shared group: its personas + its `memories`
  facts. Everything here is visible to every group member — group-scoped data,
  so ADR 0032 holds with no new rule.
- **Promote** — a per-person / per-fact "Share with <group>" control copies a
  private row into the target group as a `memories` fact (or a `persona`),
  `source='explicit'`, `provenance='promoted:<origin>'`. One-directional; the
  group copy and the private original diverge after. Same consent shape as ADR
  0097's per-item group chip.

### One pending strip

Every extractor already stages proposals (`add_person`, `add_important_date`,
`memory` with `status='proposed'`). The profile shows **one** "Chord learned
this — confirm?" strip per subject, merging all three, resolved through the
existing proposal routes plus `PATCH /memories/:id {status:'confirmed'}`.

## Surfaces (mobile)

### Per-group "About this family" — new

Reached from the group header (next to Members / Settings).

- **Members** — cards: initials, name, `household_role`, age (from `birthdate`),
  "managed by X" for personas. Tap → member detail.
- **Household** — category-grouped facts with `subject_type='household'`: home
  address, vehicles, wifi, emergency info, school district / terms, recurring
  providers (pediatrician, dentist, plumber).
- **Member detail** — identity + role; facts grouped by category (Health /
  School / Contact / Sizes / Preferences / Logistics); dates; the milestone
  timeline; the pending strip; a per-fact **source chip** (tap → the email /
  chat it came from) + edit / delete.
- **Add** — a persona, a fact (subject + category + value), a milestone.

### People screen — keep, clean up

Stays the personal private roster. Drop the string-match; show only linked
facts. Add "Share with a group →" per person / fact (the promote seam).

## API

- `GET/POST/PATCH/DELETE /groups/:id/personas` — membership-gated.
- `GET /groups/:id/profile` → `{ personas, household: Fact[], byMember: Record<id, Fact[]>, pending: Proposal[] }`.
- `POST /groups/:id/facts`, `PATCH /facts/:id`, `DELETE /facts/:id`,
  `PATCH /facts/:id {status:'confirmed'}`.
- `POST /groups/:id/facts/promote { fromPersonId? | fromMemoryId? }`.

## How the harness consumes it

- **Bot context** (`context.ts` `memoryBlock`) — in a shared group, inject the
  group's facts grouped by subject + category, so "Ben's shoe size", "his
  teacher", "the pediatrician's number" are answerable. Personal turn → personal
  roster + own facts.
- **Briefing** — dates from `category='dates'` facts (already section 5); add
  "school term ends Friday" from household `school` facts.
- **Deep-link actions** (spec §11) — address for Uber / Maps, provider phone for
  a call, from household `logistics` / `contact` facts.
- **Extraction** — person-extraction, doc extraction, chat memory stage facts
  against `(subject, category)` instead of loose key-value.

## Migrations

1. `personas` table; backfill a linked persona per existing `group_members` row
   in group-kind groups.
2. `memories` += `subject_type`, `subject_id`, `category`, `provenance`,
   `dated_at` (nullable). Backfill: `scope='persona'` rows →
   `subject_type='user', subject_id=persona_id`; category inferred from `key`
   (`kid_school`→school, `allergy`→health, …), else `note`.
3. Retire `learnedFactsForPeople` once (2) has run.

## Rollout

- **Phase 1 — SHIPPED** (branch `family-profile-phase1`, 3 commits): the
  `personas` roster (migration 066) + subject/category/provenance columns on
  `memories` (migration 067, with the `upsertMemory` compat shim) +
  `GET /groups/:id/profile` + `POST /groups/:id/facts` + `PATCH/DELETE` on
  facts and personas + the mobile "About this family" view (read, add, delete,
  confirm the pending strip). No extractor changes.
  **Fast-follow SHIPPED**: inline editing on the screen — tap a fact to edit
  its value + category (`updateFact`), and a managed persona's card gets an
  "Edit details" form for name / role / birthday (`updatePersona`).
- **Phase 2 — SHIPPED** (branch `family-profile-phase1`, 2 commits): the chat
  memory extractor attributes a fact to a managed persona (a kid) when a name
  resolves to one; person-extraction / About-Me pass `subject_type` / category
  explicitly. The promote seam — `POST /groups/:id/personas/promote` +
  a "Share with a family group" control on the People screen.
- **Phase 3a — SHIPPED** (branch `family-profile-phase1`, 1 commit):
  `familyFactsForContext` feeds the shared household + managed-persona facts
  into the bot's turn context (`bot/context.ts`) and the morning briefing
  (`proactive.service` `FAMILY_FACTS:` block); member-private (`subject_type
  ='user'`) facts stay private.
  **Fast-follow SHIPPED**: the deep-link household-address prefill — a `map`
  `suggest_external_action` with a blank or "home" term fills `query.q` from a
  `home_address` household fact (`external-actions-enrich.ts`, ADR 0153).
- **Phase 3b — SHIPPED** (2026-09-10): kid-as-assignee / kid-on-calendar.
  `assignee_persona_id` on `tasks` / `events` (migration 074), trust indirected
  through `personas.managed_by` (`isTrustedForPersona`), a persona's calendar
  item owned by and pushed to `managed_by`'s Google calendar, title-prefixed
  `<persona> — <title>`. `create_task` / `create_event` / `update_task` resolve
  an assignee name to a member OR a managed persona (member wins a collision);
  the bot roster block lists managed personas. Design + decisions:
  [ADR 0151](../notes/0151-a-managed-persona-can-be-given-work.md).

## Rejected

- **New `family_facts` table** — forks the extraction / consent / SSE plumbing
  that already targets `memories`.
- **One cross-group household** — needs a scope concept cutting across ADR 0032;
  ambiguous when someone is in family + extended-family + co-parenting groups.
- **Pairwise relationship graph** — modeling swamp for value that
  `household_role` + `managed_by` already covers.
- **Media / scrapbook** — out of scope by owner decision; its own project
  (storage, retention, media UI).
- **Keep `learnedFactsForPeople`** — attaches a fact to anyone sharing a first
  name and misses pronoun references entirely.
