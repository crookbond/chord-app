# Release notes

User-facing summary per release. Newest first. See `docs/notes/` for the
underlying ADRs and technical rationale.

## 2026-09-11

**Trips now build themselves from your inbox.** Booking a hotel or flight on
Expedia or Booking.com? Chord reads the confirmation email — even when
there's no PDF attached — and proposes the whole trip (flights, hotels,
dates) for you to approve. Train tickets work too. Approved trips carry the
confirmation number, booking reference, and a one-tap link back to the
original email, right on the calendar event.

**Invite people to events by name or email.** Ask to add an event and invite
someone — Chord resolves who you mean from your contacts or people you've
emailed before, sends them a real calendar invite, and asks you to pick from
Contacts if it can't tell who you meant.

**Booked for someone else? You still get the trip, plus a heads-up.** Chord
proposes the flight/hotel to your calendar exactly as it would for your own
booking — and when the passenger isn't you, it separately offers to add them
as a person in your family, instead of quietly assuming you were the
traveler.

**Your inbox gets worked on continuously**, not just when you open the app
or check the morning briefing — trip, task, and people suggestions now
appear within a few minutes of the email arriving, any time of day.

**Stale reminders stop showing up.** Past-dated tasks and trips no longer
linger in your to-do list after the date's gone — including ones that were
already sitting there when this shipped.

**Receipts get tracked automatically**, showing up as settled purchases in
your Money Stuff view — never confused with a bill you still owe or a
refund coming back.

**Fixed:** a calendar you only subscribe to (not one you own) was
incorrectly triggering "you're double-booked" warnings.
