# 0226 — What is kept, and for how long

Status: accepted (2026-10-04)

## Context

The 2026-10-03 outage (ADR 0174 addendum) was a disk filled by logs. The
cause is fixed there, but the review afterwards found that nothing on the
server had a limit on how much it could keep, only on how long:

- **App logs** rotated at 20 MB per file and were deleted by AGE (14 and 30
  days). Age puts no limit on a bad day: 23.5 GB was written in three hours.
- **The system journal** ran on its defaults (up to 10% of the disk) and stood
  at 879 MB.
- **Four database tables** were written and never deleted from. They are
  small (about 3 MB of a 294 MB database, and not on the server's disk), so
  this is not about space. It is that a table nobody prunes has no stated
  answer to "how long do we keep this".

## Decision

### Logs are capped by size

Measured in prod: a normal day writes 1.4 to 2.5 MB to `combined-*`; `error-*`
and `prompts-*` are near zero. Two normal days is 5 MB, which was the first
figure chosen; the owner raised it to **50 MB a log for now**, which is some
weeks of ordinary running and leaves room to read back through an incident.

- Each of the three logs keeps **two files of 25 MB** (`maxSize: '25m'`,
  `maxFiles: 2` as a file COUNT). 150 MB at most across all three, on a
  30 GB disk.
- The system journal is capped at **200 MB** by a drop-in
  (`/etc/systemd/journald.conf.d/chord.conf`) written on every deploy
  (`JOURNAL_MAX_USE` in `deploy.env` overrides).

### Rows are removed after a stated window

`pruneOldRows` (`services/retention.service.ts`) runs from the proactive tick
at most once a day (`maybePruneOldRows`, in memory).

| Rows | Kept | Why that long |
|---|---|---|
| `proactive_messages` that have fired | 30 days | Nothing reads a fired row for long after it fires. A row that has not fired is never removed. |
| `proposals`, rejected | 15 days | Offered and declined; nothing reads it. |
| `proposals`, expired | 30 days | Read by the Email tab's "still owed" count (ADR 0134), which has no age limit of its own. This window is therefore also how long an unanswered suggestion counts as owed. |
| `token_usage` | 365 days | Billing sums the current period only (ADR 0196). The rest is cost history, and a year of it was asked for. |

Kept on purpose:

- **Confirmed proposals** are the record of what the user approved.
- **`email_unsubscribes`** is what lets the reader show a sender as already
  unsubscribed (ADR 0122). Deleting a row would offer the unsubscribe again.

Each window is a setting (`RETENTION_*_DAYS`; 0 keeps that kind forever), and
`RETENTION_ENABLED=false` turns the prune off.

A proposal is dated by `resolved_at`, or by `created_at` when it has none.

## Rejected

- **Keep age-based log retention and add a disk alert.** An alert tells
  someone; it does not stop the disk filling at 3am. A size cap does. (An
  alert is still worth having and does not exist yet.)
- **One total cap across all three logs.** The library caps per log; a
  shared cap would need our own cleanup pass over the directory.
- **Two normal days (5 MB).** The first figure. Too little to read back
  through an incident, so it was raised to 50 MB.
- **A database job (pg_cron) for the prune.** Another moving part on Cloud
  SQL for four indexed deletes a day.
- **Persisting when the prune last ran.** A restart runs it again, which
  costs four deletes that find nothing.
- **Pruning confirmed proposals, mail, or events.** Those are the user's
  content or record, not bookkeeping.

## Consequences

- During an incident the logs hold only the most recent 50 MB of each kind.
  Anything older is gone, so a fault that floods one log pushes out what led
  up to it.
- The cap is applied by the rotation library when a new file starts. A burst
  written inside a single event-loop turn can leave more than two files
  behind (the files being removed do not exist on disk yet); checked on
  Linux at the first figure (2.5 MB files), paced writes of 40 MB left 3 MB
  in two files.
- The library tracks its files in an audit file named after the options, so
  files written under the OLD options are not known to it and are never
  removed by it. They are deleted once, by hand, at deploy.
- An expired suggestion stops counting as "still owed" after 30 days.
- There is still no alert on disk space or on Redis memory.

## Addendum 2026-11-02: a phone calendar the phone stopped sending

The phone calendar mirror (ADR 0057) registers every calendar the phone
sends as a `calendar_sources` row (`provider = 'device'`, `last_seen_at`
refreshed on each sync) and reverse-deletes events only for calendars IN the
batch. A calendar the phone stops sending (unticked from Mirror, removed
from the phone, the phone itself gone) kept its row in Settings and its
`device:<calId>:<eventId>` events forever. Prod: one user had "Family" and
"John Doe" phone calendars last sent 2026-10-15 while the rest were sent
2026-11-02.

The daily prune now forgets a `device` source not seen for
`RETENTION_DEVICE_CALENDAR_DAYS` (30; 0 keeps them forever), with that
user's events whose `external_uid` starts with `device:<calId>:`, in one
transaction per calendar. `last_seen_at` is compared as an instant.

- **Time, not "missing from the latest batch".** A second phone sends only
  its own calendars, so a missing-from-batch rule would delete the other
  phone's.
- **Rows the Google/Outlook pull adopted are kept.** `findLocalCopy`
  (ADR 0040) matches a mirrored row by the `ical_uid` the phone stored and
  gives it `google_calendar_id` / `gcal_event_id`; from then on it is the
  server's copy of that event. Deleting it would drop the event from Chord
  until the next full pull (a delta never re-sends an unchanged event), so
  any row with either column set is left alone.
- **Removed, not tombstoned.** Nothing is pushed to a provider. The phone's
  delete reconcile (ADR 0208, `POST /me/events/live`) only asks about events
  Chord wrote TO the phone; a mirrored row was read FROM it, so the phone
  deletes nothing of its own.
- Only `provider = 'device'` rows; Google/Outlook sources are untouched.

Not covered (same shape, deferred): the primary Google calendar list
(`discoverCalendars` in `google/two-way-sync.service.ts`, and the legacy
read sync in `google/calendar.service.ts`) never forgets a calendar Google
stops listing, unlike the Outlook and second-Gmail lists, which call
`forgetCalendarsByKey`; and `contact_links` (ADR 0065) only grows.

## Addendum 2026-11-16: a file count is a day count

Rotation is daily (`datePattern: 'YYYY-MM-DD'`), so a new file starts every
day and `maxFiles: 2` kept **two days**, not the "some weeks" the decision
above expected from 50 MB. Found when a trace of a Nov 8 email on Nov 16
found only `combined-2026-11-15.log` and `combined-2026-11-16.log`.

- Each log now keeps **30 files** (`LOG_FILES`), each still capped at
  **25 MB** (`LOG_FILE_SIZE`). On an ordinary day (1.9-2.8 MB to
  `combined-*`) that is a month of history, about 100 MB across the three
  logs.
- The size cap is still the ceiling. A day that floods a log rolls over into
  several files of that day and pushes older days out, so during an incident
  history is shorter, but a log never exceeds 30 × 25 MB = **750 MB**: 2.25 GB
  across all three on the 30 GB disk. No separate total cap: the per-log cap
  already bounds it, and a shared one would still need our own cleanup pass
  (rejected above).
- Each log names its audit file (`.<log>-audit.json`, `rotationOptions` in
  `config/logging.ts`). Unnamed, the library names it after a hash of the
  options, so every options change, this one included, started a new audit
  file and left the old files untracked forever. From now on an options
  change keeps tracking them. The files and `.<hash>-audit.json` files written
  before this change are not in the new audit and are deleted once by hand
  when no longer wanted.
- The journald cap (`JOURNAL_MAX_USE`, 200 MB) is unchanged: in production
  the app logs only to these files (no console transport), so the journal
  holds systemd lines and crash stacks, not app history.
- `server/src/config/__tests__/logging.test.ts` pins the options.
