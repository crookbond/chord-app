# ADR 0347 — A meeting goes where its people are

**Status:** Accepted, 2026-11-17
**Amends:** ADR 0100 (past dates), ADR 0182/0232/0256 (calendar choice), ADR 0346 (scheduling block)

## What happened

Prod, 17 November 2026. A user with three calendars — the Google login's,
a work Outlook set as the default, and an attached RudderStack Gmail — had
agreed a call with Arthur by email, in the RudderStack mailbox:

- the user: "In NYC. how is noon est tomorrow? Or anytime between 2-4p est?"
- Arthur: "2:00 works, I am in Seattle so 11:00 PST."

No card came. The user went to chat:

1. "From Rudderstack calendar - send a calendar invite for 2p EST to arthur@optizent.com. add google meet" (at 4:33 PM)
2. "On Rudderstack Calendar- add to calendar invite for 2p EST add google meet"
3. "For tomorrow"

That made three meetings and sent Arthur three invitations:

| Message | Event | Calendar | Call |
|---|---|---|---|
| 1 | today 2 PM (already over) | Outlook | none (Meet asked on Outlook) |
| 2 | today 2 PM | RudderStack | Google Meet |
| 3 | tomorrow 2 PM | Outlook | Teams |

## Causes

Every one of them decided something from the words of one message, never
from who the meeting was with.

- **The card.** "2:00 works" names no day; nothing tied it to the offer it
  answered, so the meeting never counted as agreed (`proposed`, no card).
  The user's own offered times, quoted under Arthur's reply, were stored as
  Arthur's offer and replaced the user's. And the model said Arthur would send the
  invite with nothing in his email saying so; "they send" means no card on
  purpose (ADR 0346 phase 5). The user's own "Sending a calendar shortly",
  read nine minutes later, left it at "them".
- **The date reader** missed "2-4p est": a date ("tomorrow") went to the one
  nearest time only, and lower-case "est" was not a zone.
- **The calendar.** The model never passed `calendar`. The fallback read the
  name only after "to/on/in/into/onto", so "From Rudderstack calendar" fell
  to the default.
- **The past.** ADR 0100 refuses only a day already gone; 2 PM earlier today
  passed, with an invitation.
- **The repeats.** Tool results do not survive a turn (ADR 0093/0166), so on
  messages 2 and 3 the model had no event to point at, and moving an event to
  another calendar was not possible at all.

## Decision

**One rule: a meeting goes where its people are.** The people on a meeting
are the strongest evidence for where it belongs, what it is the same as and
when it is; phrasing is the weakest.

### Email

- **An acceptance picks from what was offered.** A dateless "2:00 works" is
  matched against the other side's offered windows, each clock time tried in
  both halves of the day and on its own zone (`acceptedOffer`,
  `mentionedClockTimes`); exactly one moment, or nothing.
- **A time is the writer's only in the writer's own words.** A phrase found
  only in the quoted history is dropped from the writer's offers; a phrase
  with no date takes the date said earlier on its line.
- **Who sends must be said in this email.** The model's "them"/"me" is kept
  only when the message's own words (not the quoted history) talk about the
  invite at all (`INVITE_WORDS`: invite, calendar, send, book, ...). Asked
  against the live model: for Arthur's "2:00 works, I am in Seattle so 11:00
  PST" it answered "them" and cited those very words as its evidence, so a
  quote is not proof; and when it is right ("Can you send an invite?") it
  often gives no quote, so a required quote loses right answers. Reading the
  message is what works on both. Otherwise unknown, and the card asks "send,
  or wait for theirs?". The prompt is unchanged: two rewordings tried
  against the live model ("writer"/"recipient", and telling it that agreeing a
  time says nothing about who sends) each made it answer "unknown" for an
  assistant who said she would send the invite.
- **Date reader:** each run of times takes the nearest date within reach (a
  date can hold several runs), and a lower-case US zone directly after a time
  is a zone.

### Chat

- **Which calendar** (`events/calendar-choice.ts`), in order: a calendar the
  model named; a calendar the user's recent words name (every tail of the
  words before "calendar", checked against the user's own calendars, so the
  list decides, not the grammar); the mailbox the user writes to these guests
  from (ADR 0312's rule for email cards, applied to chat), and where that does
  not settle it, the calendar their earlier meetings with them are on; a kind
  of call only
  some calendars host (a Meet needs Google); with guests and still more than
  one mailbox calendar, **ask** (`reason: which_calendar`), since the guests
  see the sending address; otherwise the default.
- **Names count too.** An invitee given by name ("invite Arthur") is turned
  into an address by the same resolver that sends the invitation (People,
  Chord contacts, the phone), now run once BEFORE the calendar is chosen, so
  the name is evidence of where the meeting belongs.
- **The same meeting again.** The event a chat just made is recorded
  (`bot_pending_state` kind `last_event`, 2 hours) and named in the next
  turn's prompt. A `create_event` from a later message with a guest in common
  or the same title is refused once (`reason: same_meeting`, with its id) and
  the model is told to `update_event` it; asked once, so a real second meeting
  goes through after the user says so.
- **Moving calendars.** `update_event` takes `calendar`: the event is made
  again through `create_event` on that calendar (same guests, a call if it had
  one; the calendar, invitation and past rules all apply) and the old one is
  removed, so guests get one cancellation and one invitation. Repeating events
  are refused.
- **A meeting with guests or a call must start in the future**, to the
  minute (`hasStarted`), on create and on a reschedule. ADR 0100's day rule is
  unchanged for everything else ("lunch at noon" typed at 2pm still records).

## Rejected

- More phrasings in the name finder (prepositions, abbreviations): the next
  phrasing breaks it again. The closed list of the user's calendars decides.
- Silently turning a repeated `create_event` into an update: a wrong guess
  edits a meeting the user did not mean; refusing once with the id is visible.
- Asking for the calendar on every event: only when there are guests (the
  sending address matters) and nothing else answers it.
- Renaming "them"/"me" to "writer"/"recipient", or adding a prompt rule:
  both made the live model worse on the assistant case (see above).
- Requiring the model's `inviteEvidence` quote: it cites the wrong words when
  wrong and none when right.

## Not covered

- The ADR 0223 same-event merge still has its own "same" rule.
- A chat event and an email meeting record are not linked yet (the meeting
  record could supply the agreed time to chat).
