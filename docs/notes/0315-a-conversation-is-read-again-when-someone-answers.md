# 0315 — A conversation is read again when someone answers

- Status: Accepted
- Date: 2026-11-01
- Amends: ADR 0110 (once-ever extraction marks), ADR 0180 (read-time `read` mark), ADR 0243 ("a thread is staged from once")

## Context

Prod, 2026-11-01, the "Catchup" thread with Irene:

1. Oct 30, from him: "Yes, next week?" The suggestion pass correctly staged
   "Reply to Irene with times that work for a call" and marked the
   thread as mined.
2. Oct 31, from the user: "How is anytime after 10 AM, Thursday, November 5."
   ADR 0314 closed the reply to-do.
3. Nov 1, from him: "10 AM works - talk then."

Step 3 settled a call, but no "Call with Irene" card appeared. The
suggestion pass reads a thread **once, ever**: `markThreadExtracted` inserts
an `email_extraction_marks` row, and the sweep's anti-join
(`extractionMarkQuery`) skips any thread that has one. Prod logs show no
suggestion pass on that thread after his reply. The read-time pass (ADR
0180) has the same once-per-thread mark. And even if it had re-read the
thread, `threadAlreadyProposed` refuses any second card from a thread
(ADR 0243).

Once-ever was designed for a message, which never changes. A conversation
does change. It is where a time gets proposed in one message and agreed in
another, and the agreement is the part worth turning into a calendar event.

## Decision

**A suggestion mark covers the conversation only as it was when the mark
was written.** A later message *from someone else* makes the thread
minable again (`markStillCurrent`, applied to the `magic` and `read` marks
in `extractionMarkQuery` and `crossAccountMarkQuery`). A message with
`internal_date` newer than the mark's `created_at` that is not `SENT`
reopens the thread. A re-read moves the mark forward (`doUpdateSet` on
conflict).

- **The user's own sent mail does not reopen a thread.** What you wrote is
  not something for you to act on. Without this rule, every reply you send
  would be mined as if someone had asked you something.
- **Person extraction keeps its once-ever mark** (ADR 0076). A fact does
  not go stale the way an ask does.
- **Staged once per message, not once per thread.** `threadAlreadyProposed`
  takes `since` (the newest message read), so only cards staged at or after
  that message count. The sweep and the read-time pass still cannot both
  stage for the same message.
- **A newer card withdraws the older pending ones.** When the re-read stages
  something, pending event, to-do and list cards from earlier messages in
  the thread are expired (`retractSupersededEmailProposals`, inside the
  staging lock). Confirmed cards and trip bundles are never touched. If the
  newer message stages nothing ("thanks!"), the older cards stay, because
  nothing replaced them.
- **The prompt names the shape.** A reply that accepts a time proposed
  earlier in the quoted conversation is an event on that date and time,
  titled by what the conversation is about. It is not a reply to-do.

The invite path (ADR 0074) still stages at most one card per thread. An
invite's UID is its identity, and a follow-up message about the same invite
is not a new invite.

## Consequences

- Threads that got a message from someone else after their mark, and are
  still minable (unread, or within ADR 0143's 7 days), are read once more
  after deploy. This is bounded by the sweep's per-tick limit. Each read
  costs one magics call (~4.5k tokens).
- A re-read may restate something the user already confirmed. Two things
  guard against that: the world block ("already on your calendar / to-dos")
  and the event/task dedup (`shouldStageEventProposal`,
  `shouldStageTaskProposal`, ADR 0223 / 0095).
- The mark records when the pass ran, not which message it read. A message
  that reaches Gmail just before a pass starts, but syncs after it, is
  covered by the mark and missed. The window is a single sync.
- Not retroactive for the Irene thread itself in a useful way: it is
  unread, so the next sweep after deploy reads his reply and stages the call.

## Addendum 2026-11-01: an agreed meeting invites the people it is with

"Call with Irene" belongs on his calendar too. The extractor now sees
a `Participants:` line (the newest message's From / To / Cc). On an event
that is a meeting **with** people on the email, it may set `invite`:
`"sender"` for a one-on-one, `"all"` for everyone on the email. It defaults
to `"sender"` unless the email makes clear the others are coming. It leaves
`invite` off for appointments, reservations, flights, school events and
anything else attended without these people.

**The model never writes an address.** `meetingInvitees` (kernel) builds
the list from the message headers. When your own message is the newest,
"sender" is the person you wrote to. It always drops your own addresses
(`ownAddresses`) and no-reply robots (`isNoReplyAddress`, now exported from
the ADR 0124 rule), dedupes, and caps the list at 20. The list rides on the
`create_event` card as `invitees`.

**Shown before, sent after.** The Action Items card and the card beside the
email read "Invites a@x.com, b@y.com". Nothing is sent until you confirm.
Confirming runs the ordinary `create_event` path (ADR 0157 / 0295), and
the guests are written to your Google or Outlook calendar, which sends the
invitations. The card never says the invites went out: with no calendar
connected, or a calendar that refuses, the event still saves and nobody is
invited (ADR 0295's "say only what happened").

**The personal chat says what happened.** Confirming such a card posts one
`system` message in the user's personal chat (ADR 0281's notice shape: no
push, not bridged, kept out of the model's history). It is written from the
calendar's own answer (`applyGuestChange` → `invited` / `alreadyInvited` /
`guestChange`): either "Added "Call with Irene" (Thu, Nov 5, 10:00 AM)
to your calendar and invited ...", or "... but no invitations went out:
<why>". Below it is a card linking to `/calendar?event=<id>`, which opens
that event in Chord's calendar for changing the time or the guests (the
ADR 0157 guest box). This is the same for Google and Outlook. A Google
`htmlLink` would only cover one provider and isn't known until after the
push. Posted only for an email card that carried guests: those are the
confirms that send something on the user's behalf.

Not built: removing individual names on the card before confirming. For
now it's all-or-nothing: confirm with everyone listed, or dismiss the card
and add the event by hand. Editing guests is a later card change.

## Rejected

- **Re-reading on any new message, including the user's.** Your own offer
  ("how is Thursday after 10?") is not a fixed slot. Mining it would stage
  guesses.
- **Clearing the mark when a message arrives.** That spreads the rule
  across every provider's sync path. A query predicate keeps it in one
  place, the ADR 0108 "predicate, not a sync" shape.
- **Keeping "staged from once" per thread and only re-reading.** The re-read
  would find the old card and stage nothing, so the fix would do nothing.
- **Withdrawing old cards even when the new message stages nothing.** "Got
  it, thanks" does not answer an open ask.
