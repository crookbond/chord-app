# ADR 0313 — A second Gmail carries its own calendar

**Status:** Accepted, 2026-10-30
**Extends:** ADR 0080 (addendum: secondary Gmail), ADR 0228 (Outlook calendars), ADR 0312 (mail stays with its mailbox)

## Context

ADR 0312 sends an event made from an email to the calendar of the mailbox the
email came to, and answers an invitation from that mailbox only. Primary
Gmail and a calendar-carrying Outlook mailbox have a calendar; a secondary
(attached) Gmail did not, so every event from its mail asked the user to pick
a calendar on the card, and an invitation to it could only be answered by an
emailed iTIP reply.

The owner wants that mailbox's events on that Google account's own calendar,
under the same rule: a calendar or answer from one mailbox never reaches
another.

Checked first: the app's secondary-Gmail connect already asks for the
`calendar` scope beside `gmail.modify` (`GMAIL_SCOPES` in
`mobile/app/settings.tsx`, so a primary connect would not drop calendar).
Google's grant is per account, so the attached account's refresh token
already carries calendar access whenever the user left the box ticked. The
server simply ignored it. `email_accounts.calendar_enabled` and
`calendar_default_id` already exist (migration `099`, ADR 0228).

## Decision

1. **The grant decides, and is re-read on every token refresh.**
   `connectGmailAccount` sets `calendar_enabled` from the granted scopes
   (`grantsGoogleCalendar`: `https://www.googleapis.com/auth/calendar`), like
   Outlook. Google's refresh reply also carries `scope`, and an attached Gmail's
   token is refreshed on every mail sync, so `noteGmailCalendarGrant`
   (`gmail-calendar/grant.ts`) switches the calendar on (and runs its first
   calendar sync) or off (forgetting what it pulled) whenever the grant
   changes. A mailbox connected before this change, whose grant already has
   the calendar, gets its calendar at its next sync with nothing to do: no
   reconnect, no new consent. Only someone who unticked calendar on Google's
   consent screen must connect again, because Google adds a scope only through
   consent.

2. **A calendar of that account is `gacct:<accountId>:<googleCalendarId>`** in
   the generic source-id columns (`calendar_sources.google_calendar_id`,
   `events.google_calendar_id`), like `outlook:<accountId>:<id>`. The prefix
   says which token to use; nothing else needs a join. `provider` stays
   `'google'` (it is a Google calendar, so name matching, the writable-calendar
   checks and labels treat it as one) and `is_primary` stays false (that flag is
   the login account's primary alone). Its label is its name plus the account
   address, so two "primary"-ish calendars named after two addresses read apart.

3. **One transport per account token.** `gmailCalendarApiFor` builds the
   ordinary Google transport on the account's own access token and translates
   the key to Google's id on every call (strips the prefix going out, nothing to
   translate coming back). The sync engine's `PushTargets.transportFor` and
   `pullCalendarChanges` route a `gacct:` key there, cached per account like
   Outlook; `syncTwoWay` discovers and pulls each such account's calendars after
   Google and Outlook, each account independent (one failing never stops the
   others). The primary token is never handed a `gacct:` id and an account token
   never a bare one, so a write cannot cross accounts by construction; were it
   to, Google would 404 on an id it has never seen.

4. **ADR 0312 routing.** `mailboxCalendar` returns `auto` with the account's
   `calendar_default_id` (its primary calendar's key) for a Gmail mailbox whose
   calendar is connected, as it does for Outlook. `respondToInvite` for such a
   mailbox finds the invitation by `iCalUID` on that account's calendars and
   patches its own attendee entry with that account's token (ADR 0104) before
   falling back to the iTIP reply from the same address.

5. **Disconnect** forgets the account's calendars like Outlook's: pulled events
   go, Chord-made ones keep living as Chord events without the Google identity.

## Consequences

- A calendar shared between the login account and an attached account is two
  sources (two keys) and its events are pulled twice, as two calendars of the
  primary account already are. Not merged; the owner rule is the stronger one.
- `GMAIL_PROVIDER=mock` attaches a mock mailbox with no calendar.
- The calendar sweep (ADR 0181) now also picks up users whose only calendar is
  an attached Gmail.

## Rejected

- **A separate calendar connect for the attached account**: a second consent
  for a scope the existing one already asks for.
- **Asking existing users to reconnect**: friction for a grant most of them
  already gave; the refresh reply says so for free.
- **Using the login account's token on a calendar the attached account shares
  with it**: works only when shared, and answers an invitation as the wrong
  person.
- **A new column for the attached account's calendar**: `calendar_enabled` /
  `calendar_default_id` already say it, for Outlook.

## Notes

- **Free/busy is unchanged.** Where an event is WRITTEN follows the mailbox;
  what counts as BUSY does not. `busyCalendarIds` reads every
  `calendar_sources` row whatever its provider, and an attached Gmail's own
  calendars (owner/writer) count as busy like any other.
- **Fixed with it — work started on a transaction that had already closed.**
  `confirmProposal` runs the tool inside `db.transaction()`, and the executor
  started background work fire-and-forget on that transaction handle: the
  calendar sync after `create_event` / `update_event`, and the ADR 0163
  meeting summary for an event with guests. The work outlived the
  transaction: the sync claimed the row (`local_dirty = 0`) inside it and
  then failed to push on the closed handle, so the event was marked clean and
  never sent; the summary's write failed ("Transaction is already
  committed") and was never saved. Both predate ADR 0312 (the 5-minute sync
  throttle and the model's latency decided whether they showed). The
  executor now hands such work to the caller's `afterCommit`
  (`startAfterWrite`), and `confirmProposal` starts it on its own handle once
  the transaction committed, beside the buffered broadcasts; outside a
  transaction it starts at once, as before.
- **Fixed with it — another account's pull taking over the event.** A pull
  matches an event Chord pushed by its `chord_uid` on any calendar (so an
  event Google moves between calendars keeps its row). With an attached
  Gmail's calendar also shared with the login account, the login pull found
  the second account's event, moved the row onto its own bare calendar id,
  and from then on wrote it with the login token. A pull now leaves a row
  (or a repeating series) on another account's calendar alone: no takeover
  and no second row (`onOtherAccount` in `two-way-sync.service.ts`).

## Addendum 2026-11-09 — the event's own push waits for the commit too

The fix above covered the executor's `maybeSyncCalendar` but not the push
`createEvent` / `updateEvent` start themselves (`firePush`), nor the series
push (`events/series.service.ts`). Both started `pushDirtyEvents` un-awaited
on whatever handle they were given. Inside a transaction (a confirmed email
event card, a trip bundle, a multi-group confirm, `addTravelLeg`'s flight
event, a leg's event moved by `reconcileBookedLegs`) the claim
(`local_dirty = 0`) ran in the transaction and the Google id was written
after the commit, which Kysely refuses ("Transaction is already committed"):
the event was committed claimed with no Google id, so no later sync sent it.
Not seen in prod data; found by reading `firePush`, reproduced in
`events-push-in-transaction.integration.test.ts`.

One mechanism now, in `db/after-commit.ts`: `runAfterCommit(db, job)` starts
the job at once outside a transaction, and inside one hands it to the sink
bound to that transaction. `transactionThen(db, fn)` opens a transaction with
a sink and starts the collected work on `db` after commit (a rollback
discards it; an outer transaction is joined). `confirmProposal` binds its
existing commit buffer, so executor work and the event's own push go to the
same place; `startAfterWrite` is now `runAfterCommit` with the explicit
`afterCommit`. `addTravelLeg`, `addAccommodation` and
`withThreadStagingLock` open theirs with `transactionThen`. A transaction
opened any other way that writes an event leaves the push not started and
logs it: the row stays `local_dirty = 1` and the next sync sends it (delay,
not loss). New transactions that can write an event should use
`transactionThen`.

Swept and left: `deleteEvent` awaits its push inside the caller's handle, so
nothing outlives the transaction (the provider delete is sent before the
caller commits, as before); the guest change (`ensureOnProvider`) also
pushes awaited. Other `runInBackground` callers start on the root handle.
