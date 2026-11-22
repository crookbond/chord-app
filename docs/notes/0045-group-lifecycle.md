# 0045 — Group lifecycle: delete, leave, invite regeneration

**Status**: accepted
**Date**: 2026-06-05
**Relates to**: [ADR 0037 — File management + delete](./0037-file-management-and-delete.md), [ADR 0043 — Account deletion](./0043-account-deletion.md), [ADR 0002 — SSE over WebSockets](./0002-sse-over-websockets.md)

## Context

Groups could be created and joined, but never **deleted**, **left**, or have
their **invite code rotated**. A user who created a group by mistake, or joined
one they no longer want, had no exit; a leaked invite code could not be
revoked. These are day-one expectations once real (non-demo) users exist —
ADR 0043 added account deletion, and group lifecycle is its obvious sibling.

Two things make this more than three thin endpoints:

1. **Teardown shape.** Group-scoped rows (messages, tasks, lists, events,
   members, …) fall away via `group_id … ON DELETE CASCADE`, but `attachments`
   use a polymorphic `scope_id` with no FK, so their rows, FTS chunks, and
   on-disk files must be removed explicitly — the same gap ADR 0043 hit.
2. **Owner leaving.** A group must always have an owner and a valid
   `groups.created_by`. What happens when the owner leaves a group with other
   members is a real decision, not an implementation detail.

## Decision

Three endpoints on the groups router (`requireSession`, authorization checked
inline against `group_members.role` — mirroring the existing read/patch
handlers rather than introducing a new middleware):

- **`DELETE /api/v1/groups/:id`** — owner-only. Rejected (400) for `kind =
  'personal'` (the auto-created personal chat is not user-deletable; it goes
  only via account deletion). Runs `deleteGroup`.
- **`POST /api/v1/groups/:id/leave`** — any member. Rejected (400) for personal
  chats. Runs `leaveGroup`.
- **`POST /api/v1/groups/:id/invite/regenerate`** — owner-only, non-personal.
  Replaces `groups.invite_code` with a fresh code and returns it; the old code
  stops working immediately.

**Teardown (`purgeGroup`, shared by delete + sole-member leave).** Inside one
transaction: delete every group-scoped attachment via the path-aware
`deleteAttachment` helper (ADR 0037 — drops FTS chunks, unlinks disk only when
unshared), then `DELETE FROM groups`, letting the FK cascade clear the rest. A
failure rolls the whole teardown back.

**Owner-leave → auto-transfer.** When the owner leaves a group that still has
other members, ownership transfers to the **earliest-joined remaining member**:
they are promoted to `role = 'owner'` and recorded as `groups.created_by`. This
matches the reassignment ADR 0043 already does on account deletion, so the two
paths behave identically. Rejected alternatives: (a) **block** the owner from
leaving until they hand off manually — extra friction for the common "I'm done
with this group" case; (b) **delete the group** when its owner leaves —
destroys other members' data, the same anti-goal ADR 0043 avoids.

**Sole member leaving** is equivalent to deleting the group, so `leaveGroup`
routes that case through `purgeGroup` and reports `deleted: true`.

**Stream termination.** On deletion (including sole-member leave) the server
calls `sseHub.closeChannel(id, 'group_deleted')`, emitting the existing
`stream.end` event with reason `group_deleted` so connected clients drop the
group cleanly instead of treating the closed channel as a dropped connection to
reconnect (ADR 0002). A non-sole leave does **not** close the channel — the
remaining members keep streaming; the leaving client unsubscribes locally.

## Consequences

- The attachment-cleanup duplication between `deleteGroup` and account deletion
  is deliberate: both call the same `deleteAttachment` primitive, so the
  path-aware unlink rules stay in one place.
- Invite-code rotation has a vanishingly small collision risk against the
  `UNIQUE` constraint and does not retry; acceptable at demo scale, revisit if
  it ever surfaces.
- Owner-leave silently changes who can delete/rename the group. Remaining
  members learn the new owner on their next `/members` fetch; no dedicated SSE
  event is emitted for the ownership change (kept minimal — revisit if the UI
  needs live role updates).
- Personal chats are intentionally exempt from all three operations; they are
  only removed by account deletion (ADR 0043).
