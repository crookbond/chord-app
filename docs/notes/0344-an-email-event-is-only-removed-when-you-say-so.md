# 0344 - An email-made event is only removed when you say so

Date: 2026-11-16
Status: Accepted (narrows ADR 0074's "invite wins" addenda)

## Context

On 2026-11-16 John agreed a call with Ken (media.example) by email ("Tomorrow
at noon EST works perfectly"), confirmed Chord's card, and "Call with
Kenneth Lane", Tue 12:00-13:00 with Ken invited, went onto his Google
calendar at 15:46 UTC. At 19:17 UTC Google emailed Ken "Canceled event: Call
with Kenneth Lane". John had not cancelled anything.

The cause was ADR 0074's "invite wins" rule. At about 19:14 a colleague's
unrelated meeting ("RE: Brightstream AI respondent data ready", Tue
11:00-11:30, eight other people, none of them Ken) synced in from John's
neuralads Outlook calendar. `findAdoptableEmailEventTwin`
(`event-convergence.service.ts`) treated it as the real invite for the Ken
call because:

- the Ken event was made from an email (`source_raw_context = gmail:...`)
  and had no invite UID of its own;
- the two starts were exactly 60 minutes apart, and within 60 minutes the
  rule matched **whatever the title** (`gap <= INVITE_ADOPT_WINDOW_MS`);
- nothing looked at who was on either event.

The pull then took over Chord's Ken row (it now holds the Brightstream
meeting) and, through `queueRemovalOfChordCopy`, deleted Chord's Google copy
of the Ken event. Deleting a Google event that has guests sends them a
cancellation. Nobody was asked and Chord said nothing.

The same rule ran in two other places with the same effect: declining an
invite deleted any email-made event "near" it (`removeEmailTwin`, also a
Google delete with a cancellation), and accepting an invite card took the
email-made event over and deleted its Google copy.

ADR 0074 built this for a real case: a meeting agreed in plain email
followed by the other person's invite with a different title, which should
not become two events. That case is still real. What was wrong is that the
match was loose enough to hit an unrelated meeting, and that the action
(removing an event that may have guests) was taken without asking.

## Decision

**1. Time alone is not evidence.** An incoming calendar item counts as the
same meeting as an email-made event only when, besides being near in time:

- the titles match (equal or one inside the other), within 12 hours; or
- someone other than the user is on both, within 60 minutes. The incoming
  side is the item's organizer and guests; the email-made side is its guests
  plus everyone on the email thread it came from (from, to, cc). The user's
  own addresses (sign-in email and every connected mailbox) never count.

One rule, `sharesEvidence` in `event-convergence.service.ts`, used by
`findEmailEventTwin` (renamed from `findAdoptableEmailEventTwin`) and by
`retractPendingEmailEventProposalsNear`, so a pending email card is no
longer withdrawn by an unrelated meeting either. The email invite step
(`stageInviteIfInvite`) passes the invite's organizer and the invite
thread's people.

**2. Chord asks before it removes anything.** When an incoming item does
look like the same meeting, nothing is taken over or deleted:

- calendar sync: the item is added as its own event;
- declining it: the declined item is not added (unchanged), the
  email-made event stays;
- accepting the invite card: the invite's event is created as usual
  (ADR 0103 shape), the email-made event stays.

Then `askAboutEmailTwin` (`events/email-twin-question.ts`) posts a `system`
message in the user's personal chat (ADR 0281/0315 shape: no push, not
bridged, out of the model's history) naming both events, with an event card
for the email-made one and a pending `delete_event` proposal attached to the
message. The message says that removing it deletes it from the calendar and
that anyone invited gets a cancellation. Only a tap on that card removes it,
through the ordinary `delete_event` path. One question per event while one
is waiting.

`queueRemovalOfChordCopy` and `removeEmailTwin` are deleted: nothing removes
an email-made event without the user any more.

## Consequences

- Until the user answers, the calendar can hold both the email-made event
  and the real invite for the same meeting. This is the cost of asking, and
  it is the safe side: a duplicate is visible and fixable, a cancellation
  already sent to a guest is not.
- An invite with a different title and nobody in common with the email
  thread (for example sent by an assistant whose address never appeared in
  the email) is no longer recognised at all and is just added. Accepted for
  the same reason.
- A still-pending email card near an unrelated meeting stays pending
  instead of being withdrawn.
- The Ken row in production (`e_qHYYcRXVz-FY`) still holds the Brightstream
  meeting it was overwritten with. That is a real meeting on the user's
  calendar, so it is left as it is.

## Rejected

- **Only tightening the match.** The match is a guess either way; the
  action at the end of it can email strangers, so it needs a person's yes.
- **Keeping the takeover but deleting without notifying guests.** Leaves an
  orphaned invitation in the guests' calendars for a meeting Chord silently
  dropped.
- **Asking on time alone.** Would have asked "is Brightstream your call with
  Ken?" this morning; a question about every meeting within an hour of an
  email-made event is noise.
- **Matching people by display name.** Names are not identity (ADR 0065).
