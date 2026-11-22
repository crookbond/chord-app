# 0040 — User-owned, two-way calendar model (UID + SEQUENCE)

**Status**: accepted — design; implementation in progress
**Date**: 2026-06-01
**Supersedes / extends**:
[ADR 0015 — Server-side Google Calendar write](./0015-server-side-google-calendar.md) (one-way → two-way; dedicated "Family" calendar → selectable),
[ADR 0024 — Event endsAt + per-leg rendering](./0024-event-ends-at-and-leg-rendering.md) (time model extended with IANA tz + the <5-min free rule),
[ADR 0030 — Group-chat calendar scope](./0030-group-calendar-scope.md) (group-scoped ownership → user-owned + `group_ids` visibility),
[ADR 0033 — Calendar busyness policy](./0033-calendar-busyness-policy.md) (per-calendar `counts_for_busy` retained; per-event transparency now also driven by the <5-min/all-day rule; **the "soft conflict" / informational-heads-up bucket is removed** — conflict detection returns ONLY block-setting calendars + Chord-native events, never informational ones)
**Related**: [ADR 0013 — ICS ingest](./0013-ics-calendar-ingest.md),
[ADR 0016 — Family graph](./0016-family-graph-in-sqlite.md),
[ADR 0028 — Calendar scope at sign-in](./0028-calendar-scope-at-signin.md),
[ADR 0038 — Postgres](./0038-sqlite-to-postgres.md)

## Context

The shipped calendar model (ADRs 0013/0015/0024/0030/0033) is a
**group-owned, Chord-authoritative, one-way-push** design:

- An event belongs to exactly one `group_id`.
- Writes go one direction (Chord → Google) into a single dedicated
  calendar named "Family"; Google-side **field** edits never flow back.
  Only deletes reconcile, via a fragile set-difference sweep guarded by
  a 2-minute grace window.
- Identity is overloaded onto `external_uid` (`gcal:<id>` /
  `gcal:<calId>:<id>` / an ICS `UID`), with no version/`sequence`, so
  Chord cannot tell which side is newer and never does a field-level
  merge.
- RSVP lives in a separate `rsvps` table keyed by `(eventId, displayName)`.

This diverges from how Google/iCalendar (RFC 5545) actually model a
calendar: events are **user-owned copies** linked across attendees by a
shared `iCalUID`, versioned by `SEQUENCE`, with invitation fan-out and
tombstoned deletes. We want to adopt that model so the calendar is
real-two-way and behaves like a calendar, not a chat artifact.

## Decision

Pivot to a **user-owned, copy-per-individual** model that mirrors the
Google event resource internally and syncs **both directions**.

### 1. Ownership: user, not group

The unit of storage is a **calendar copy** — one row per
`(owner_user_id, logical-event)`. A logical event with N attendees is N
rows, linked by a shared `ical_uid`. A user's scope is always *their own
calendar copies* (`WHERE owner_user_id = me`). This replaces the
single-`group_id` ownership of ADR 0030.

### 2. Groups become a visibility/sharing channel

`group_ids JSONB` (default `[]`) lists every group that can see a copy.
Append-only: any group gaining access is added. Display in group G =
`owner_user_id = me AND group_ids ? 'G' AND deleted_at IS NULL`. Sharing
an event to a group invites that group's members (see §5).

### 3. Standards-aligned identity + versioning

- `chord_uid` — our own globally-unique id for the logical event,
  stamped into Google via `extendedProperties.private.chordUid`. This is
  the authoritative "**we created this**" detector (replaces the
  `gcal:`-prefix sniff for loop prevention). Null for foreign-origin events.
- `ical_uid` — the RFC 5545 `UID`, identical across every copy of the
  logical event (Google's `iCalUID`). For Chord-origin events
  `ical_uid` derives from `chord_uid`.
- `sequence` — RFC 5545 revision counter. **Organizer-owned**: only the
  organizer copy bumps it on a content change; attendee copies inherit.
  Google exposes `sequence` on the event resource, so it round-trips.
- `etag` — Google's transport-level concurrency token, used for
  `If-Match` on PATCH/DELETE.

### 4. Two-way sync

Authority is split exactly as RFC 5545 / Google define it:

- **Content** (title, time, location, status) is **organizer-authoritative**
  and `SEQUENCE`-versioned. Flows organizer → attendees.
- **Response** (`response_status`, plus the Chord potluck extras
  dish/solo/notes) is **per-attendee**. Flows attendee → organizer.

Reconciliation, per copy ↔ its Google event:

- **Pull** is incremental: Google `syncToken` deltas per calendar, plus
  a **webhook watch channel** for push (replaces the throttled 5-min
  full-window poll). Apply a remote change when
  `remote.sequence > local.sequence`, or equal-sequence and
  `remote.updated > updated_at` and not `local_dirty`.
- **Push** on local edit: bump `sequence` (organizer only), set
  `local_dirty`, `updated_at = now`, PATCH with `If-Match: etag`. On
  `412` (etag mismatch) re-pull, re-merge, retry. On success store
  new `etag`/`sequence`, clear `local_dirty`.
- **Conflict** (both sides changed): **last-writer-wins by `updated_at`**
  (decision below). Log the loser.
- **Delete is symmetric and tombstoned**: a delete on either side sets
  `status='cancelled'` + `deleted_at`, then propagates. The tombstone
  prevents a stale pull from resurrecting it — this retires the
  reverse-delete set-difference sweep and its 2-minute grace hack.
  Name/time changes are ordinary content edits over the same machinery,
  symmetric in both directions.

### 5. Calendar selection + native invite

- **Right calendar, not always "Family"**: a copy stores its
  `google_calendar_id`. Resolution order on create: explicit picker
  value → group `default_calendar_id` (the *Family group* still defaults
  to the Family calendar) → user `default_calendar_id` → primary.
  Candidates are `calendar_sources` rows with `access_role ∈ {owner, writer}`.
- **Invite via native capability**: the organizer copy carries
  `attendees[]`; pushing it to Google triggers Google's invitation
  fan-out, so each invitee gets a real copy on their own calendar. Chord
  ingests those copies on the next sync and links them by `ical_uid`.

#### OAuth scope

We keep the full `https://www.googleapis.com/auth/calendar` scope
(requested at sign-in per [ADR 0028](./0028-calendar-scope-at-signin.md)).
This model no longer creates a dedicated calendar (`calendars.insert` is
gone), so that is no longer the reason for the broad scope. The reason now
is calendar **enumeration**: populating `calendar_sources` and the target
picker requires `calendarList.list`, which `calendar.events` does not
grant. The narrowest scope set that would cover this model is
`calendar.events` (event read/write) **+** `calendar.calendarlist.readonly`
(enumerate calendars); we use the single full `calendar` instead — one
consent line rather than two, and both are *restricted* scopes under the
same Google CASA verification, so splitting saves no verification work.

### 6. The <5-minute free rule

A single structural rule (`computeTransparency`) is the source of truth on
write, on read/store, and in conflict detection: **all-day → free**;
**duration < 5 min → free** (including 0-duration markers like birthdays);
**no `ends_at` → blocks** (treated as a 1-hour block, see decision 2);
otherwise blocks. Conflict detection evaluates it fresh per event, so a stale
stored `transparency` (e.g. a birthday Google sent as `opaque`) can't leak in
as a conflict. ADR 0033's per-calendar `counts_for_busy` is unchanged and still
ANDs with this to decide whether an event blocks time.

### 7. Eager internal copies + group fan-out

A group event is **fanned out at create time to one copy per current group
member** — not a single shared row. For Alice creating an event in a group
of {Alice, Bob, Carol}:

- Three rows, all sharing one `ical_uid`.
- Alice's: `role='organizer'`, `owner_user_id=Alice`, `organizer_user_id=Alice`.
- Bob's / Carol's: `role='attendee'`, `owner_user_id=Bob/Carol`,
  `organizer_user_id=Alice`.
- Each copy gets its **own** `chord_uid` (loop-prevention works per owner's
  Google), its **own** resolved target calendar (that owner's
  group→user→primary), `local_dirty=1`, and is pushed under **that owner's**
  OAuth token to **that owner's** Google. A member who hasn't connected Google
  keeps the Chord row only (push no-ops) — the eager copy degrades gracefully.

This is "eager internal copies" generalized: we don't rely on Google's
invitation fan-out (`attendees[]`) to reach members — Chord writes each
member's own standalone Google event. The cost is that Chord, not Google,
holds the copies together: there's no organizer/attendee link on Google, so
**Chord propagates organizer edits/deletes across siblings itself** (next two
sub-decisions), and RSVP lives in `event_attendees`, not Google's invite
response.

A purely personal event (the "add to *my* calendar" case, no group fan-out)
stays single-copy.

### 8. Read path: one owner-scoped primitive (group-members join retired)

With per-member copies, the old `events → group_members` join would return N
duplicate rows per logical event. So reads collapse to a **single
owner-scoped primitive** — "my copies" — and the group calendar is that same
set with a visibility filter:

```
personal calendar  →  WHERE owner_user_id = me                            (all my copies)
group calendar (G)  →  WHERE owner_user_id = me AND group_ids @> ['G']     (my copies tagged G)
```

A group calendar is therefore always rendered **as a viewer**, never as a
god-view; `/groups/:id/events` keys off `req.userId`. Because fan-out covers
every current member, "my copies tagged G" *is* the complete group calendar
from that seat — no dedup needed. This also re-expresses ADR 0032 strict
per-group scope without a special case: the bot in group G reads
`owner = me AND group_ids @> ['G']`. The filter uses `group_ids` (JSONB `@>`
containment), **not** the legacy singular `group_id` (dropped in the contract
phase; both written during expand).

### 9. Organizer-authoritative edit/delete propagation

- **Edit**: only the **organizer** copy's content edit (title/time/location)
  propagates. `updateEvent` on the organizer copy fans the patch to every
  sibling by `ical_uid`, bumps `sequence`, marks each `local_dirty`, and
  pushes each to its owner's Google. "Alice moves it → it moves for all." An
  attendee editing their own copy may only set their `response_status` (RSVP);
  they cannot move the meeting.
- **Delete**: an organizer delete tombstones + deletes **every** sibling
  (pushing each Google delete). An attendee "leave" removes only their own
  copy and marks them declined; the meeting persists for the others.

### Known limitation — late joiners (documented, not fixed)

Fan-out happens against the membership *at create time*. A member who joins
the group **after** an event was created does not retroactively receive a
copy and won't see past events. Workaround: the organizer re-shares /
re-invites. This is an accepted v1 gap, not a bug to fix now.

## Decisions locked for this ADR

1. **Conflict policy**: last-writer-wins by `updated_at`. (Not strict
   organizer-wins — simpler, and matches user expectation that the most
   recent edit sticks.)
2. **Free-rule edge cases**: all-day events and timed events shorter than
   5 minutes (including 0-duration markers like birthdays) are **free**
   (transparent). A no-`ends_at` event **blocks** — treated as a 1-hour block
   for conflict math, not free. (Revised from the original "no-end = free".)
3. **Recurrence**: deferred. Keep pulling with `singleEvents=true` (Google
   pre-expands instances) for now, but store `recurring_event_id` /
   `original_start` so instances can be grouped and upgraded to a real
   `recurrence` (RRULE/RDATE/EXDATE) representation later.
4. **Eager internal copies** for not-yet-connected invitees: yes.
5. **Viewer privacy**: a viewer-only attendee surfaced via `group_ids`
   sees **free/busy only**, not full event detail.

## Schema

`calendar_events` (one row per individual copy):

```
-- identity / versioning
id, ical_uid, chord_uid, sequence, etag
-- ownership / scope
owner_user_id, organizer_user_id, role('organizer'|'attendee'), group_ids JSONB
-- google linkage
google_calendar_id, gcal_event_id
-- content (mirrors Google event resource)
title, description, location,
starts_at, ends_at, start_tz, end_tz, all_day,
transparency('opaque'|'transparent'), status('confirmed'|'tentative'|'cancelled'),
response_status
-- recurrence (deferred)
recurrence JSONB, recurring_event_id, original_start
-- two-way sync state
local_dirty, gcal_sync_status, gcal_synced_at, gcal_last_error, deleted_at
-- audit
created_by, created_at, updated_at
UNIQUE(owner_user_id, ical_uid); UNIQUE(google_calendar_id, gcal_event_id)
```

`event_attendees` (RSVP successor + invitation list):

```
id, ical_uid, user_id, email, display_name,
role('viewer'|'editor'), response_status, is_organizer,
solo, dish, notes,   -- retained Chord potluck extras
updated_at
UNIQUE(ical_uid, email)
```

Supporting columns: `groups.default_calendar_id`,
`users.default_calendar_id` + `users.default_invite_calendar_id`,
`calendar_sources.is_default_write`, `calendar_sources.sync_token`
(per-calendar incremental-pull cursor).

## Migration (delta from today)

- `events.group_id` (single, NOT NULL) → `group_ids JSONB`; backfill
  `['<old group>']`.
- Add `owner_user_id` (backfill from `created_by` / personal-group owner),
  `organizer_user_id`, `role`, `sequence`, `ical_uid` (backfill from
  `external_uid`), `chord_uid`, `etag`, `start_tz`/`end_tz`, `all_day`,
  `status`, `response_status`, `local_dirty`, `updated_at`, `deleted_at`.
- `rsvps` → `event_attendees` (+`role`, `response_status`, `is_organizer`;
  keep `solo`/`dish`/`notes`; rekey on `ical_uid`+`email`).
- Retire `external_uid` overloading — its three jobs split across
  `ical_uid` / `chord_uid` / `google_calendar_id`.
- Per ADR 0038 conventions: booleans stored as `integer 0/1`; compare
  with `= 1`, never `IS TRUE`. `group_ids` is `jsonb`.

## Alternatives considered

- **Keep one-way push (status quo, ADR 0015).** Rejected: the product
  now needs Google-side edits and deletes to flow back, and invitations
  to fan out — none of which one-way supports.
- **Single shared event row + embedded attendees (no per-user copies).**
  Rejected: makes "scope is always my own calendar" and per-copy
  two-way sync awkward, and doesn't match Google's invitation model
  (each attendee genuinely has their own event resource with its own id).
- **Strict organizer-wins conflict policy.** Rejected in favour of LWW
  by `updated_at` (decision 1) — simpler and matches user expectation.
- **Full recurrence model now.** Deferred (decision 3) — `singleEvents`
  expansion covers the common cases; the columns are reserved.

## Consequences

- Real two-way sync: edits/deletes/renames reconcile both directions;
  the brittle reverse-delete grace window goes away (tombstones replace it).
- Loop prevention becomes explicit via `chord_uid` instead of sniffing
  an `external_uid` prefix.
- Larger write surface: webhook channel lifecycle, syncToken bookkeeping,
  etag concurrency, and the LWW merge all need care and tests.
- Group-scope reads (ADR 0032) still apply on top of the new
  `group_ids`/`owner_user_id` model — both filters compose.
- ADR 0033's busyness layer is preserved; transparency now has a second
  driver (the <5-min rule) in addition to Google's value.
```

## Addendum 2026-10-23 — fan-out copies after they reach Google

A code read found three ways the copies of a group event (§7) stopped
being one event once they were pushed. Not reproduced live; each has a
reproducing test in `fanout-copy-identity.integration.test.ts`.

1. **`ical_uid` is Chord's key and the provider never replaces it.**
   `markPushed` wrote Google's iCalUID over `ical_uid` on every push, and
   the pull did the same for our own events. Each member's copy is a
   different Google event with a different iCalUID, so after the first
   push the copies no longer shared a key: `dedupeByIcalUid` showed the
   bot the event once per member, an organizer edit or delete reached only
   the organizer's copy (§9), and the guest list (`event_attendees`, keyed
   on `ical_uid`, ADR 0157) was lost for later pushes. Now Google's iCalUID
   only fills an EMPTY key (`coalesce`), and the pull keeps the key of any
   event carrying our `chordUid`; an event without one (an invite, an event
   made in Google) still takes the provider's UID, which is how an adopted
   invite gets its real UID (ADR 0074/0103). The pull still finds our own
   events by `chord_uid` and `gcal_event_id`, so nothing needed Google's
   UID locally. The ADR 0217 `keepIcalUid` special case is now the general
   rule. Chose this over a separate shared-key column: every reader already
   treats `ical_uid` as the shared key, and moving it would touch them all.
   **Not retroactive**: copies pushed before this keep their separate keys.
2. **One writer per calendar.** Each copy is pushed under its owner's token
   to that owner's calendar, so two members whose default is the same
   shared Google calendar each inserted an event there. The push now
   compares REAL calendars across the copies (`'primary'` resolves to that
   user's primary Google id, else counts as their own) and, for copies that
   share one: the organizer's copy (else the lowest row id) inserts; a copy
   whose sibling already has the event adopts its id, etag and `chord_uid`;
   a copy whose writer has not pushed yet waits (stays dirty) and is bound
   by the writer right after its insert. A copy reflecting another member's
   event never patches it, and deleting one copy does not remove the Google
   event while another live copy still shows it. Consequence: an attendee's
   private edit to such a copy is not written to the shared calendar. A
   writer the provider rejected outright stops counting, so the next copy
   inserts. Code: `services/google/fanout-copies.ts`.
   The same rule covers repeating events (ADR 0217): each member's
   `event_series` copy shares `series_uid`, so only one series master is
   inserted per calendar; the other members' series (and their
   occurrences) are pointed at that master, which is how their pulls adopt
   its instances, and an attendee deleting their series leaves the master.
3. **A subscription is not a second copy.** `findLocalCopy` is
   owner-scoped, so a member subscribed to another member's calendar pulled
   that member's copy as a new row beside their own. The pull now skips an
   event carrying a `chordUid` whose row shares `ical_uid` with a live copy
   the puller owns. A puller with no copy of their own still gets it.

Not done: Outlook calendars are keyed per account, so a shared Outlook
calendar is not recognised as one.
Rejected: sending our UID to Google as the insert's `iCalUID` (unverified,
does not exist on Graph, and a shared calendar would refuse the second copy
as a conflict rather than adopting it); a database lock around the insert
(holds a connection across an HTTP call; the deterministic writer choice
gives the same result without one).
