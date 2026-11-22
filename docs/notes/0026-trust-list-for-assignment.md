# 0026 — Trust list for cross-user task / event assignment

**Status**: accepted
**Date**: 2026-05-11

## Context

Until now, "task" and "event" creation in a group has been open: any
member of the group can `@Chord remind <other person> to do X` and the
task lands on the recipient. The recipient has no say in whether
they're being assigned work or having things appear on their
calendar. That works for households of two; it doesn't scale to
extended-family groups where group membership doesn't imply assignment
authority (a brother-in-law in the holiday-planning group probably
shouldn't be putting tasks on my plate).

We also have a separate problem: with ADR 0015 server-side gcal
write, "wife adds dentist for John Thursday at 10am" should write to
*John's* Chord calendar in his Google account, not hers — but only
if John has consented.

## Decision

Each user maintains a **trusted senders** list — an explicit per-user
allowlist of who may write tasks / reminders / events targeting them.
Closed by default: group membership is *not* sufficient.

**Tables (migration 033):**
- `trusted_senders(id, recipient_user_id, sender_user_id, scopes,
  granted_at)` — UNIQUE (recipient, sender). `scopes` is a
  comma-separated subset of `task` and `event`. Reminders ride on
  tasks (they're a column on the tasks row) and so don't need a
  separate scope token.
- `permission_requests(id, recipient_user_id, sender_user_id,
  group_id, scopes, reason, status, requested_at, resolved_at)` —
  status is `pending` / `approved` / `denied`. On `approve` we upsert
  a `trusted_senders` row.
- `events.assignee_id` (new column) — mirrors `tasks.assignee_id`,
  which already exists. When set, the event belongs to that user
  (e.g. for gcal-write routing).

**Service surface (`services/trust.service.ts`):**
- `isTrusted(db, recipient, sender, scope)` — `true` for self,
  otherwise reads the row.
- `setGrant(db, recipient, sender, scopes)` — upsert; empty scopes
  revokes.
- `requestPermission(db, opts)` — opens or merges a pending request.
- `respondToRequest(db, opts)` — approve/deny; approve upserts the
  trust grant.
- `TrustError` — thrown by `createTask` / `createEvent` when the
  sender is not trusted. Carries `(scope, senderUserId,
  recipientUserId)` so callers can open a permission request
  themselves.

**Service-layer gate:**
- `createTask` and `createEvent` perform the trust check inside the
  service. Any caller (HTTP route, bot tool, importer) is gated.
- `pushEventCreate` (the gcal-write side) routes to `assignee_id ??
  created_by`. With the gate in place, by the time the row is in the
  DB, the trust check already succeeded — gcal-write doesn't need to
  recheck.

**Bot integration:**
- `create_task` and `create_event` zod schemas both accept
  `assigneeName`. Executor resolves to a user id, calls the service,
  and on `TrustError` automatically opens a permission request +
  returns a "permission requested" card to the user.
- The system-prompt-side description for both tools tells the LLM that
  the request flow is automatic — it should phrase the reply as "I
  asked <recipient> to allow you to add X for them."

**REST surface (mobile UI):**
- `GET /me/trust` → list of grants you've issued.
- `POST /me/trust` → upsert a grant `{ senderUserId, scopes[] }`.
- `DELETE /me/trust/:senderId` → revoke.
- `GET /me/permission-requests` → `{ incoming, outgoing }`.
- `POST /me/permission-requests/:id/respond` → `{ decision:
  'approve' | 'deny' }`.

## Alternatives considered

- **Open within shared groups.** Group membership grants implicit
  trust. Rejected — defeats the user's framing of "only those allowed
  by me." Doesn't scale past two-member households.
- **Symmetric / reciprocal grants.** Granting "wife → me" also grants
  "me → wife." Rejected — asymmetric is the more general case, and
  it's trivial to UI-prompt "do you want to allow them back?" at
  approve time. Don't bake the assumption in.
- **Per-action scopes finer than `task` / `event`.** E.g. separate
  scope for "recurring tasks" vs "one-off." Rejected as premature —
  the user's mental model is "can my wife add stuff for me," not
  "what kind of stuff." Revisit if a real need shows up.
- **Two physical rows for the "Both" placement choice** — one in the
  shared group, one in the recipient's personal group, kept in sync.
  Rejected as complexity multiplier (deletes, status changes,
  edits all need to fan out). The same UX is achievable with one row
  and a "for me" filter that includes `assignee_id = :me`. The query
  in `listTasksForUser` already does the right thing.

## Consequences

- **Existing flows are unchanged when assignment isn't used.** A
  user creating a task or event for themselves (no `assigneeName`)
  hits no new code path.
- **`TrustError` becomes a known error class** that routes / executors
  must handle. The bot path handles it (opens request automatically);
  HTTP routes for tasks / events should map it to 403 with a
  structured body if/when they support assignment from the API. Today
  the routes don't take `assigneeId`, so no route change needed.
- **No mobile UI yet.** Phase B will build the friends-and-permissions
  screen reading these endpoints. Until then, grants can be issued by
  hitting the API directly or — once we add it — via a bot tool like
  `@Chord allow my wife to add tasks for me`.
- **gcal write routing on assignee** means the recipient must have
  granted Chord calendar-write scope. If they haven't,
  `pushEventCreate` marks the row `skipped` (existing behavior). The
  sender sees "scheduled in Chord; <recipient> hasn't connected
  their calendar yet" — surfaceable via the task/event card meta.
