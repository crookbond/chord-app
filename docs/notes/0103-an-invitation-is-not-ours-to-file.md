# 0103 — An invitation is not ours to file

**Status**: accepted
**Date**: 2026-08-24
**Relation**: corrects an assumption in
[0074](./0074-timezone-anchoring-and-invite-reconciliation.md)'s "invite wins"
addendum; the calendar-sync sibling of
[0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md), found in the
same prod session.

## Context

Sharon sent a calendar invite. Chord did everything ADR 0074 asks: parsed the
`.ics` deterministically, staged a `create_event` proposal keyed on the invite's
RFC-5545 UID, and waited for a human yes. The user confirmed. Half an hour later
the calendar held **two** copies of the meeting.

```
20:46:32  organizer creates the meeting; invite email sent
20:49:27  Chord stages prop_… with externalUid = 760peq…@google.com
20:51:45  user confirms → e_n0-Rdtdjj95K created
20:51:45  Chord PUSHES it → family calendar mints 2pecei…,
          and the push response overwrites ical_uid with 2pecei…@google.com
20:56:34  user accepts the invite in Google
21:25:31  pull sees 760peq… on the primary calendar, matches nothing,
          inserts e_Eb_eqy4Dt3er
```

The obvious reading is that the dedup failed, and the obvious fix is a better
match. Both are wrong.

**Google had not yet put the invite on the calendar.** An invitation from a
sender Google is unsure about does not appear until the user answers it — and
the logs show it: pull passes ran at 20:46:32, 20:51:44, 20:51:53 and 20:53:16
and inserted nothing, while the pass at 21:25:31, the first after the accept,
inserted immediately. So at confirm time there was genuinely nothing in Google
to dedup against. `findEventByExternalUid`, `findOwnedEventByIcalUid` and
`findAdoptableEmailEventTwin` all ran, all behaved correctly, and all found
nothing, because nothing existed yet.

No amount of matching closes that window. It is bounded by how long a human
takes to click Accept.

The actual mistake is upstream of matching. Two different questions were asked
and both got a yes:

- Google asked **"do you want to accept this?"**
- Chord asked **"shall I add this event?"**

Saying yes to Chord created a Chord-owned event and pushed a **new** Google
event. It did not RSVP to the organizer. Two yeses, two events — and the second
one is a real event on a real calendar, not just a stray row.

The push is also what broke the reconcile that should have caught it later:
`markPushed` stamps `ical_uid` from the push response, so the invite UID was
overwritten with Google's UID for *our* copy and survived only in
`external_uid` — the one column `findLocalCopy` does not consult for a bare UID,
though the create side consults both.

## Decision

**An event derived from a calendar invite is recorded, never published.**
`createEvent` takes `alreadyInGoogle`, set only by the invite path in
`magics.service.ts`. Such a row is `local_dirty = 0`, carries no `chord_uid`,
fires no push, and **claims no `google_calendar_id`** — Google decides where an
accepted invite lands, so naming a calendar would be a guess, and a claimed
calendar also blocks the pull from adopting the row later.

The flag is explicit rather than inferred, and it is stripped from the schema
the model sees (ADR 0102's `INTERNAL_TOOL_FIELDS`). **The UID shape cannot carry
this**: an imported `.ics` also has a bare RFC-5545 UID, and that calendar
really does exist only in Chord, so it must still push.

**`findLocalCopy` gains the missing arm and loses its cross-calendar reach.**
It now also matches `external_uid = remote.iCalUID`, so a row whose `ical_uid`
was overwritten by an earlier push still reconciles. Every key except
`chord_uid` is scoped to `google_calendar_id = <this calendar> OR IS NULL` —
see below.

**A per-item failure no longer ends the pass.** `reconcileOne` is called inside
a try/catch and a throw increments a new `PullResult.failed`.

**A push Google has rejected stops being re-sent.** A 4xx other than 408/429
leaves `local_dirty = 0`; the row stays visible in Chord marked `error`, and any
later local edit re-arms it.

## The two bugs the same session found underneath

Both were live in prod and neither is about invites.

**The family calendar had stopped syncing entirely.** Every pull failed with
`duplicate key value violates unique constraint "uq_events_gcal_event"`.
`findLocalCopy` matched `ical_uid` with no calendar scope, and the same logical
event subscribed on two calendars — a school feed the family calendar also
carries — gives both copies one `ical_uid`. Pulling calendar B matched calendar
A's row, and `applyRemoteToLocal` tried to move it onto a `(calendar, event)`
pair A's sibling already held. Because the violation escaped the per-item work,
it aborted the whole loop, every pass, silently.

**One event had been retrying since June.** Created 18 June, `local_dirty = 1`,
`gcal_last_error = 'events.insert 400'`, re-sent on every sync pass for over two
months. The catch restored the dirty flag unconditionally, so "retry" had no
exit.

## Consequences

- Confirming an invite in Chord no longer puts it on a Google calendar. If the
  user never RSVPs, the event lives in Chord alone. That is the honest state —
  they have not accepted the meeting — but it is a visible behaviour change.
- The remaining gap is the one this ADR does not close: **the card should offer
  an RSVP, not "add to calendar."** Then one yes answers the organizer, Google
  places the event, and Chord adopts it on the next pull. Not built; it needs
  the Google RSVP write and a card that can say yes/no/maybe.
- `PullResult.failed` is new. A non-zero value means the calendar synced
  *partially* — worth surfacing, since the previous behaviour (die on the first
  bad item) at least failed loudly in the log.
- Rows already in the bad state are not repaired by any of this. The prod pair
  was cleaned by hand.

## Alternatives rejected

**Match harder on the create side.** The invite is not in Google yet; there is
nothing to match. This is the alternative that looks right and cannot work.

**Infer "already in Google" from the UID.** An `.ics` import carries the same
shape of UID and must still push. Guessing here trades a duplicate for a
calendar entry that silently never syncs.

**Keep pushing but delete our copy when the invite arrives.** Requires a
Google-side delete on every adopt, and leaves a window where the user sees two
events. Not creating the second one is strictly simpler.

**Scope `chord_uid` to the calendar like the other keys.** `chord_uid` is our
own stamp on an event we pushed; it identifies the row wherever Google has since
moved it. Scoping it would break exactly the case it exists for.
