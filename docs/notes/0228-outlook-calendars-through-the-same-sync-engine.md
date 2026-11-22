# 0228 — Outlook calendars, through the same sync engine

Status: accepted (2026-10-08). Built and tested at the fetch boundary; **not
yet run against a live Microsoft mailbox**, and off by default
(`OUTLOOK_CALENDAR_ENABLED=false`).

## Context

Chord reads and writes Outlook mail (ADR 0080) but knew an Outlook calendar
only when the phone happened to show it and the device mirror was on
(ADR 0057): read-only, iOS-only, and nothing Chord created could reach it. A
family where one adult lives in Outlook had half its calendar missing.

The calendar code was written for Google. `two-way-sync.service.ts` held both
the rules (which copy wins, how an invitation is adopted, how a series'
occurrences are matched, when a missing event means "deleted") and the Google
HTTP calls. `calendar_sources` already allowed more than one provider
(`google`, `device`), and its id column was already generic.

## Decision

**One engine, one transport per calendar.** The engine keeps every rule and
loses its HTTP. A `CalendarTransport` (`google/calendar-transport.ts`) has five
verbs — insert, patch, get, remove, list changes — and speaks Google's event
shape, which stays the engine's working shape. Google implements it with the
calls that were already there. Outlook implements it over Microsoft Graph
(`outlook-calendar/transport.ts`) and translates at the edge
(`outlook-calendar/map.ts`). No rule is written twice.

**An Outlook calendar is named `outlook:<accountId>:<graphCalendarId>`** in the
existing `google_calendar_id` columns, the way ADR 0080 stored mail ids. The
prefix picks the transport; the account id picks the token. A push pass can
therefore send each event to its own provider (`PushTargets`), and a provider
that cannot take a write right now leaves its rows queued instead of failing
them.

**A mailbox carries a calendar when its grant includes `Calendars.ReadWrite`**
(`email_accounts.calendar_enabled`, migration `099`, set on every connect). The
calendar rides the mail connection: no second sign-in, and a mailbox connected
before this has mail only until Outlook is added again. With the flag on, the
app asks for the extra permission at connect (`EmailStatus.outlookCalendar`).

Where Outlook differs, the difference is settled in the translation:

- **No `sequence`.** Graph has none. Left undefined, and the engine then
  compares by modification time alone (`remote.sequence ?? local.sequence`).
  Read as zero it would make the Outlook copy look older than any event Chord
  had ever edited, and nothing changed in Outlook would reach Chord again. An
  Outlook pull also leaves Chord's own counter alone.
- **No etag condition on writes.** With no sequence, a refused write would have
  nothing better to decide by than the timestamps the pull already uses.
- **Times.** Graph is asked for UTC and the result is restated in the reader's
  zone (`users.last_tz`), the form a Google pull stores, so nothing downstream
  sees a third shape.
- **Repeats.** Graph has no RRULE: the rule is rebuilt as its `recurrence`
  object. It has no exception list either, so a removed occurrence (EXDATE) is
  removed by finding and deleting that one instance.
- **Deltas.** `calendarView/delta` lists an ordinary occurrence with its id and
  times only; the rest is read off the series master in the same listing
  (fetched if absent). A delta is tied to the window it was started with, so
  the cursor is replaced by a full listing every 12 hours — which is also what
  moves the window forward and removes anything a delta never mentioned. A
  removed series is reported once, by its master's id; the engine now removes
  the occurrences it holds for that id.
- **Ids.** Every call asks for immutable ids, so an event keeps its id when it
  moves between calendars. (ADR 0199 declined these for mail because existing
  ids would need migrating; a new store has no such cost.)
- **Invitations.** Graph has a real answer call, and it tells the organizer.
  `respondToInvite` tries Google's calendar, then each Outlook calendar, and
  only then falls back to the iTIP email (ADR 0104).
- **Guests.** Outlook emails invitations whenever an organizer's event has
  attendees; there is no flag to pass.

**`primary` still means the Google primary.** A user with no Google calendar
but an Outlook one has none, so for them it reads as the Outlook default
calendar — in the push and in `resolveTargetCalendarId`, so what the bot
reports is where the event goes. `is_primary` stays the Google primary's alone;
its readers expect exactly one.

**Choosing by name (ADR 0137).** Google and Outlook calendars both qualify as
places to write. "Outlook" on its own means the mailbox's default calendar;
with two mailboxes it is a question. The same name owned on both providers is
a question too, and the candidates are labelled `(Google)` / `(Outlook)` so a
read-back resolves.

**The phone's copy gives way.** The phone often shows the same Outlook
calendar, and its mirror may have put an event in Chord first. When the server
copy arrives it removes the phone's (same UID, or same start and title — the
device sync's own two keys), and the device sync then skips the event as it
already does for a server copy that came first.

**Disconnecting a mailbox** removes its calendars and the events that only
ever came from them. An event Chord made and pushed there stays a Chord event
and loses only its Outlook identity.

The sweep (ADR 0181), the manual sync route and `maybeSyncCalendar` now run for
a user whose only calendar is Outlook. Google and each mailbox are synced
independently; a dead Google token is still thrown, after the others have run.

## Consequences

- **Unverified against Microsoft.** The request and response shapes are Graph's
  documented ones and are pinned by tests at the fetch boundary. The parts most
  likely to need adjusting on first contact: IANA zone names on write, the
  exact stripped shape of a delta occurrence, and the error Graph returns for
  an expired delta cursor (410 and 400 both restart the listing).
- Off by default. Turning it on needs `Calendars.ReadWrite` on the Microsoft
  app registration, then `OUTLOOK_CALENDAR_ENABLED=true`.
- The mock Outlook mailbox (`OUTLOOK_PROVIDER=mock`) has no calendar.
- A series' removed occurrences cost one lookup each on every push of that
  series.
- Between full listings, a change to a series master is seen for the
  occurrences Graph re-lists; anything it does not re-list waits for the next
  full listing (at most 12 hours).
- A shared calendar in Outlook that the phone also mirrors shows twice in the
  Settings list (once as Outlook, once as the phone's); its events do not.
- No bot tool was added: connecting is a sign-in, and creating, moving and
  answering already have tools, which now reach Outlook calendars by name.

## Alternatives rejected

- **A second sync service for Outlook.** Every rule in the engine was learned
  from a production incident (ADR 0103, 0136, 0181, 0200, 0217). A copy would
  start without them and drift.
- **Read-only first.** Smaller, but it leaves the family's plans unable to
  reach the calendar one adult actually looks at.
- **A full listing on every pass, no delta.** Simpler, and a busy work calendar
  is thousands of occurrences every five minutes.
- **Marking the Outlook default calendar `is_primary`.** Three readers assume
  one primary and attribute legacy Google ids to it.
- **Matching the phone's copy on the client**, as ADR 0072 does for Google by
  account name. Exchange accounts on a phone are not reliably named after the
  address; the server already has both copies and the keys to match them.
- **A separate "connect Outlook calendar" sign-in.** A second consent for the
  same account, and a second token to keep alive.
