# 0151 — A managed persona can be given work

**Status**: accepted — built (2026-09-10)
**Date**: 2026-09-09
**Relation**: the last thread of the family-profile design doc
([`../tasks/family-profile-design.md`](../tasks/family-profile-design.md)),
split out because it is a multi-subsystem change. Extends
[0026](./0026-trust-list-for-assignment.md) (trust for assignment) and
[0040](./0040-user-owned-two-way-calendar.md) (calendar ownership). Follows the
FK-free parallel-column move Phase 2 made for `memories.subject_id`.

## Context

Family-profile Phases 1–3a gave a shared group a **roster** (`personas` —
account members plus managed non-users: kids, a grandparent, the nanny) and
made facts about those personas legible to the bot and the briefing. What a
managed persona still cannot be is the **subject of work**: you cannot put a
task on a kid's plate ("Ben — pack for camp") or an item on their calendar
("Ben — dentist Thursday 4pm").

The blocker is structural. Both `tasks.assignee_id` and `events.assignee_id`
are `text REFERENCES users(id)`, and every reader assumes a real account:

- `resolveAssignee` → `resolveGroupMember` matches only `group_members`.
- `isTrusted(recipient, sender, scope)` — a managed persona has no user id, so
  it can never be a `recipient`; `createTask` / `update_task` therefore cannot
  trust-check an assignment to one.
- `ownerOf(eventRow)` = `owner_user_id ?? assignee_id ?? created_by`, and
  `pushDirtyEvents(db, owner)` syncs *that owner's* Google calendar.
- `displayNameFor(userId)` resolves against `users`.

This is the same shape Phase 2 hit with `memories.persona_id` (a `users` FK):
the fix there was a parallel FK-free column (`subject_id`) carrying the real
identity while the legacy FK column stayed user-only. Phase 3b applies the
same move to assignment.

## Decision

### 1. A parallel `assignee_persona_id`, not a polymorphic column

Migration `NNN_persona_assignees`:

```
ALTER TABLE tasks  ADD COLUMN assignee_persona_id text REFERENCES personas(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN assignee_persona_id text REFERENCES personas(id) ON DELETE SET NULL;
```

Mutually exclusive with `assignee_id` — enforced in the service, not a CHECK
(Kysely writes both nullable, and the invite/ICS synthesis paths are easier to
reason about with a service guard). No backfill. Existing user-assignment code
is untouched; ~6 read sites gain a persona branch:

| Site | Change |
|---|---|
| `resolveAssignee` (`bot/executor.ts`) | after the member match fails, try a managed-persona name match in the group — mirrors Phase 2.1's `resolveSubject` in `bot/extraction.ts` |
| `createTask` / `updateTask` trust gate | new `isTrustedForPersona` (below) |
| `createEvent` fan-out + `ownerOf` | a persona-assigned event's owner is the persona's `managed_by` user |
| `displayNameFor` / task + event list DTOs | carry `assigneePersonaId` + the persona's `name`; render it with a small "managed" affordance |
| `update_task` tool (ADR 0149) | its reassign path accepts a persona |
| bot tool descriptions (`create_task`, `update_task`, `create_event`) | one line: a kid on the roster can be the assignee |

### 2. Trust is indirected through `managed_by`

A kid cannot consent to being given work; the adult who manages them is the
consent authority — which is exactly ADR 0026's model, one hop removed.

```ts
isTrustedForPersona(db, personaId, senderUserId, scope): Promise<boolean>
// resolve personas.managed_by; then
//   senderUserId === managed_by  → true
//   else isTrusted(db, managed_by, senderUserId, scope)
```

So "assign Ben a task" succeeds when the assigner is Ben's manager, or is
someone that manager has trusted. `createTask` / `updateTask` call this when
`assignee_persona_id` is set instead of `isTrusted`. A refusal opens an ADR
0026 permission request against `managed_by`.

### 3. A persona's calendar item lands on `managed_by`'s Google calendar

A managed persona has no Google account. The event pushes to the **`managed_by`
user's** calendar (title prefixed, e.g. `Ben — dentist`), because that is the
calendar the responsible adult actually checks. `ownerOf(row)` gains: if
`assignee_persona_id` is set → resolve `managed_by` → that user is the owner
for `pushDirtyEvents` and the ADR 0040 owner-copy. No fan-out to the persona
(there is no calendar to fan out to).

### 4. Out of scope

- A managed persona getting its own Chord account / login — the teen-account
  path, a separate effort.
- A persona as an RSVP subject, or as a `message_user` target.
- Auto-promoting a persona to a real member when a kid signs up — a later
  reconciliation, its own decision.

## Alternatives considered

- **Drop the `users` FK on `assignee_id`, make it polymorphic (`assignee_kind`
  + ref).** Bigger blast radius, and it removes a constraint that catches real
  bugs for the overwhelmingly common user-assignment case.
- **Give every managed persona a shadow `users` row** (like connector-taster
  shadows). A heavy identity object for what is a name + role + `managed_by`;
  it would leak into auth, sessions, contact discovery, `message_user`. The
  `subject_id` precedent (an FK-free parallel id) is lighter and already proven
  in this feature.
- **Chord-only events for personas, no Google push.** The responsible adult
  would not see "Ben — dentist Thursday" in the calendar they rely on.
- **Trust the assigner against the persona directly** (a `trusted_senders` row
  keyed on a persona). Invents a second trust surface; `managed_by` + the
  existing `isTrusted` already answer the question.

## Consequences

- Two nullable columns, ~6 read-site branches, one new trust helper. No change
  to how account members are assigned.
- A persona-assigned event increases the `managed_by` user's Google calendar
  footprint — acceptable; that is the point.
- `update_task`'s per-turn mutation budget (ADR 0093) and the ADR 0026
  permission-request flow both extend naturally.
- Deleting a persona `SET NULL`s its assignments — the task / event survives
  unassigned, same as deleting a user.
- Tests: assign a task to a managed persona (trusted via `managed_by`, refused
  otherwise); a persona event pushes to `managed_by`'s calendar; list DTOs
  carry the persona name; deleting the persona unassigns.

## Implementation notes (2026-09-10)

Decisions that firmed up during the build:

- **The title prefix is stored, not push-only.** `applyRemoteToLocal`
  round-trips `events.title` from Google on every pull, so a prefix added only
  in the push payload would be stripped or doubled on the next sync.
  `createEvent` writes `<persona> — <title>` into the row once, at create; the
  push and pull paths need no change. The Chord-side UI therefore shows the
  prefixed title (no separate assignee chip on the deliberately-minimal
  calendar grid, ADR 0138).
- **`ownerOf` is untouched.** `createEvent` resolves `managed_by` and writes it
  into `owner_user_id` explicitly for a persona event, so the existing
  `owner_user_id ?? assignee_id ?? created_by` precedence already returns the
  managing adult — no async change to `ownerOf` or the two-way-sync callers.
- **A dedicated `resolveAssigneeTarget` in `bot/executor.ts`**, not a widening
  of `resolveAssignee` (which has ~8 callers, most unrelated to assignment). It
  returns `{ kind: 'user' | 'persona', … }`; member match first, managed-persona
  fallback. Used by `create_task`, `create_event`, `update_task` only.
- **`isTrustedForPersona`** lives in `trust.service.ts` and does its own
  `personas.managed_by` lookup (no import of `personas.service`, no cycle). It
  returns `{ trusted, managedBy }` so a refusing caller throws
  `TrustError(scope, sender, managedBy)` and the existing executor
  permission-request path opens against the adult with no new code.
- **REST task/event routes stay user-only** in this pass — the mobile "assign"
  picker does not offer personas yet. Assign-to-persona from the UI is a
  fast-follow.
- **`groupRosterBlock`** (`bot/context.ts`) now lists managed personas under a
  "Managed family members" heading so the model knows a kid on the roster is a
  valid assignee name.
