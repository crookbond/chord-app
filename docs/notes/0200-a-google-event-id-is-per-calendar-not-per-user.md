# 0200 — A Google event id is unique per calendar, not per Chord user

**Status**: accepted
**Date**: 2026-09-23

## Context

Prod logged about 7,900 warnings a day (Sep 20–23, still going after the Sep 23
deploy), all the same shape:

```
two-way pull item failed cal=en.usa#holiday@group.v.calendar.google.com
  user=u_N5ow9zZGwsyC event=20261225_q1cjdk9utc6u8gie59mrlsh778:
  duplicate key value violates unique constraint "uq_events_gcal_event"
```

The same 29 holiday events failed about 215 times a day each, one set per
pull pass. ADR 0103's per-item catch kept the pass alive, but the items could
never land.

`uq_events_gcal_event` is `(google_calendar_id, gcal_event_id)`, which is
**global**. ADR 0040, though, gives every user their **own** row for an event
(user-owned copies), and `findLocalCopy` is correctly owner-scoped. A public
calendar (US holidays) hands every subscriber the same event ids. In prod,
`u_chK1eNNjxBn4` pulled it first and owns
`(en.usa#holiday…, 20261225_q1cjdk9utc6u8gie59mrlsh778)`. When the next
subscriber pulls, it finds no copy of its own, inserts one, and hits the
other user's row. Eleven users subscribe to that calendar, and three share
one family calendar, so the key can collide for every one of them.

The same failure was also destroying data without any log, which is worse.
`pullCalendarChanges` saved Google's `nextSyncToken` even when items had
failed. The next pull is a delta, and a delta only re-sends *changed* events,
so an unchanged event that failed once was never sent again. Two other
holiday subscribers (`u_9LXqGqu47YLA`, `u_l4hUdKDD9iqc`) hold a sync token and
**zero** holiday rows: their first pull collided and their cursor moved past
the holidays for good. `u_N5ow…` only kept failing loudly because its cursor
happened to keep re-delivering the items.

## Decision

1. **Key the Google link by owner.** Migration `089` drops
   `uq_events_gcal_event` and creates `uq_events_owner_gcal_event` on
   `(owner_user_id, google_calendar_id, gcal_event_id)`, with the same partial
   `WHERE`. One row per user per Google event is exactly ADR 0040's model.
   The index's original job (ADR 0040 contract phase) still holds: it stops
   one user's create→push→pull round trip from leaving two rows.
2. **A pass with a failed item does not advance the cursor.** Anything that
   fails is retried on the next pull, from the same token, rather than
   dropped. A permanently bad item keeps being retried and logged, which is
   the behaviour we want for something broken (it stays visible).
3. **The migration also clears `sync_token` on every Google calendar more than
   one user subscribes to**, so the users whose holidays were already lost get
   one full-window pull. That pull is idempotent: `findLocalCopy` matches rows
   that did land, and the reverse-delete (full sync only) converges what
   Google no longer has. Single-subscriber calendars keep their cursors,
   because this bug cannot have touched them.

No `findLocalCopy` change is needed. Every other lookup of a Google event id
(`findEventByGcalId`, `markPushed`, reverse-delete) is already scoped by
group, owner or row id, so nothing relied on the global uniqueness.

## Consequences

- Each subscriber gets their own copy of a public calendar's events, the same
  as any other pulled calendar. That costs 30–100 rows per user per holiday
  calendar, which is trivial.
- On a shared family calendar, an event created *outside* Chord now reaches
  every member who pulls that calendar, each with their own row, instead of
  only the first member to pull it.
- The first test of the per-item catch in `pull-resilience` had used this
  cross-user collision as its bad item. It now uses a NUL byte in the title,
  which Postgres rejects, because the collision was the bug.
- `hardenCalendarIdentity` (ADR 0040's contract-phase helper) still creates the
  old global index on a fresh DB. `089` then replaces it. Its cross-owner
  dedup `DELETE` has already run in prod and never runs again.

## Rejected

- **Sharing one row across subscribers** (e.g. the public calendar's rows
  owned by nobody). This contradicts ADR 0040's user-owned copies and ADR
  0032's scope rules: whose group does it show in, and whose "free/busy"
  does it count toward?
- **Skipping read-only/holiday calendars in the pull.** This hides the
  symptom for one calendar type. Family calendars collide the same way, and
  people do want holidays on their Chord calendar.
- **Upsert-on-conflict instead of fixing the key.** The row the conflict
  lands on belongs to *another user*, so writing to it is the cross-user leak
  ADR 0032 exists to prevent.
- **Clearing every user's sync token.** Correct but needlessly broad: it
  forces a full re-pull of every calendar when only shared ones could be
  affected.
