# ADR 0295 — Guests live on the calendar

**Status:** Accepted, 2026-10-24
**Amends:** ADR 0157 (where guests are kept and how they are sent), ADR 0181
(organizer copy only — kept)

## Context

ADR 0157 let the bot invite guests. Chord kept its own guest list
(`event_attendees`, keyed on the event's `ical_uid`) and re-sent the whole
list on every push. Reading the code on 2026-10-23 found four ways this went
wrong; tests reproduce them:

1. **A second guest un-invited the first.** The first push replaced the
   event's placeholder `ical_uid` with Google's (`markPushed`), so the list
   could no longer be found. A later "also invite Priya" wrote only Priya and
   the push sent `attendees: [priya]`. Google replaces the whole array on a
   patch, so Kevin was removed.
2. **A time change told nobody.** The push found no guests, so it sent no
   `sendUpdates=all`.
3. **A guest removed in Google came back.** Whenever Chord could still find
   its list, the next push re-sent it, re-adding and re-mailing the person.
   (Masked by 1 on the old code; it shows once the key is kept, as PR #142
   does.)
4. **A guest added to an event made in Google was never sent, and the bot
   said "invited".** A pulled event is stored as an attendee copy, and the
   push only sent guests from organizer copies.

There was also no way to remove a guest.

All of these come from keeping a second copy of something the calendar
already keeps: Google and Outlook store the guest list, send the
invitations and track the answers.

## Decision

**Chord keeps no guest list. Adding or removing a guest is a call to the
provider** (`services/events/guests.service.ts`, `changeEventGuests`):

1. Find the organizer's copy. On a member's copy of someone else's group
   event (ADR 0181) the guests belong to the organizer, so only they can
   change them; anyone else gets `not_organizer`.
2. Make sure the event is on the provider: wait for the background push
   started this turn (`waitForBackgroundPush`), push once more if needed.
   Still not there (no calendar connected, or the push failed) →
   `not_on_calendar`.
3. Read the event from the provider. If the provider says someone else
   organizes it (`organizer.self === false`) → `not_organizer`.
4. Change the attendee list (`nextAttendees`: everyone the provider lists,
   sent back unchanged with their answers, minus the removed, plus the added)
   and patch it with notifications on. Store the new etag so Chord's next edit
   is not refused as stale.

**The push never sends `attendees`.** A patch without the field leaves the
provider's list exactly as it is, including changes made in Google. Every
patch of an event that is not a member's reflection asks the provider to
notify (`sendUpdates=all`), so guests hear about a time change; with no guests
nobody is mailed. A member's reflection never notifies (ADR 0181).

**The bot says only what the provider took.** `create_event` / `update_event`
report `invited` / `removedGuests` from the provider's answer. On a failure the
summary says "NOBODY was invited or removed" with the reason
(`not_organizer`, `not_on_calendar`, `provider_error`) and tells the model
not to claim the change. `update_event` gains `removeInvitees` (emails or
names, resolved like `invitees`).

**Outlook works the same way.** Graph's full event read already carries
`attendees` and `isOrganizer`; `graphEventToResource` now maps them, and an
empty list is sent (it is how the last guest comes off). Graph mails the
guests itself.

`share_event`'s "has guests" check reads the provider (`providerGuestEmails`);
one it cannot read counts as no guests, since the event was made moments ago.

`event_attendees` is no longer written for guests. Existing rows stay (the
table also holds the old `rsvps` backfill) and nothing reads them for
guests; the guests they name are already on the provider events.

## Consequences

- A guest change costs one read and one patch to the provider, at the moment
  it is asked for. No background state, no migration.
- Inviting needs a connected calendar. Without one the bot says so instead of
  saving a list that goes nowhere.
- Chord cannot list an event's guests without asking the provider; nothing in
  the app shows them today.
- An update now notifies whenever the event has guests, as a calendar app
  does. Chord used to notify only when it was sending its own list.
- The guest change and the event's own push are ordered by waiting for the
  background push first; across two processes they could still interleave,
  and the etag check plus last-writer-wins (ADR 0040) settles it.

## Rejected

- **Keep the list, key it on the event row id** (the first version of this
  ADR): fixes 1 and 2, needs a migration, leaves 3 and 4, and still needs a
  merge with the provider's list on every patch.
- **Keep the list and sync it both ways with the provider**: a second copy of
  the provider's data with its own conflict rules, for no gain.
- **Let any group member invite through the organizer's calendar**: mails
  people in the organizer's name without them asking.
