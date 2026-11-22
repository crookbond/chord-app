# 0074 — Timezone anchoring everywhere + calendar-invite reconciliation

> **Narrowed by [ADR 0344](./0344-an-email-event-is-only-removed-when-you-say-so.md) (2026-11-16):** the "invite wins" takeover and the removal of Chord's copy described below no longer happen. A same-meeting match now needs a matching title or a person in common, and Chord asks in chat before removing the email-made event.

**Status**: accepted
**Date**: 2026-07-18

## Context

A serious correctness bug: several extraction paths read local times out of
emails/attachments and silently assumed **UTC**, creating events at the wrong
instant. Worse, a calendar-invite email produced **duplicate events** — one
UTC-shifted event from the email magics LLM, one correct event when the user
accepted the invite in Google — with unrelated `ical_uid`s, no dedup anywhere,
and the conflict engine flagging the twins against each other.

A four-way code sweep found the UTC assumptions clustered:

- **Email magics** (`EXTRACT_SYSTEM`) demanded an offset-qualified `startsAt`
  but gave the model no timezone, no today's-date, and no email date — Gmail's
  offset-bearing `Date` header was fetched and then **dropped** in
  `normalizeMessage`.
- **Proposal confirm** (`proposals.service.ts`) normalized bare datetimes with
  a hard-coded `'+00:00'` even though the confirming user's `last_tz` was on
  their user row.
- **Attachment classifier**: flights were correct (airport IANA zone) and
  calendar PDFs used the uploader's offset, but restaurant/movie times fell
  through `leniDatetime`, which appended `Z`; non-web ingest paths had no
  uploader offset at all → UTC.
- **ICS import** collapsed everything to a UTC instant (acceptable) but turned
  date-only VEVENTs into **timed 09:00 server-local events** and dropped DTEND.
- **Rendering**: the briefing regex-extracted the stored wall-clock (wrong for
  UTC-stored rows), and the email digest rendered in the **server's** zone.

## Decision

### 1. One timezone anchor for every write path

`utils/tz.ts` owns `tzToOffset(iana)` / `tzToOffsetMinutes(iana)` (moved out
of `bot.service.ts`). The rule: **a bare datetime always gets a real user's
offset appended — never a silent UTC default.**

- **Proposal confirm** resolves the *confirming* user's `last_tz` and passes
  it through `validateCall`/`commitRow`/`applyToolCall`. Their tap is the
  moment "5pm" becomes an instant; their zone is the only sane reading.
- **Magics extraction** is grounded: the prompt now carries the user's IANA
  zone + current offset, the email's sent date (raw `Date` header, now
  preserved into `headers_json.date`; `internal_date` as fallback), and
  "today" in the user's zone — plus explicit rules (times are the user's zone
  unless the email names another; resolve relative dates from the sent date).
- **Classifier**: restaurant/movie switched to the no-forced-zone datetime
  shape and get `toLocalDatetime(uploaderTz)` at filing, like calendar
  entries; when the browser `timezoneOffset` param is absent the classifier
  falls back to the uploader's `users.last_tz`.
- **ICS**: date-only VEVENTs import as true **all-day** events (floating
  midnight + explicit `allDay`, which `create_event` now accepts and threads
  through); DTEND is carried as `endsAt`. Timed values remain UTC instants
  (node-ical already resolved TZID) — correct instant, zone label dropped.

### 2. Render in the user's timezone

`fmtWhen`/`fmtTimeOnly`/`dayOf` in the proactive service take the recipient's
`last_tz`: zone-carrying instants convert into it; floating strings (already
the user's wall clock) render literally. "Today" for briefing bucketing is
computed in the user's zone, not UTC. The email digest does the same instead
of using the server's zone.

### 3. Calendar invites: deterministic ICS, UID reconciliation — no LLM

An email that carries a `text/calendar` / `.ics` part is an **invite**; the
magics pass no longer asks the LLM about it. `email/invite-ics.ts` fetches
the part and parses it with the existing deterministic ICS parser; the staged
proposal carries the invite's **RFC-5545 UID as `externalUid`** and its exact
TZID-resolved times. That UID is the same one Google keys the event on when
the user accepts the invite, so the two paths reconcile in either order:

- **Accept first, confirm later**: the executor's create_event dedup ladder
  gained an owner-scoped `ical_uid` match (`findOwnedEventByIcalUid`) — the
  confirm lands on the synced row instead of minting a twin.
- **Confirm first, accept later**: the created row keeps the UID in
  `external_uid`, which the pull-side `findLocalCopy` external-uid bridge
  already matches against the incoming iCalUID.
- An invite that won't parse stages **nothing** (the calendar-accept path is
  authoritative; an LLM guess here is exactly where UTC-shifted twins came
  from). A fetch failure falls through to the normal LLM path.

### 4. Fuzzy safety net for keyless twins

`findSimilarEvent`: same group + same title (case-insensitive) + start within
±60 minutes → the executor returns the existing event as deduped. Narrow on
purpose — a weekly repeat is days away and never matches.

## Consequences

- Extraction can still misread a genuinely ambiguous email, but the
  *systematic* UTC shift is gone, and invites — the common duplicate source —
  are now deterministic end-to-end.
- Events already stored at wrong instants are not retro-fixable (the intended
  local time is unknowable); users correct those by hand.
- `users.last_tz` is client-reported and best-effort; every use falls back to
  the previous behavior when absent, so nothing regresses for users who have
  never reported a zone.
- The magics pass costs one extra `getMessage(full)` per candidate thread
  (the invite probe), bounded by the existing per-call limit.

Tests: `invite-magics.integration.test.ts` (deterministic staging, LLM
bypass, both dedup orders), `parse.test.ts` (all-day + TZID + DTEND),
`tools.test.ts` (offset normalization), plus the existing magics/proposal
suites.

## Addendum (2026-07-18): "invite wins" — plain-email agreements vs the real invite

The UID reconciliation above covers invite *emails*. The remaining twin
source: a meeting agreed in **plain email** ("Tuesday 2pm works!") becomes a
Chord event via magics → confirm — keyless, and usually titled differently
from the invite one party sends afterwards. Key dedup can't link them; the
title-fuzzy net misses; the Google pull inserted the accepted invite as a
same-slot twin. Owner rule: **the real calendar item wins; the email-derived
event must yield.**

`event-convergence.service.ts` (leaf module — no import cycles):

- `findAdoptableEmailEventTwin`: same owner, timed, provenance
  `gmail:<threadId>`, and **no external identity of its own** (no gcal id,
  no invite UID — those reconcile by key), starting within ±60 min of the
  incoming item. The narrow provenance filter is what makes time-window
  adoption safe: only events Chord itself guessed from email are ever
  adopted; a manually created or synced event at the same time is never
  touched.
- `retractPendingEmailEventProposalsNear`: expires still-pending keyless
  email `create_event` proposals inside the window.

Wired at all three arrival points:
1. **Google pull** (`pullCalendarChanges` insert branch): an unmatched timed
   remote first looks for the email twin — found → `applyRemoteToLocal`
   onto it (Google identity, title, and exact times overwrite the email
   guess) instead of inserting; pending proposals near the slot are
   retracted either way.
2. **Invite-email confirm** (executor `create_event` with `externalUid`):
   after the UID dedup misses, the email twin is adopted in place (invite
   UID + fields stamped, marked dirty for push).
3. **Invite staging** (magics invite branch): staging the UID proposal
   retracts the older keyless proposal for the slot, so the user never sees
   two pending suggestions for one meeting.

Tests: `invite-wins-convergence.integration.test.ts` (pull adoption +
proposal retraction; unrelated-time remote still inserts; invite-confirm
adoption).

## Addendum (2026-07-25): closing the residual invite-twin gaps

Dogfooding still produced one-parsed-from-email + one-from-calendar twins.
Four gaps, four fixes:

1. **A failing invite probe fell through to the LLM.** When
   `inviteEventForMessage` threw (e.g. Google OAuth env missing on a dev
   box), the thread's inviteness was *unknown*, yet the code LLM-parsed it —
   the exact twin generator §3 exists to prevent — and then marked the
   thread extracted forever. Now a probe **error defers the thread**: no
   LLM, no marker, retried next pass once the API is back. (The probe also
   uses the newest message even when no body text is mirrored — a
   cancellation can be an ICS-only message.)
2. **±60 min was too narrow for LLM drift.** An email-parsed time can be
   hours off (timezone misread). Adoption + retraction now also match
   within **±12 h when the normalized titles match** (equality or
   containment — "test" vs "Invitation: test"); the bare-time ±60 min net
   stays for differently-titled twins. Same wide-net logic retracts, in the
   magics sweep, any **pending keyless proposal already covered by a real
   calendar event** (matching title, or a UID-keyed proposal whose UID is
   already on the calendar — the accepted-invite card self-clears).
3. **`METHOD:CANCEL` payloads parsed as importable events.** The parser
   skipped only `STATUS:CANCELLED` VEVENTs; a cancellation whose VEVENT
   lacks the STATUS line staged a brand-new event. `parseIcsBuffer` now
   surfaces `method` + `cancelledUids` (every VEVENT of a CANCEL calendar
   counts, per RFC 5546) and never emits them as events;
   `applyInviteCancellation` expires the UID-keyed pending proposal and
   cancels the owner's event copy (`local_dirty` so the cancel pushes).
4. **Invite `.ics` parts polluted the knowledge base.** ADR 0071's importer
   saved every invite as an `invite.ics` attachment. Calendar parts are now
   excluded from attachment import — the invite pipeline owns them.
5. **A Google-side DECLINE still added the event.** Google keeps declined
   events on the calendar (struck through) with event status 'confirmed' —
   the user's answer lives only in `attendees[self].responseStatus`. The
   pull now checks it (`selfDeclined`): a declined event never inserts, an
   existing local copy AND the keyless email-guessed twin are deleted, and
   the pending invite card (UID) + near-slot email proposals are retracted.
   A later re-accept arrives as a normal change and re-inserts.

## Addendum (2026-10-23): adopting a twin Chord already pushed

**Bug.** `findAdoptableEmailEventTwin` required `gcal_event_id IS NULL`,
reading a Google id as "this row has an identity of its own". But a
confirmed email event is pushed within seconds whenever the user has
calendar write access, and the push is what sets `gcal_event_id`. So by the
time the real invite arrived the twin was no longer adoptable: the pull
inserted the organizer's event beside it, the invite-email confirm created a
new row, and the user had two rows in Chord and two events in Google — the
outcome the 2026-07-18 addendum exists to prevent. A Google-side decline
likewise left the pushed twin standing. Found by reading the code, not yet
seen in prod.

**Decision.** A Google id that Chord itself put there (`chord_uid` set) does
not disqualify the twin. Adopting a pushed twin has two halves, and doing
only the first makes things worse:

1. **The row** takes the invite's identity, as before. On the pull it gets
   the organizer's Google id and drops our `chord_uid` (applyRemoteToLocal
   already writes the remote's, which is null). On the invite-email confirm
   with `alreadyInGoogle` it lets go of the calendar entirely — no Google
   id, no calendar, no `chord_uid`, `local_dirty = 0` — exactly the shape
   ADR 0103 gives a fresh accepted-invite row, so the pull later adopts the
   organizer's event onto it by UID. (The old confirm set `local_dirty = 1`,
   which for an unpushed twin pushed a Chord copy of the invite to Google:
   the rival copy ADR 0103 forbade. Fixed with it.) An `.ics` import without
   `alreadyInGoogle` is still ours and still pushes, which now patches
   Chord's existing copy instead of leaving it beside a second one.
2. **Chord's copy leaves the calendar.** `queueRemovalOfChordCopy` inserts a
   tombstone row (`deleted_at` set, `local_dirty = 1`) holding the copy's
   Google id and `chord_uid`; the next push deletes the copy and drops the
   row (the existing ADR 0040 delete path). A separate row because the twin
   row is being reused, and it keeps the `chord_uid` so a pull that lists the
   copy before the delete goes out finds the tombstone (push-local) instead
   of inserting it as a new event. No etag: the delete is unconditional — a
   copy touched in Google since still goes, because the invite replaced it
   (an etag mismatch is swallowed by the transport, which would quietly keep
   the copy forever). On the pull, the row update and the tombstone are one
   transaction. On a decline the pushed twin itself becomes the tombstone
   (`removeEmailTwin`); an unpushed one is deleted as before.

Also: a remote item carrying our own `chordUid` is never treated as an
invite for another email row, and a repeating twin (`series_id`) is not
adopted when pushed — one invite is one occurrence, while its Google copy is
the whole series.

**Consequences.** Between the adopt and the next push (the next sync pass,
at most `CALENDAR_SWEEP_MINUTES` with the sweep on) Google still shows
Chord's copy; Chord shows one row. The twin row keeps its id, so to-dos,
catch-up rows and description stay attached. A pushed email event that the
user had turned into their own meeting with guests (ADR 0157) and that a
separate invite then lands on would also be removed from Google; email
events are created without guests, and the provider holds the guest list
(ADR 0295), so Chord has no list of its own to check before deleting its
pushed copy; no guard was added. Not handled, same shape: an event made in chat (not from email)
that a later invite covers — ADR 0074 limits adoption to email-derived rows,
and ADR 0223 deliberately skips invites, so those still twin.

**Rejected.** Leaving Chord's copy on Google (two events there, and the next
pull re-inserts it as a second row because nothing holds its `chord_uid`);
deleting the copy with a direct provider call during the pull (needs the
copy's provider transport mid-pull and has no retry; the tombstone gets the
push's retry and give-up rules for free); patching the organizer's details
onto Chord's copy and ignoring the invite (the organizer's event is the one
whose changes and cancellations reach the user); keeping Chord's copy and
dropping the invite (the user accepted it in Google).
