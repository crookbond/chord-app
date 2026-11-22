# 0343 - A new booking from the same place may replace the old one, so the card asks

Date: 2026-11-16
Status: Accepted (extends ADR 0248, ADR 0312)

## Context

Westside Veterinary Center moved a dog's appointment from Mon 11/16 9:00 to
Mon 11/23 12:20. The email Chord received was the clinic's ordinary booking
confirmation (AppointMaster, "Please make a note of your new appointment ...
This is to confirm that we have booked the following appointment ...
11/23/2026 at 12:20 PM for MERLI K with Dr. Rosenthal"). It never mentions
11/16, "rescheduled" or "instead of".

The suggestion pass staged a `create_event` for 11/23, the user confirmed it,
and the 11/16 event stayed. The user then moved 11/16 by hand and was left
with two events on 11/23.

ADR 0248 already handles a move, but only when the email says so: the model
names a listed item (`e1`) and Chord stages an `update_event` card. Run on the
production model with the 11/16 event listed as `e1`, the real email gave a
new event 3 times out of 3, and an email that said "rescheduled from 11/16"
gave the move 3 times out of 3. The model was right to read the real email
as a booking, because nothing in it says otherwise. A clinic system sends the
same template for a new visit and for a changed one, so this is not one
clinic's quirk.

Chord does know something the email does not say: the user already has an
upcoming event from the same sender for the same dog.

## Decision

**When an email suggests a new event and the same sender already has one
upcoming event for the same subject, the card asks whether the new one
replaces it.** It shows *"Replaces Vet Appointment for MERLI K, Mon 11/16
9:00 AM?"* with two choices, **Move it** and **Add as new**, and ✓ waits for
one. Move it updates the existing event to the new time and adds nothing.
Add as new is today's behaviour.

The offer is decided in code, with no model call (`email/replace-offer.ts`,
`replaceOffersFor`). An event qualifies when all of these hold:

- it is the user's own (`owner_user_id`), not deleted, not cancelled, not
  part of a repeating series, and not on a calendar the user can only read;
- it has not started yet;
- it was made from an email whose sender is on the same domain as this
  email's sender;
- it starts at a different time from the suggestion, within 90 days of it;
- its title and the suggestion's share a word that names the subject: three
  letters or more, not a generic booking word ("appointment", "visit",
  "vet", "dentist", "with" ...), and not a word from the sender's own name
  or domain. "Vet Appointment for MERLI K - Annual Wellness" and "Vet
  Appointment for MERLI K with Dr. Rosenthal" share *merli*; two dogs at the
  same clinic, or two children at the same dentist, share nothing and get no
  offer.

Exactly one such event gives an offer; none or several give a plain card.
Several is ambiguous, and asking which one is a bigger question than this
card has room for.

**Computed when the card is read, not when it is staged** (like the calendar
choice in ADR 0312), so an event deleted or moved in the meantime is never
offered. Confirm takes `replaceEventId`; the server works the offer out again
for that proposal and refuses (`replace_unavailable`, 409) unless it names
the same event, so a stale card or a made-up id cannot move an arbitrary
event. The move runs as an ordinary `update_event` in the event's own group,
through the same executor as ADR 0248's move card, with the email's
provenance: it keeps the event's length when the suggestion gives no end,
pushes to the calendar the event is on, and leaves ADR 0162's "Changed by
email" note.

Shown on the Action Items row and on the card beside the email
(`Proposal.replaces`, `EmailMagicSuggestion.replaces`). The offline answer
queue (ADR 0311) carries the choice.

## Consequences

- A rescheduled booking that arrives as a plain confirmation is one tap to
  move, and nothing is moved without that tap.
- The AI view feeds and the urgent strip do not show the choice; ✓ there
  still adds a new event. Most email events are confirmed from Action Items
  or beside the email.
- An event the user typed in themselves has no sender, so it is never
  offered. The sender-domain check is what keeps the offer from guessing.
- No chat tool is needed: moving an event is already `update_event`, and the
  offer only appears on a card.

## Rejected

- **Telling the model a same-sender booking probably replaces the old one.**
  It would turn real second appointments into moves without asking.
- **Matching on the title alone, without the sender.** "Annual checkup"
  from two different doctors would be offered as a replacement.
- **Deciding at staging and storing it on the proposal.** The event can move
  or go before the card is answered.
- **Moving automatically when the match is strong.** The email does not say
  it replaces anything; only the user knows.
