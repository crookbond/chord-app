# 0346 - A meeting is followed from the first email to the invite

Date: 2026-11-17
Status: Accepted (amends ADR 0074, 0104, 0197, 0223, 0244, 0315, 0344)

## Context

On 2026-11-17 Rob wrote "I am mostly free tomorrow from 10-1. Anything work
for you?" and the Suggested reply said "I am also free 10-1" over a
12:00-12:50 meeting. The parser fix for that one email shipped on its own; an
audit of every path that turns scheduling mail into calendar actions found
the problem was the shape, not the parser:

- **A conflict was any overlap in time.** `computeConflicts`,
  `busyIntervalsInWindow` and `eventsClash` never ask who an event is with.
  "The same meeting seen twice" and "two meetings at once" were separated
  only by the ADR 0223 / 0344 duplicate rules, each with its own idea of
  "same", and the conflict nudge ran after the event already existed.
- **The invite card never read the calendar.** Yes / Maybe / No showed with
  no conflict and no recommended answer (`stageInviteIfInvite`,
  `respondToInvite`).
- **Nothing followed a meeting across its emails.** Each email was read on
  its own. Offered slots were not kept. The user's own reply ("Tuesday 10
  works") was never read (ADR 0315 reopens a thread only for other people's
  messages), so agreeing to a time by email put nothing on the calendar, and
  a second meeting could be booked into the same slot.
- **Nobody decided who sends the invite.** No rule covered "I'll send an
  invite", an assistant scheduling for someone, the user on Cc only, or a
  Zoom link already in the email. The only guard against a twin was ADR
  0344's question, after both copies existed.

## Decision

### 1. One relation between a meeting and an event

`meetingRelation` (kernel `meeting-relation.ts`) compares a new or proposed
meeting with an existing event and answers one of:

| Result | When | Chord does |
|---|---|---|
| `same` | Identity: same invite UID, the event belongs to this email thread, or the event is the one this meeting record already points at. Or: the times largely overlap (75% of the shorter one) AND (they share MORE than half the CORE people of the smaller list - all of them when it has one or two - or the titles match, a title names someone on the other side, with no core person contradicting it) | Merge / take over; never a conflict |
| `related` | Touches the meeting's start or end (a prep before it, a debrief after), overlapping at most half the shorter one, and shares a core person or is titled prep / pre- / debrief / sync before | Not a conflict; shown as "Prep for ..." |
| `conflict` | Times overlap, no core person in common, titles unrelated | Shown to the user only |
| `unsure` | Anything between: one shared person at a partly overlapping time, a matching title with different people | Ask once ("Is X the same meeting as Y?"), remember the pair |
| `personal_block` | The existing event has no guests (gym, school pickup) | Ask whether it can move; remember for that event or series |
| `none` | No overlap, or the existing event is free / all-day / 5 min or less / someone else's travel (ADR 0289) | Nothing |

**Core people** are the user, the person being scheduled with, and the
principal an assistant writes for. **Not core**: assistants, Cc'd onlookers,
rooms and other resources, mailing lists, and the user's own addresses. A
missing assistant or an extra colleague never makes two events different.

Exact attendee equality was considered and rejected by the owner ("we need
flex"): an organizer adds colleagues, an assistant drops off the invite. The
cut-offs (half the core people, "largely overlap") are tuned against the
eval set of real threads, not guessed.

Merging only happens on `same`; anything uncertain asks (ADR 0344's rule:
never fold or remove on a guess). The older duplicate rules (ADR 0223's
`samePeople`, ADR 0344's `sharesEvidence`) become callers of the same
relation over time rather than separate copies.

### 2. Conflicts cross calendars; events never do

- The conflict check reads every calendar the user has (Google, Outlook,
  second Gmail, the phone mirror) together. A work meeting can clash with a
  family event.
- A conflict is shown **to the user only**: on their invite card and in
  their own chat. A drafted decline says "I have a conflict then", never
  what the conflict is. Group chats and other members' briefings never see
  it.
- **An event never crosses calendars.** A meeting stays on the calendar of
  the mailbox it came from (ADR 0312). A hold, an invite takeover or a merge
  never moves or copies an event to another calendar. The same meeting on
  two of the user's calendars is two entries; they are `same`, so not a
  conflict, and not merged.

### 3. The invite card says what the calendar says

The invite card (ADR 0104) carries a verdict from section 1:

- free: Yes is the highlighted answer;
- conflict: "Overlaps *Lunch with Sam*, 12:00-12:50", Maybe / No highlighted,
  plus **Decline and suggest a time**, which drafts a reply offering free
  work-hours slots (ADR 0330) without naming the conflict;
- same meeting already on the calendar: "Already on your calendar"; Yes takes
  it over;
- outside work hours or away (ADR 0245, 0330): a note.

### 4. A scheduling block, read in the same call

The email suggestion pass returns an optional `scheduling` block beside its
cards (the ADR 0135/0138 side-channel shape, no new model call):
what the email does (`offer_slots`, `ask_times`, `agree`, `counter`,
`reschedule`, `cancel`, `fyi`), who is writing (`principal`, `assistant` +
for whom, `me`), who will send the invite (`them`, `me`, `unknown`, with the
evidence), format (`in_person` + place, `video` + provider + whether a link
is present, `phone` + number), the offered and agreed slots, the meeting
title (what the meeting is FOR, never the email subject), and the core
people. Dates and times are still read by `mentionedSlots` in code; the
model only says which are on offer. How the user is addressed (To, Cc only,
a list) is decided from the headers.

### 5. A meeting record per scheduling thread

`meetings` holds the participants, title, format, offered slots, agreed
slot, who sends, state and the links to its hold, invite and event. State:
`offered -> proposed -> agreed -> invited -> answered`, and `cancelled`.

The user's own sent reply is now read **for the scheduling block only**,
never for cards (a narrow reversal of ADR 0315's "own mail never reopens"):
that is how "Tuesday 10 works for me" becomes `agreed`.

An invite is matched to its meeting by the meeting, not by attendees: the
organizer is on the other side (them, their assistant, their principal), the
time is the agreed slot (or near it, shown as changed), and the core people
are on it. Extra or dropped non-core people (an assistant) change nothing.

### 6. Holds live in Chord only

When a meeting is `agreed` and the other side sends the invite, Chord keeps
a **hold**: on the user's personal calendar **in Chord only**. Never pushed
to Google or Outlook, never on a work calendar, never an invitation, never
visible to family members. It blocks Chord's own free-time checks (reply
drafts, email suggestions, `get_my_availability`, `/plan`) and counts as a
soft conflict. The briefing says "Waiting on Rob's invite for Tue 10:00".
When the invite arrives the hold is deleted (not moved). If none arrives in
the expiry window, Chord asks whether to send one.

### 7. Who sends, and in what format

| Situation | Chord does |
|---|---|
| They said they will send, or an assistant schedules for their principal | Never sends; holds and waits |
| They asked the user to send, or the user asked for the meeting | A "Send invite" card with the core people; their assistant optional |
| Unknown | The card asks "Send Rob an invite, or wait for his?" (owner decision) |
| User on Cc only | Nothing, unless named, asked directly, or a guest on the .ics |

Format: a link already in the email goes on the event and no Meet/Teams is
added; no link and the user sends = the calendar's default provider (ADR
0319/0323) only when the email said call or video; in person = location,
checked against travel days (ADR 0245); phone = the number.

Invitations are still sent only on the user's tap (ADR 0009).

### Built: phase 1

- `meetingRelation` + `corePeople` + `titlesAlike` in kernel
  `meeting-relation.ts`; `recommendedRsvp` and the "Suggest another time"
  instruction in kernel `calendar-fit.ts`.
- `busyEventsInWindow` (`conflicts.service.ts`) is the one busy rule;
  `busyIntervalsInWindow` now maps it, so the card counts busy exactly as
  `find_conflicts` and the reply drafter do.
- `calendarFitFor` (`events/calendar-fit.service.ts`) computes
  `Proposal.fit` / `EmailMagicSuggestion.fit` when the card is READ (the ADR
  0343 shape: the calendar changes after staging). An event's people are its
  pulled `guest_emails` plus everyone on the email thread it was made from;
  an invitation Outlook already placed on the calendar is skipped (it is the
  invitation, not a twin or a conflict).
- Answers: `POST /api/v1/proposals/:id/overlap` and the personal-only
  `answer_calendar_question` bot tool, both through `recordOverlapAnswer`,
  which checks the card is asking that question now. Stored in
  `users.defaults` `meeting_overlap_answers` (`pair:<meeting>|<event>`,
  `block:<series or event>`, newest 500).
- Cards: `CalendarFitNote` on the card beside the email and the Action Items
  row; the recommended RSVP gets a ring; "Suggest another time" drafts the
  reply through ADR 0197 (`openDraftedReply`) and opens it, nothing sent.
  The drafter sees free / busy only, never event titles, so it cannot name
  the conflict.

### Built: phase 2

- The extractor's reply may carry `scheduling` (kernel `scheduling.ts`:
  `readSchedulingBlock` shape-checks it, anything malformed is `unknown`).
  The prompt names the key at the top as well as describing it at the end:
  described only at the end, the live model never emitted it.
- `finishScheduling` (`email/scheduling-block.ts`) finishes it in code:
  quoted times through `mentionedSlots` from the message's sent day; a join
  link in the body (`eventJoinLinks`) makes the format `video`; assistant
  names become header addresses (`notCore`); `addressed` from the headers.
  Two corrections the eval needed, both deterministic: `ask_times` with a
  time in the message's own text (not the quoted history) is `offer_slots`
  ("free tomorrow from 10-1, anything work?"); on Cc only (or not
  addressed) the act is `fyi` unless the pass kept an ask of the user's
  own from the same email (the cards' `askedOf` rule).
- Stored sealed in `email_threads.scheduling_json` (migration `151`,
  encryption backfill list); nothing reads it yet.
- Eval: `scheduling-block.live.test.ts` (Rob's window, an assistant who will
  send the invite, "can you send an invite? Zoom is fine", an in-person
  coffee, a Cc-only thread, a booking confirmation), 6/6 on two runs.

### Built: phase 3

- `meetings` (migration `152`), one row per (user, thread): state, core
  people and assistants (`not_core`) as plaintext addresses, `invite_by`,
  agreed start/end, `invite_uid`, and the sealed `facts_json` (title,
  format, place, link, offered and agreed slots as quoted).
- `nextMeetingState` (kernel) is the whole transition rule: cancel cancels
  an existing meeting; fyi moves nothing; an agreement whose time could not
  be read moves nothing; once invited only a cancellation or a newly agreed
  time moves it; otherwise the writer's side decides offered / proposed.
- `recordMeetingFromEmail` runs after every scheduling block. Core people
  accumulate from From / To / Cc minus the user and the assistants. "Who
  sends" is read from the recipient's side, so on the user's own message it
  swaps ("I will send an invite" written by the user = the user sends).
- `runOwnReplyScheduling` (after the suggestion pass, same entitlement gate)
  reads the newest SENT, non-draft message on a thread whose meeting is
  offered / proposed / agreed, through the SAME extractor and prompt, keeps
  only its scheduling block (its cards are discarded), at most 5 per pass,
  never the same message twice (`read_through`); a refused model stops the
  pass and leaves the message for later.
- `linkInviteToMeeting` runs in the invite path (ADR 0074): organizer on
  the other side, every core person on it, on the agreed day (or a day on
  offer); exactly one fit or none. An invite's cancellation cancels it.
- The card verdict uses it: an invitation linked to a meeting is `same` as
  an event made from that meeting's thread (`relatedThreadKeys`), and the
  assistants of the user's meetings are never core (`meetingAssistants`),
  so an assistant on both events does not make them one meeting.
- Not done: a mailbox disconnect (ADR 0312) does not remove the meetings
  its threads made; the Google pull does not link an invite that never
  came by email.

### Built: phase 4

- A hold is READ off the meeting record, never stored as an event
  (`events/holds.service.ts` `activeHolds`): state `agreed`, the invite not
  the user's to send (`them` or `unknown`), the slot still ahead, touched
  within `HOLD_DAYS` (7), not dropped, and no event made from the thread.
  So it goes by itself when the invitation links (state `invited`) or the
  event exists, and nothing about it can reach a provider or a family
  member.
- `busyIntervalsInWindow` adds holds, so every free-time check Chord makes
  (reply drafts, the suggestion pass's free times, `get_my_availability`,
  `/plan`) treats the slot as busy. `busyEventsInWindow` (events only) does
  not: `find_conflicts` and the conflict nudge are about the calendar.
- The card verdict lists another meeting's hold as `held` (soft: shown,
  bookable); the hold of the meeting the card is FOR is not a conflict.
- Briefing: a code-printed "⏳ Waiting on invites" section
  (`renderWaitingSection`), after the retired to-dos.
- `GET /api/v1/me/holds`, `DELETE /api/v1/me/holds/:meetingId` and the
  personal-only `meeting_holds { drop? }` tool through one `dropHold`
  (`meetings.hold_dropped_at`, migration `153`; the meeting is left as it
  is). The Calendar screen lists holds above the grid with Stop holding.
- Not done: a lapsed hold asking "send the invite yourself?" (phase 5).

### Built: phase 5

- `meetingCardPlan` (kernel) is the one rule for a meeting's event card,
  from the user's side: their side sends (or an assistant arranges it and
  nobody said otherwise) = no card, the slot is held; unknown = the card
  carries `whoSends: 'ask'`; a link already in the email is the location and
  no video call is added; a call with no link, the user sending = the
  calendar's own video call (`videoCall`, ADR 0319); a place or number is
  the location.
- Applied in the suggestion pass to an event the model marked as a meeting
  with people on the email (`invite`), and by `stageMeetingCards` (after the
  own-reply pass) for an agreement reached in the user's own reply, and for
  a hold that lapsed ("Kim's invite never came", the user's call). Once per
  agreement: any event card on the thread since the meeting last changed
  stops another, a dismissed one included. Same staging lock and
  past/duplicate guards as every email card.
- "Wait for theirs": `waitForTheirInvite` dismisses the card and records
  their side sends, so the slot is held. Card button, `POST
  /api/v1/proposals/:id/wait-for-invite`, and the `wait_for_invite` chat
  tool. Sending is the card's own tap (ADR 0009); chat never sends.
- While nobody has said who sends, the agreed slot is held too.

### Built: phase 6

- `meetingReplyNote` (kernel) tells the reply drafter, beside the
  instruction, what Chord's record of the thread says: an agreed time not to
  reopen, who sends the invite (never offer when they said they would), an
  assistant to write to, the link already in the thread, in person and where.
- A reply drafted in a meeting's own thread does not see that meeting's hold
  as busy (`exceptThreadKey` through `userAvailability` to
  `busyIntervalsInWindow`); everywhere else it does.

### Built: phase 7 - several people, several times

The first six phases kept only the newest offer (each message replaced the
last) and the drafter checked only the newest message's times, so with
three people offering different times only the last one counted.

- Each person's offers are kept separately on the meeting
  (`MeetingFacts.offers`, inside the sealed `facts_json`, no migration):
  newest message per person replaces only theirs; an assistant's offer is
  their principal's (the one core person their name or domain points to);
  times one person passes on for another ("Sam can do Tuesday") count as
  that person's (`others`, names turned into header addresses only when
  exactly one fits). The user's own messages add no offers.
- The scheduling block gains `unavailable` ("I can't do Wednesday") and
  `others`; the prompt says offers are the WRITER's own and a reply never
  repeats the times it quotes.
- `commonTimes` (kernel `common-times.ts`): each person's offers as
  intervals on their own clock (a time with no end lasts the meeting; a day
  with no time is 8:00-18:00 their time), minus what they cannot do; someone
  who only said what they cannot do still narrows it; intersected, at least
  the meeting's length, nothing in the past. None in common = the stretch
  the most people can make, naming who it does not suit. `waiting` = core
  people who have not answered.
- Cc'd people are onlookers until they speak (only From / To join the core
  people); this also tightens phase 3's invite match, which required every
  core person on the invitation.
- In a group, one person agreeing is not the group agreeing: `agreed`
  needs every core person's offers to contain the agreed slot. A group the
  USER arranges (they send, or they put times to everyone) is agreed by
  `promoteGroupAgreements` once everyone has answered and exactly one time
  suits all; two or more common times stay the user's choice.
- The reply drafter (`groupTimesFor`): with two or more people's offers its
  "times asked about" are the COMMON times (checked by the usual FREE /
  BUSY verdicts) instead of the newest person's, and a note says who they
  suit, who has not answered (never said to have agreed), or that nothing
  suits everyone and which time most can make.
- Briefing: "Waiting on Kim to answer the times for Planning sync".
- Eval: three more live cases (a refusal beside an offer, times passed on
  for others, a reply quoting earlier times), 9/9 on two runs.

## Alternatives considered

- **Exact attendee match for "same".** Rejected by the owner: assistants
  drop off, organizers add people.
- **Time-only conflicts, people only for dedup.** Today's behaviour; it is
  what the corner cases came from.
- **Holds pushed as tentative events.** Rejected by the owner: other people
  would see the user as busy for a meeting that may not happen.
- **A separate model call per scheduling email.** The suggestion pass already
  reads the email; one more block is a few output tokens.
- **Auto-sending invites once a time is agreed.** Breaks ADR 0009; the card
  asks.

## Consequences

- Built in phases, each useful alone: (1) the relation + the invite card's
  verdict, (2) the scheduling block, stored only, (3) the meeting record and
  reading the user's sent replies, (4) holds and the briefing line, (5) who
  sends + format, (6) the reply composer reads the meeting.
- Two places now decide "same meeting": the relation and ADR 0223's merge at
  create. They must not disagree; the merge moves onto the relation.
- A hold is not an event: anything that lists events (search, `find_events`,
  the phone mirror) does not see holds unless it asks for them.
- The scheduling block is model output and can be wrong; it never sends or
  deletes anything by itself.
