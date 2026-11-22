# 0067 — Pair groups + cross-user messaging (`message_user`)

**Status**: accepted — server core (pair groups, consent, tool, text delivery) + calendar-invite leg shipped; WhatsApp-NLU delivery is a follow-up
**Date**: 2026-07
**Relates to**: [ADR 0004 — group-scoped agent](./0004-group-scoped-agent.md), [ADR 0032 — strict per-group scope](./0032-strict-per-group-scope.md), [ADR 0065 — contact discovery](./0065-deterministic-contact-discovery.md), [ADR 0054 — push](./0054-expo-push-notifications.md), [ADR 0040 — two-way calendar](./0040-user-owned-two-way-calendar.md)
**Workstream**: Friends & Family release plan — E (the flagship)

## Context

The headline feature: from a 1:1 chat, "*text Adrian to grab coffee at 11a*"
should resolve "Adrian" (a phone contact) to a Chord user and message them on
the user's behalf. This crosses Chord's deepest invariant — **strict per-group
scope** (ADR 0004/0032): the bot may only act inside the triggering group, and
the `scrubCrossGroupLeak` post-filter drops any tool result carrying a foreign
`groupId`. Messaging *another user* from the sender's personal 1:1 looks like
exactly the cross-scope action that invariant forbids.

The prerequisites already exist: verified phone (ADR 0064), deterministic
contact discovery + the sender-scoped `resolveContactToUser` (ADR 0065), push
(ADR 0054).

## Decision

**Create scope, don't cross it.** Cross-user messages/events live in a **pair
group** — an ordinary 2-member shared group that both users belong to. Because
both are members, the group-scope scrubber is *satisfied*, not bypassed.

### Pair group = a normal group + a `pair_key`

`ensurePairGroup(db, a, b)` (`groups.service.ts`) find-or-creates the group
keyed by `pair_key = sorted(a,b).join('|')` (migration `025`, partial-unique).
It's `kind='group'` — a real shared group, so every existing read/write/scope
path treats it normally; `pair_key` only makes creation idempotent and stops a
regular 2-person group from being mistaken for one. Mirrors `ensurePersonal
Group`.

### `message_user` tool

Personal-only (`PERSONAL_ONLY_TOOL_NAMES`) — offered only in the user's own 1:1,
never in a shared-group turn. Flow (`executor.ts`):
`resolveContactToUser(sender, recipientName)` → consent check → `ensurePairGroup`
→ `postMessage` (as the sender) → `emit(pair.id, SSE.message, …)`. That broadcast
rides the existing push-publisher (ADR 0054), so the recipient is notified in-app
and by push with no new delivery code.

**Calendar invite (shipped).** The tool takes an optional `event`
(`title` / `startsAt` / optional `endsAt` / `location`). When present, after the
message is posted it calls `resolveTargetCalendarId` for the sender then
`createEvent` in the *pair group* with no `assigneeId` — so ADR 0040's fan-out
mints one owner copy per member (both people), and each copy syncs to that
person's selected Google calendar. Per-copy `eventCreated` SSE fires as usual.
The result carries `eventCreated: boolean` so the bot can confirm honestly ("sent
Adrian a note and put coffee on both your calendars"). No attendee-invite email
is sent — the shared event *is* the invite, native to both calendars.

**Returns the recipient NAME, never the pair-group id** — `{ ok, reason?,
recipient }` — so `scrubCrossGroupLeak` leaves it intact (same trick as `search`
/ `find_events`). The failure reasons (`not_found` / `ambiguous` / `blocked` /
`no_actor`) let the bot answer honestly instead of falsely claiming it sent.

### Consent: sender-initiated, recipient opt-out

A send is allowed when the recipient is a Chord user **in the sender's own
resolved contacts** (`resolveContactToUser` is strictly sender-scoped — never a
global user search) and hasn't blocked the sender. A new `blocks` table
(`blocker`, `blocked`) backs `isBlocked` / `blockUser` / `unblockUser`. This is
deliberately permissive (a family app), bounded by "must already be your
contact".

## Consequences

- The bot can now act on *another* user, but only through the one bounded seam
  (`message_user` in a personal turn → the pair group), which is itself
  group-scoped. ADR 0032's invariant holds; this is its single sanctioned
  exception, and it *adds* a scope rather than reading across two.
- A pair group shows up as a normal 2-person chat in both users' group lists.
  The client title derivation (show the *other* person's name) is a mobile
  follow-up; the stored name is currently a generic "Direct message".
- **Calendar invite (shipped):** `message_user`'s optional `event` creates a
  shared event in the pair group; ADR 0040 fan-out lands it on both people's
  calendars. See the tool section above.
- **Follow-ups (not in this slice):**
  - *WhatsApp NLU path* — parse "text Adrian…" in a WhatsApp 1:1 and call
    `message_user`; delivery to a WhatsApp-bound recipient via the connector
    (needs the ADR 0053 template approval for the closed 24h window).
  - *Block management UI* + a first-contact "X messaged you on Chord" affordance.
- Debit/tier (ADR 0063) is unaffected — the sending turn runs in the sender's
  personal group like any other.

## Alternatives considered

- **Let the bot post directly into the recipient's personal group.** Rejected —
  a straight cross-scope write, exactly what ADR 0032 forbids, with no shared
  context the recipient can reply in.
- **A dedicated DM table/channel instead of a group.** Rejected — a 2-member
  group reuses every existing primitive (messages, SSE, push, membership,
  calendar, scope). A parallel channel would fork all of them.
- **Recipient opt-in (consent before first message).** Deferred — heavier than
  a family MVP needs; the "must be your contact" gate + block is enough for F&F,
  and opt-in can layer on later without schema change.
