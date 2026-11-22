# 0328 — A group event invites the family

**Status**: accepted (built behind `FAMILY_EVENT_INVITES`, off)
**Date**: 2026-11-10
**Amends**: ADR 0040 §7 (one copy per member), ADR 0232 (`share_event`),
ADR 0295 (who is notified on a push)

## Context

A shared-group event fans out as one `events` row per member (ADR 0040 §7).
Each row is pushed to that member's own calendar with that member's own login
(`createEvent`, `events.service.ts`). That puts the event on everyone's
calendar, but it is a direct write, not an invitation:

- **Nobody is told about a change.** When the organizer moves the event,
  `updateEvent` updates every row linked by `ical_uid` (ADR 0040 §9), and each
  row is pushed again. The time changes on each calendar and nothing else
  happens. No email goes out, because each copy is the member's own event, and
  no phone push either: the push publisher only acts on `SSE.message`
  (`push/push-publisher.ts:132`).
- **Nobody can answer.** There is no Yes/No for a member, and the organizer
  cannot see who is coming.
- **The copies need their own machinery.** Copies of one event on the same
  real calendar (spouses who both default to "Family") need a rule for which
  one writes it (`google/fanout-copies.ts`, ADR 0040 addendum). Guests on a
  fanned-out event were once sent by every member's push (ADR 0181).
- **`share_event` re-creates the event.** It makes a new event in the group
  and deletes the personal one, so it refuses an event with guests or a repeat
  rather than lose them.

Every member of a shared group is a Chord user, so in most cases Chord knows
an address where that person's calendar receives invitations.

## Decision

A shared-group event is the **organizer's event, with the family as guests**.
A member who cannot be invited keeps today's copy.

### 1. Who is invited, and at which address

For each member other than the organizer, the invitation address is the first
of these that exists:

1. the account of a calendar they connected to Chord: the Google sign-in
   address when it carries the calendar scope, an attached Gmail with a
   calendar (`gacct:`, ADR 0313), an Outlook mailbox with a calendar
   (`outlook:`, ADR 0228);
2. their Google sign-in address even without the calendar scope. Every Google
   account has a calendar, so the invitation lands there whether or not they
   connected it to Chord;
3. their Microsoft sign-in address (ADR 0293), for the same reason.

So yes, being in the group is enough: the group gives us the user, and the
user's account gives us the address. Never used: an Apple private-relay
address (mail reaches them, a calendar does not) and an address the user has
only as a contact. Managed personas (children without an account, ADR 0151)
have no address and stay Chord-only, as today.

A member with no usable address keeps **today's copy**: a row on their own
calendar, pushed with their login.

### 2. How the invitation is sent: from the organizer's calendar, else by mail

- **The organizer has a Google or Outlook calendar connected:** their own copy
  is pushed as today, carrying the invited members as `attendees` next to any
  real guests. The provider sends the invitations and updates and collects the
  answers; Chord reads them back (section 8).
- **The organizer has only a mailbox that can send (IMAP, or a second Gmail
  with no calendar):** Chord sends an iTIP `METHOD:REQUEST` (RFC 5546) with the
  `.ics` attached, from that mailbox, using the same send path
  `rsvp.service.ts` already uses for `METHOD:REPLY` (`sendRaw` / SMTP). Updates
  are a new `REQUEST` with `SEQUENCE` increased, and a cancellation is
  `METHOD:CANCEL`. The organizer's event lives in Chord only, which is already
  true for these users. Members' answers arrive as `METHOD:REPLY` mail in the
  organizer's mailbox; one whose UID is an event the organizer organizes in
  Chord records that guest's answer (section 8) and stages no card.
- **The organizer has neither:** nothing can send an invitation, so every
  member gets today's copy.

### 3. What Chord stores for an invited member

Every member still has their own `events` row, because Chord's calendar screen,
the briefing, the conflict check and free/busy all read events by owner. For an
invited member that row is Chord's own record and is **never pushed**: role
`attendee`, `local_dirty = 0`, no `google_calendar_id`, the same shape as an
accepted invitation (ADR 0103). The invitation reaches the member under the
organizer's provider event's UID, not Chord's key (a push never sends Chord's
`ical_uid` to Google, and Google gives its event its own), so the row stores
that UID in a new `invite_uid` column, and the pull matches on it instead of
creating a second row. The ADR 0074 invite path does not stage an RSVP card
for an invitation whose UID is a row's `invite_uid`.

### 4. Who is told about what

An update notifies the guests only when it changes the **time, the place, or
cancels** the event. A title or description edit is pushed with notifications
off. Today every push except a member's reflection notifies (ADR 0295,
`two-way-sync.service.ts`), so this narrows that rule for all events, not just
family ones. A deleted event now tells its guests too (Google's delete gets
`sendUpdates=all`; before, a cancellation reached nobody). Outlook has no
per-change switch: Graph sends an update for every organizer change, so on an
Outlook calendar a retitle still mails the guests.

### 5. Edits

Unchanged in substance. Only an edit to the organizer's event spreads to the
others (ADR 0040 §9), and an invited member's row follows that content without
being pushed. An edit a member makes to their own row in Chord changes only
that row, as before; for an invited member it is not pushed either. An edit a
member makes in their own Google calendar stays on their calendar, which is how
Google treats a guest.

### 6. `share_event` adds the family instead of re-creating

Sharing a personal event with a group moves the existing event: the row's
group becomes the target group, the members are added as guests (section 1),
and members who cannot be invited get a copy. Nothing is deleted and
re-created, so the event keeps its calendar, its guests and its video call, and
an event that already has guests can be shared. A repeating event, and one made
for a family member or someone else, still takes the ADR 0232 re-create, which
refuses repeats and events with guests.

### 7. What the user is told

The reply after `create_event` or `share_event` names who was invited and who
was only added to Chord, from what the provider or the send actually reported
(ADR 0102). It never says "invited" for someone who got a copy, and never for
someone whose invitation failed.

### 8. Who is coming

Each guest's answer is kept on the **organizer's** row
(`events.guest_answers`, a JSON list of `{ email, response }` in the calendar's
own words: `accepted`, `tentative`, `declined`, `needsAction`). Not on each
member's row: a member who declines in Google has their own row removed, since
Chord does not show a meeting someone said no to, and that "no" is exactly what
the organizer needs to see. Three writers, each reporting what a calendar or a
reply actually said:

- the organizer's calendar sync, from the provider event's attendees (Google
  and Outlook alike), whenever it pulls the organizer's own event;
- the guest change itself, so a just-invited guest shows as "not answered"
  before any sync runs; a mailed invitation does the same;
- a mailed iTIP `REPLY` (`parseIcsBuffer` now returns its `replies`), for an
  organizer whose invitations went by mail.

The guests endpoint returns them as `answers`, read from the organizer's copy
whichever copy is asked about, each named when Chord knows the address (a
member invited at it, an account signed in with it, a person the viewer
saved). The event editor shows Yes / Maybe / No / Not answered beside each
guest, and a member's own copy lists them read only. The bot's context gives
each event's answers, so "who's coming to dinner?" is answered from them.

### 9. Answering from inside Chord

An invited member answers Yes / Maybe / No in the event sheet ("Going?", drawn
only when the guests response carries `myInvite`), or in chat with
`answer_invitation { eventId?, eventTitle?, response }`. Both call
`answerFamilyInvite` (`services/events/answer-invite.ts`, route
`POST /api/v1/events/:id/answer`).

- **It travels the way any invitation is answered** (ADR 0104
  `respondToInvite`): on the member's own calendar when it holds the
  invitation, else an iTIP `REPLY` mailed to the organizer, from the address
  they were invited at (`RsvpInput.accountId` names an attached mailbox when
  that is not their sign-in address).
- **Recorded only after it went out.** "Who is coming" never shows an answer
  the organizer's calendar did not get; a failed send records nothing and says
  why (`no_route`: nothing connected can carry it; `send_failed`).
- **A "no" removes the member's own row**, as a decline in Google does; the
  organizer's copy keeps the "no".
- The bot's context lists the asker's waiting invitations ("Invitations
  waiting for you", with ids and their answer so far), and attendance phrases
  load the calendar tools, so "count me in" / "I can't make it" reach
  `answer_invitation` for those events and `record_rsvp` for anything else.
- Only an invited member's row can be answered; a copy (a member Chord could
  not invite) has no invitation behind it.

### Not changing

- Members who share one calendar with the organizer (the "Family" calendar)
  may see the event twice: the organizer's event on that calendar and the
  invitation on their own primary. Accepted by the owner.
- Google may hold an invitation from a sender it does not know until it is
  answered (ADR 0103). Accepted by the owner; family members usually know each
  other.
- Existing group events keep their copies. Nothing is migrated.
- One new bot tool, `answer_invitation` (section 9); `create_event` and
  `share_event` change behaviour.
- A repeating group event still gives every member a copy: a series carries no
  invitations yet.
- Ships behind `FAMILY_EVENT_INVITES` (default off) until a two-account test
  against a live Google and a live Outlook calendar has passed.

## Build

- Migration `143`: `events.invite_email`, `invite_via` (`calendar` | `mail`),
  `invite_uid`, `guest_notice_due` (set by `updateEvent` when the time or
  place changes; the push notifies only then or on a delete, and clears it),
  and `guest_answers` (section 8, `services/events/guest-answers.ts`).
- `services/events/invite-plan.ts` picks each member's address and how the
  organizer can send; `services/events/family-invites.ts` sends (a guest change
  through `changeEventGuests`, ADR 0295, or an iTIP mail built by
  `buildItipRequestMime`) and mails updates and cancellations;
  `family-invite-tracker.ts` holds the outcome for the bot turn.
- `createEvent` writes invited rows unpushed and starts the invitations after
  commit; `moveEventIntoGroup` is the `share_event` move.
- When an invitation cannot go out (no provider event, a refused write, a
  failed send, or a transaction with nothing to start the work after commit),
  the rows become ordinary copies on each member's own calendar and are pushed.
- The bot turn waits for the invitations before adding named guests, since
  both rewrite the event's guest list.

## Consequences

- A change to a family event reaches everyone as an update email, and the
  organizer sees who is coming.
- Members are invited at the address of their calendar, so the event lands on
  their primary calendar, not the default they picked in Chord (ADR 0232). That
  is the provider's choice and is accepted.
- An organizer with an IMAP mailbox can now send invitations. Chord becomes
  the organizer's calendar server for those events: it must keep `SEQUENCE`
  right and read the replies, and an update mailed before an earlier one
  arrives must not reorder (receivers compare `SEQUENCE`).
- The one-writer-per-shared-calendar rule (`fanout-copies.ts`) and the
  per-member push become the fallback path, used only for members who cannot
  be invited.

## Alternatives rejected

- **Keep copies and send a Chord push or chat note on change.** Tells members
  inside Chord only, gives them no way to answer, and keeps all the copy
  machinery.
- **Invite everyone, no copies at all.** Leaves children and members with no
  usable address without the event.
- **Invite only when the organizer has a calendar.** Leaves IMAP-only
  organizers with silent copies, when iTIP mail already works from those
  mailboxes for replies.
- **Notify on every update.** A typo fix would email the whole family.
- **Send to the sign-in email whatever it is.** An Apple relay address forwards
  the mail but puts nothing on a calendar.
