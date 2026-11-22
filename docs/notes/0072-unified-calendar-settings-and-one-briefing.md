# 0072 — Unified calendar settings, info-by-default, one morning message

**Status**: accepted
**Date**: 2026-07-16
**Related**: supersedes the auto-busy rules of
[ADR 0033](./0033-calendar-busyness-policy.md) and the separate email digest of
[ADR 0063](./0063-billing-and-model-routing.md)'s email-magics work; builds on
[ADR 0057](./0057-device-calendar-as-source.md).

## Context

Settings grew two overlapping calendar lists: "Calendars" (every
`calendar_sources` row with Block/Info buttons) and "Device calendar &
Reminders" (device calendars with mirror toggles). A mirrored phone calendar
appeared in both; worse, a Google account calendar visible on the phone could
be imported **twice** (once via Google sync as `gcal:`, once via the device
mirror as `device:`), duplicating events. Separately, the morning briefing and
the email digest arrived as two bot messages, and the digest was a bland
count-per-category list.

## Decision

### One calendar list, two switches per row

`UnifiedCalendarsSection` replaces both cards. Every calendar — Google or
device — is one row with:

- **Block**: whether its events count in conflict checks. The default is
  **judged from the source API's own signals** (ADR 0033 rules, kept):
  Google `primary`/`owner`/`writer` and the Chord-target calendar block;
  reader-only shares (holidays, partner, subscribed) are informational.
  Device calendars ride the same rule via EventKit's `allowsModifications`
  → writer/reader mapping. The switch overrides either way.
  *(Amended same day: an interim revision defaulted everything to
  informational; reverted because both APIs carry a real ownership signal —
  see below — and per-event free/busy gives the finer control.)*
- **Per-event free/busy is honored on both providers**: Google's
  `transparency` was already pulled; EventKit's per-event `availability` now
  flows through the device sync (`DeviceEventInput.availability`) — an event
  marked "free" on the phone maps to `transparent` and never conflicts,
  `busy`/`unavailable` map to opaque, and events without the signal keep the
  structural rule (all-day / <5-min = free).
- **Mirror** (device-backed rows only): pull this phone calendar into Chord —
  the old AppleSync toggle, relocated. The iOS Reminders switch moves into the
  same card.

### Google/device dedup

A device calendar that is really a connected Google calendar (heuristic:
`isGoogle` + title matches the Google source's summary or id) **folds into the
Google row**: it is not offered for mirroring (the ✓ column shows it syncs via
Google), so the double-import can't start. If it is *already* double-mirrored,
the Google row shows the Mirror switch ON with a "turn Mirror off" hint —
turning it off stops the device pull; we deliberately do not auto-deselect
behind the user's back.

### One morning message, attention-first email section

The email digest no longer fires as a second proactive message. The
`daily_morning_scan` render appends the email section directly (same gates:
`GMAIL_ENABLED`, digest pref, Gmail scope), and `buildEmailDigestBody` was
rewritten attention-first:

1. **Waiting on you** — pending email-magic suggestions (ADR 0063 proposals).
2. **Worth a look** — newest unread threads, minus low-signal roots
   (Newsletters, Coupons, Deliveries, Receipts).
3. One closing count line (`N unread — Top · tiles`).

Nothing worth saying → no email section (no "all caught up" noise). The
`email_digest` proactive kind remains only to drain pre-existing queued rows;
nothing enqueues it anymore.

### Addendum — phone-only events render as local ghosts

The old design reduced un-mirrored phone calendars to a bare ⚠️ badge on the
Chord event they clashed with ("busy elsewhere", no detail). Replaced: the day
grid renders phone-only events as **ghost blocks** (dashed, muted,
lane-integrated so they sit beside the Chord event they overlap), read
on-device at render time and **never uploaded** — ADR 0057's
nothing-leaves-the-device posture holds, the user just sees their whole day.
Ghosts skip calendars Chord already ingests (mirrored, connected-Google) and
dedup by title+start against on-screen events; tapping one explains where it
lives and points at the Mirror switch. Native-only (web can't read a phone),
day view. The grid's ⚠️ badge and its per-slot busy probe are **removed** —
rendering the event beats summarizing it. The probe itself
(`getDeviceBusyForSlot`) survives for its other caller: the chat's
event-creation heads-up, where the user isn't looking at a grid. (That
heads-up was removed too on 2026-11-02 — see the last addendum.)

Calendar grid interactions: **tap an event to edit** (title / date / start /
end / location, plus delete) through the existing PATCH/DELETE routes — a
Google-synced copy bumps its sequence and two-way pushes (ADR 0040); a
device-mirrored copy follows LWW with the phone. Events render **colored by
source calendar**: `GroupEvent.color` is resolved server-side from
`calendar_sources.color` via `google_calendar_id` / the `gcal:`/`device:`
external-uid prefix (bare `gcal:<id>` = primary); ghosts use the device
calendar's color for their dashed outline; Chord-native events keep the
accent.

Sync windows aligned to a symmetric **−30/+90 days** on both providers: the
Google pull's past window widened 7 → 30 (a Google-account calendar is
excluded from the device mirror, so its 8–30-day-old events previously fell
through both paths), and the device pull's forward horizon widened 60 → 90 to
match Google's default (the 5,000-event batch cap has ample headroom).

## Alternatives considered

- **Auto-deselect double-mirrored calendars** — silent data removal on a
  heuristic match; surfacing the dup with a one-tap fix is safer.
- **Server-side dedup at event level** (match `device:` vs `gcal:` copies) —
  fragile cross-provider identity matching per event; stopping the duplicate
  *source* is the root fix.
- **Default everything to informational** (tried, reverted same day) — throws
  away real API signals and silently disables conflict checks for every
  Google user until they find the switch; the ownership heuristic plus
  per-event free/busy is strictly more accurate.
- **LLM-written email section in the briefing** — the deterministic section is
  free, testable, and already content-forward; the LLM briefing sits right
  above it.

## Consequences

- Blocking defaults are unchanged from ADR 0033 for Google users; device
  calendars gain the same treatment plus per-event availability, so a phone
  event marked "free" stops surfacing as a conflict.
- The briefing message gets longer on busy inboxes (bounded: ≤5 suggestions,
  ≤5 threads, one count line).
- `enqueueEmailDigest` survives for tests/legacy drains but has no production
  caller.

---

## Addendum (2026-08-13) — the on-demand summary is a sibling, not a reuse

The briefing's email section answers one fixed question at one fixed time.
"Summarize my emails from yesterday by sections" is a different question over
an arbitrary window, so it got its own module (`email/summary.service.ts`)
behind a new personal-only `summarize_email` tool, rather than growing
`buildEmailDigestBody` a window parameter.

Why separate:

- **Different shape.** The digest returns a rendered *string* to paste into the
  briefing message. The tool returns *structure* — sections, complete counts,
  capped examples — because the model narrates it, and a shared renderer would
  have to serve both and serve neither well.
- **Different sectioning.** The digest is attention-first (pending suggestions,
  then reply-worthy, then a count line), a shape tuned for a once-a-day nudge.
  The summary sections by the [ADR 0086](./0086-email-action-axis.md) action
  axis, which did not exist when the digest was written and is the better answer
  to "by sections".
- Both stay **deterministic — no LLM** — for the same reason: a summary that
  cannot invent mail is worth more than a fluent one that can.

**The window resolves in the user's own zone**, which is the whole subtlety and
the reason this is worth writing down: a thread arriving 20:00 UTC is already
tomorrow in Nairobi, so "yesterday" is not a UTC date. `zonedDayStartUtc` reuses
the drift-measuring technique from `nextScanDate` (render the naive instant in
the zone, measure the offset, subtract it) so DST is handled at the target date
instead of assumed. Omitting both dates means the user's yesterday, so the model
never has to compute a date itself — the failure mode that
[ADR 0074](./0074-timezone-anchoring-and-invite-reconciliation.md) exists to
prevent.

Personal-1:1 only, through the existing `PERSONAL_ONLY_TOOL_NAMES` gate: mail is
personal and has no group, the same rule [ADR 0084](./0084-email-and-todos-in-search.md)
applies to searching it.

## Addendum (2026-11-02) — the phone's creation-time conflict popup is removed

Prod: "add call w dinosaurs on Tuesday at 11a" popped **Possible conflict**
on the phone, naming "Makeup Picture Day" on the read-only Lakeside school
feed — a calendar whose Block switch is OFF. The server's own check
(`computeConflicts`, the event-created nudge) ran and correctly found nothing.
The popup was `getDeviceBusyForSlot`, run by the chat screen on every
`event.created` for the user's own copy: it read EVERY calendar on the phone
and never consulted the Block setting this ADR made the single source of
truth, so any subscribed feed synced to the phone could raise it.

It was written when the server only saw Google calendars. Since then the
server reads Google and Outlook directly and phone-only calendars through the
ADR 0057 mirror, all under the Block switch, so the popup duplicated the real
check with a cruder rule. Removed (phone, iOS and Android alike) rather than
taught the Block settings: mapping a phone calendar to its setting is not
one-to-one (a Google-backed phone calendar folds into its Google row), and
what the popup alone could catch — a phone-only calendar with Mirror off, or
an event added on the phone minutes before the next mirror pass — it caught
without knowing whether that calendar should block. The rule is now one rule:
Chord warns about calendars it syncs and that are set to Block; a phone-only
calendar that should count needs Mirror and Block on. No bot tool change (a
warning, not a capability).
