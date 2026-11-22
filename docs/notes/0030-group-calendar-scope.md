# 0030 — Group-chat calendar scope: Chord-target calendar only

**Status**: accepted — **superseded by [ADR 0040](./0040-user-owned-two-way-calendar.md)**: events are now user-owned with a `group_ids` visibility column rather than group-owned, and group-chat scope is expressed through that model (viewer-only sharing exposes free/busy only). The default-deny intent is preserved.
**Date**: 2026-05-16
**Related**: [ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md),
[ADR 0015 — Server-side Google Calendar write](./0015-server-side-google-calendar.md),
[ADR 0020 — Cross-group personal context](./0020-cross-group-personal-context.md),
[ADR 0028 — Calendar scope at sign-in](./0028-calendar-scope-at-signin.md)

## Context

When the user signs in (ADR 0028) we get `auth/calendar` scope across
their whole Google account. The read sync (`syncPrimaryCalendar`) pulls
events from **every** calendar they have at least reader access to —
primary + secondaries + shared — and lands them in the user's personal
group in Chord. The write path (ADR 0015) creates or reuses a single
*Chord-target* calendar, whose name is controlled by
`GCAL_TARGET_CALENDAR_NAME` (default `"Family"`).

ADR 0020 lets the user opt in to "cross-group personal context": when
the bot is invoked in a non-personal group, it inlines the triggering
user's personal data (tasks, lists, events, etc.) into the system
prompt so it can answer "what's on my calendar?" or "what's on my
list?" without the user having to leave the group.

The combination produces a real privacy problem: a user asking
"what's on my calendar this weekend?" in a family group has the bot
include events from their **work** calendar, their **personal**
calendar, and any shared calendars they have reader access to — none
of which the rest of the family should see. The model is instructed
not to dump the data, but soft instructions are not a privacy
boundary.

## Decision

In a non-personal group context, the only Google-calendar events the
bot may see when reading the triggering user's personal calendar are
those that came from the **Chord-target calendar** — the same
calendar Chord itself writes to (`users.google_calendar_id`, name
defaulting to "Family").

Concretely: the cross-group `personalContextBlock` path swaps
`listEventsForUser(db, userId)` for
`listEventsForUserFromChordCalendar(db, userId)`. Personal-chat reads
keep the unfiltered view.

The filter is enforced server-side, before any LLM call. It is not a
prompt instruction — the model cannot see, summarize, or leak events
it never received in the first place.

### Default-deny

If `users.google_calendar_id` is null — the user has never written or
been bound to a Chord-target calendar — the helper returns `[]`. We
do **not** fall back to "show events from your primary" or "show
everything." The cost of an empty answer is small; the cost of an
accidental leak from a misconfigured user is large and silent.

### Matching rules

Synced events carry an `external_uid`:

- `gcal:<eventId>` — synced from the user's *primary* Google
  calendar.
- `gcal:<calId>:<eventId>` — synced from a secondary or shared
  calendar.

An event passes the group-scope filter iff:

1. `external_uid` exists and starts with `gcal:`, AND
2. Either the encoded `<calId>` equals `users.google_calendar_id`
   (secondary case), OR the uid is bare-prefix and
   `users.google_calendar_id` matches the user's primary — detected
   by comparing it to `users.email`, since Google addresses primaries
   by owner email.

Chord-native events (no `external_uid`) are excluded from the
group-context view. They may live in a different group's row and
their visibility there is governed by ADR 0004, not by this filter.

## Alternatives considered

- **Filter in the prompt** — tell the model "only mention events
  from the Family calendar." Rejected: prompt instructions are not a
  security boundary. The model has the data and can be coerced or
  drift into surfacing it. Server-side filtering is the only sound
  fix.

- **Sync only Chord-target into shared groups** — change
  `syncPrimaryCalendar` so events from the Chord-target calendar
  also mirror into the user's shared groups. Rejected for now: opens
  the question "which shared group does an event go to if the user
  is in three?" and requires reasoning about cross-group event
  identity. The filter-at-read approach is smaller and reversible.

- **Soft default — include primary when no Chord-target is known**
  — friendlier first-run UX, but the failure mode (silent personal
  leak) is exactly the thing this ADR exists to prevent. Empty
  answer beats wrong-and-confident.

- **Per-event ACL flag** — add a column saying "shareable yes/no" on
  each event. Overkill for the current product; deferred until a
  user actually asks for per-event sharing controls.

## Consequences

- **Privacy guarantee is structural**, not prompt-driven. The bot
  literally never sees out-of-scope events in a group context.

- **Users with calendar disconnected get an empty calendar view in
  groups.** The bot can still answer based on events the user (or
  Chord) explicitly added in that group — but cross-group "what's on
  my calendar" returns nothing until they connect or save at least
  one event to a Chord-target calendar. UI affordance to encourage
  this is on the welcome-screen copy (already updated 2026-05-16).

- **`users.google_calendar_id` becomes load-bearing** beyond writes.
  Migration / reset code that nulls this column will silently empty
  group-context calendar views for affected users. Any future code
  touching that column should consider re-resolution at next sync.

- **Personal chats are unaffected.** The user talking with the bot
  alone (in their own personal group / DM) keeps the full multi-cal
  view they had before — that's their own data, no one else is
  looking.

- **Sign-on copy** now states this guarantee explicitly. If the
  policy ever softens, the copy must change in lockstep.

## Implementation

- `server/src/services/events.service.ts` —
  `listEventsForUserFromChordCalendar(db, userId)` + the
  `isFromCalendar` matcher.
- `server/src/services/bot/context.ts` —
  `personalContextBlock` swaps to the scoped helper when
  `isCrossGroup`.
- `server/src/services/__tests__/events-chord-calendar-scope.integration.test.ts`
  — covers no-cal-set, Family-as-secondary, Family-as-primary,
  Chord-native exclusion, and the personal-chat unfiltered path.
- `mobile/app/index.tsx` — welcome-screen consent copy updated to
  match.
