# 0104 — An invitation is answered, not filed

**Status**: accepted
**Date**: 2026-08-24
**Relation**: completes [0103](./0103-an-invitation-is-not-ours-to-file.md), which
stopped Chord publishing a rival copy but left the invitation unanswered;
borrows [0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)'s posture
that a failure says so rather than looking like success.

## Context

ADR 0103 stopped Chord pushing an invite-derived event to Google. That removed
the duplicate and replaced it with something worse: confirming an invitation in
Chord recorded it **in Chord only**. The meeting sat somewhere the user does not
look, the organizer learned nothing, and the Google calendar — the thing they
actually check — stayed empty. The owner's words: *"it should go to google, not
chord. and we should RSVP correctly, else we are just confusing the user."*

That is the right reading of 0103's own finding. Two different questions were
being asked and both got a yes:

- Google asks **"do you want to accept this?"**
- Chord asked **"shall I add this event?"**

Only the first one puts the meeting on the calendar, because accepting is what
*makes* Google place it. Chord was answering the wrong question.

## The constraint

The Calendar API has **no RSVP endpoint**. The documented way to respond is to
patch your own entry in an event's `attendees` array, which requires addressing
the event at `calendars/<cal>/events/<id>`.

That works whenever Google already put the invitation on the calendar — the
default. It does not work in the case that produced 0103. Google's own
documentation: an invitation from a sender it is unsure of *"isn't added to
their calendar until they click Add to calendar or they RSVP to the event."* So
the event we would have to patch does not exist until the RSVP it is meant to
carry has already happened.

The way out is the protocol Gmail's own Yes/Maybe/No buttons use: an iTIP
`METHOD:REPLY` (RFC 5546) mailed to the organizer. It does not care what state
the calendar is in.

## Decision

**Patch when we can, mail when we cannot.** `respondToInvite` looks the
invitation up by UID across the user's calendars (`events.list?iCalUID=`, the
only way from an emailed UID to an API id). Found → patch `attendees`, with
`sendUpdates=all` so it reaches the organizer rather than being a private note.
Not found, or the patch fails → send the iTIP REPLY. Most invitations cost no
email.

The whole `attendees` array goes back on the patch: Google *replaces* it, so
sending only our row would un-invite everyone else.

**The card asks the invitation's question.** Yes / Maybe / No, wired to
`POST /proposals/:id/rsvp` — the wire values are `accepted` / `tentative` /
`declined`, the iCalendar PARTSTAT names, so nothing has to translate between
Google, iTIP and us. An invitation also loses the ADR 0097 group-routing chips:
what is being decided is one person's RSVP, and it is not routable.

**The organizer is answered first, and only then is anything recorded.** A
decline resolves the suggestion and creates nothing. An accept or tentative
creates the local row (still `alreadyInGoogle`, so 0103's no-push rule holds),
which the pull adopts when Google places the real event. **If the RSVP fails the
proposal stays pending** and the row says why — an invitation that still needs a
reply has to keep looking like one.

**An answer given anywhere is an answer everywhere.** The pull already retracted
by UID on a decline; it now does the same when the user's `responseStatus` is
anything other than `needsAction`, so answering in Gmail or the Calendar app
clears the Chord card. `needsAction` deliberately does not retract — that
invitation really is still waiting, and its card is one of the places it can be
answered from.

## Consequences

- Chord now sends mail as the user in one narrow case. It is a fixed, generated
  iTIP reply to the invitation's organizer, never free text and never to anyone
  else — but it is an outward-facing action and was the user's call, not ours.
- The reply carries **no DTSTART**. A REPLY that restates the time is how a
  reply ends up "correcting" a meeting nobody asked us to change; the organizer
  owns the event and only needs to know who is coming.
- `ParsedIcsEvent` gains `organizer`, because the iTIP fallback needs the
  address precisely when the calendar lookup cannot supply it. The email sender
  is not a substitute — an invitation can be relayed by a robot address.
- A user with no Google connection gets a clear row-level failure rather than a
  dead button.

## Alternatives rejected

**Patch only, no email.** Simple and sends nothing — and fails in exactly the
case that prompted the work, leaving us back at a Chord-only row.

**Always send the iTIP reply.** One code path, and the organizer always hears.
But it spends an email from the user's account on every invitation, including
the majority a silent patch handles.

**`events.import` the invitation onto the calendar, then patch it.** Gets the
event onto the calendar, but the docs describe it as adding *a private copy* —
the organizer would never learn the answer. That is half an RSVP, and the half
that matters least.

**Confirm-means-accept, with dismiss for everything else.** Smaller change, but
"no" is a real answer an invitation asks for, and leaving it out means the one
case where telling the organizer matters most still requires opening Gmail.

## Addendum 2026-10-16: every surface answers, not just one

The Yes / Maybe / No route was the only place that told the organizer. The
docked card inside the email thread still said "Add to calendar" and called the
plain confirm, as did the feeds, a chat "yes" and a Telegram tap - so the same
invitation was added to Chord while the organizer kept seeing "no response".

Fixed at the choke point instead of per screen: `confirmProposal` sends an
`accepted` reply (`respondToInvite`) before recording anything when the proposal
is an invitation (`inviteArgsOf`: `create_event` + `alreadyInGoogle` +
`externalUid`). A reply that cannot be sent fails the confirm and leaves the
proposal pending, as the RSVP route already did. The RSVP route passes
`inviteAnswered: true` so the user's real choice (Maybe, Yes) is not followed by
a second "accepted". The email card shows Yes / Maybe / No for an invitation
(`EmailMagicSuggestion.isInvite`).

Dismiss (the x) is still not "No": it hides the suggestion and tells nobody.
Answering never archives or trashes the email; it only clears UNREAD, as before.

## Addendum 2026-11-10: the invitation is the only card

Prod: Mark Clark invited the user to a Thursday call. The user's own
"Accepted:" reply (Outlook, Sent) was read as ordinary mail, the model staged
"Introductory Meeting with Mark Clark" with Mark as guest, and confirming
it put a second event on the calendar and sent Mark an invitation to his own
meeting. Three changes:

- **Outlook**: Graph types an invitation `eventMessageRequest` and an
  accept/decline/tentative reply `eventMessageResponse`; the probe matched only
  the base `eventMessage`, so both read as plain mail
  (`isGraphEventMessageType`). A response is now handled with nothing staged.
- **.ics answers** (`METHOD:REPLY` / `COUNTER` / `DECLINECOUNTER`) are handled
  with no event, so an answer to a meeting never stages an RSVP card for it.
- **Whole thread**: the invite read looks at the newest message only. When
  any message in the thread carries an iTIP `.ics`, or the thread already has
  a card from an invitation (any status), the model's events and RSVP-style
  to-dos are dropped (`threadHoldsInvite`, `answersTheInvite`, in
  `extractAndStage`, so the sweep and opening an email both apply it).

Not covered: an Outlook thread where an earlier message was the invitation
but no card was staged from it (Graph keeps no `.ics` we store), and the
duplicate check (ADR 0223) still treats two titles for one slot as two
meetings.

## Addendum 2026-11-19: who an answer goes to

Prod 2026-11-18: accepting an invitation that came to an Outlook mailbox
failed three times with `no_organizer`, and nothing was logged. The Graph
probe asked for `iCalUId, subject, start, end, location, isAllDay` and never
`organizer`, so every Outlook invitation card had nobody to answer. When the
mailbox's own calendar could not carry the answer (ADR 0228 off, or the
meeting not on it yet), the emailed REPLY had no address.

- The probe now selects `organizer` and stores it on the card.
- Who the answer goes to, in order: the invitation's organizer, then the
  calendar event's, then **the email's sender, when that is a person**. This
  narrows the rule above that the sender is no substitute: a relay is still
  never answered. Only the newest message someone else sent counts. It is
  refused when it is the user's own address, a no-reply address, a calendar
  or mail robot (`calendar@`, `invitations@`, `notifications@`, `events@`,
  `scheduling@`), or anything at `calendar.google.com`. A robot there means
  `no_organizer`, never an older sender. This is what answers the cards
  already staged without an organizer.
- Every refused answer is logged with its reason, from `respondToInvite`, so
  the route and the confirm path both report it.
