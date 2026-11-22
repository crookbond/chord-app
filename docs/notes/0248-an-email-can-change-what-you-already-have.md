# 0248 — An email can change what you already have

**Status**: accepted
**Date**: 2026-10-15

## Context

The email that prompted this, from the New York Athletic Club:

> You have successfully cancelled out of a reservation made via the New York
> Athletic Club reservation system. Court: Singles 3 / Squash Singles. Date:
> Friday, October 16th 2026. Time: 05:30 PM to 06:15 PM.

It has no calendar file and it is not travel. So it reached neither the invite
path (ADR 0074, keyed on a UID) nor the trip path (ADR 0168, hotels and
flights). The cancelled event stayed on the calendar. If only a pending
"add event" card existed, the pass could even propose a NEW event for the
cancelled slot.

The first version of this ADR added a `cancelled` kind and matched the booking
by hand-written rules: a start within 15 minutes, and either a shared title
word or the same sender. The question that followed was how to handle a
rescheduled booking, and then everything else of the same shape: a bill
marked paid, a class moved, a form received. Each would need its own kind and
more rules. The rules were the weak part. Matching "NYAC court booking" to
"Squash Singles 3" is exactly what the model is good at and code is not.

Owner decisions that still hold: nothing already on the calendar or in the
to-dos is changed without a tap, and Chord says in the personal chat what it
found.

## Decision

**Code picks the candidates, the model names one, code checks the answer, and
the user confirms a card.** This one mechanism replaces the `cancelled` kind
and its matcher.

### 1. The model sees a labelled list of the user's real items

The world block the extractor already received (ADR 0088) now labels each line
that came from a row: `e1 calendar: …` for events, `t1 to-do: …` for to-dos,
and `p1 suggested event (not yet accepted): …` for pending email suggestions
(`formatLabelledWorld`, `email/magics-context.ts`).

- The label maps back to the row in code. No id reaches the prompt.
- Trips stay unlabelled; their changes stay with ADR 0168.
- For each email, up to 6 more events are added that the batch's soonest-first
  list may have cut (`loadThreadEvents`): the user's events on any day the
  email names (`mentionedDays`), and upcoming events that came from an email
  by the same sender domain.
- The email's own pending suggestion is left out of its list.
- The 2,000-character cap stays. Only labels whose line fits the cap can be
  named.

### 2. One new item kind, `change`

```
{"kind":"change","target":"e3","action":"remove"|"move"|"done"|"drop",
 "startsAt","endsAt" (move, event),"dueAt" (move, to-do),"why":"a few words from the email"}
```

The model emits a change only when the email itself says a listed item is
called off, moved, finished or paid. The target must be a label copied from
the block. A change can sit beside new items: "moved to Saturday, bring a
towel" is a move plus a list.

Something cancelled that is not in the list gets nothing, and never an event
for the cancelled slot. Something rescheduled that is not in the list may be
an event at its new time.

Changes sit outside the card cap (ADR 0243), at most 4 per email and one per
target. An advisory still stands alone, so a message that looks like a scam
changes nothing. New times get the same handling as an event's (the offset of
that date, and the `.ics` year).

### 3. Code checks every change, and drops what fails

The checks are in `applyEmailChanges` (`email/email-changes.service.ts`).
Each skip is logged with its reason:

| Reason | When |
|---|---|
| `unknown_label` | The label is not in this email's map, so the model invented it. |
| `wrong_action` | The action does not fit the item: events take remove/move; to-dos take done/drop/move; suggestions take remove/move. |
| `gone` | Re-read before staging, the event is not the user's or is deleted or cancelled, the to-do is done or archived or in a group the user left, or the suggestion is no longer pending. |
| `past` | The event's own start, or the new time, is already over. A confirm runs with no turn, so ADR 0100's guard would not catch it. |
| `bad_time` | A move without a readable new time. |
| `card_exists` | A pending change card from any email, or any card from this email (so a dismissed card is not offered again). |

### 4. What each change does

| Target | remove | move | done / drop |
|---|---|---|---|
| calendar event (`e#`) | card: `delete_event` (scope `this` for an occurrence) | card: `update_event` at the new time; length kept when no end is given | — |
| to-do (`t#`) | — | card: `update_task` with the new `dueAt` | card: `complete_task` (`drop: true` for drop) |
| pending suggestion (`p#`) | withdrawn at once (it was only a suggestion) | withdrawn, and offered again at the new time, under its own email | — |

- **The cards**: proposals with provenance set to the changing email's thread.
  - Display-only fields are hidden from the model's schema
    (`INTERNAL_TOOL_FIELDS`): `eventTitle` and `eventStartsAt` on the event
    tools, `taskTitle` on the task tools.
  - Confirming runs the ordinary tool. So a removal deletes the event in
    Google and retires the booking's to-dos (ADR 0192), and a move pushes the
    new time.
  - An event card lasts until the earlier of the old and new times, at least
    an hour and at most 72 hours. A to-do card lasts 72 hours.
- **The chat note**: one line in the personal chat per email that staged a
  card or withdrew a suggestion. It is `email_change_notice`, built from
  stored data with no LLM call, goes stale after 2 hours, and is not gated on
  billing. Example: `An email from New York Athletic Club: "Squash Singles 3"
  on Fri, Oct 16 at 5:30 PM was cancelled. Tap Apply in Action Items to
  update.`
- **The staging lock**: both passes reach this through `extractAndStage`,
  under the per-thread staging lock (ADR 0244).
- **Where the cards show**:
  - Action Items, labelled "Remove from calendar: …", "Move: …", "Mark done:
    …", "No longer needed: …" or "New due date: …", with no group chips: a
    change applies to the item where it already is.
  - Beside the changing email, as `EmailMagicSuggestion.kind` `change` with an
    Apply button.
  - Not in the briefing or the decision feeds, which rank things to add.
- **Logs**: `email change staged` and `email change skipped` with reasons, and
  `email change resolved` on confirm or dismiss. Rejected rows are pruned
  after 15 days (ADR 0226), so accept and dismiss rates live in the logs.

## Verified

- **Integration tests** (`email-changes.integration.test.ts`). The stub reads
  the labelled block it is given, so the real labelling is exercised:
  - The NYAC cancellation becomes a removal card. Confirming it deletes the
    event and archives its to-do.
  - A move becomes a move card with the length kept. Confirming moves the
    event, and a list beside the move still stages.
  - "Payment received" becomes a mark-done card, and confirming completes the
    to-do.
  - A pending suggestion is withdrawn when cancelled, and re-offered at the
    new time under its own email when moved.
  - An invented label, an action that does not fit, and a past new time each
    stage nothing; so does an event already over.
  - A weekly booking loses one occurrence.
  - A second run, or a run after a dismissal, stages nothing more.
  - The label map holds no ids and carries an event on a day the email names
    that the batch list cut.
  - With the change step switched off, the five tests that go through the
    pass fail.
- **The real model** (local config), on 12 real-shaped emails against a fixed
  labelled list (`server/scripts/eval-email-changes.ts`, run on every prompt
  change), passed 12/12 twice:
  - cancellation;
  - reschedule (two cases);
  - bill paid;
  - slip received;
  - pool change with the same time (no change);
  - class cancelled this week;
  - cancellation of a suggestion not yet accepted;
  - a cancellation of something not listed (the model invented `e5`, the
    check dropped it, nothing staged);
  - an unrelated newsletter on the same day (no change);
  - a new booking (still an add);
  - a move plus things to bring.

  The first run failed on the slip; the "done" rule now says that the sender
  confirming receipt counts.

## Not in scope

- Flights and hotels: ADR 0168 (trip cancellations) is unchanged.
- Trip reservations: `trip_reservations` has no changed state.
- Emails already read before this shipped: their extraction mark never
  re-fires.
- Changing a title or place without a time: the actions are remove, move,
  done and drop.

## Rejected

- **The rule matcher of this ADR's first version** (15 minutes plus a shared
  word or sender): it needs another rule for every new shape, and it is the
  weak part.
- **Letting the model name a row by id, or by title**: an id in the prompt is
  one waiting to be invented. A title is ambiguous. A short label from a
  bounded list is checkable.
- **Changing the item without a tap**: owner decision. A wrong match would
  remove a real event, possibly from the family's calendars.
- **One kind per shape** (`cancelled`, `moved`, `paid`, …): the same
  mechanism four times, and the next shape still missing.
- **Showing change cards in the briefing and decision feeds**: they rank
  things to add; the chat note and the dock already reach the user.

**Addendum 2026-10-23 (a change that changes nothing).** Prod: an email about a school trivia night produced "moved to Fri, Oct 23 at 4:00 PM" three times with three Apply cards; every copy was already at 4:00 PM, and two were the school's subscribed feed (once via Google, once via the phone). `applyEmailChanges` now skips a move to the time the item already has (`unchanged`, for events, to-dos and pending suggestions, compared as instants) and any event on a calendar the user can only read (`read_only`: a `reader`/`freeBusyReader` source, found from `google_calendar_id` or the `gcal:`/`device:` key), since an edit there is overwritten by the next pull and the feed moves itself. Two writable copies still each get a card, but the chat note says a sentence once.

**Addendum 2026-10-27 (no chat note).** The owner found the chat note useless: the email is already in the user's mail, and the card in Action Items and beside the email is the actionable part, so a chat line saying "Open Action Items to apply it" only repeats both (prod: "An email from Luma: \"IIT Delhi Alumni Mixer: NEW YORK\" on Tue, Oct 27 at 5:30 PM was cancelled"). `applyEmailChanges` no longer queues `email_change_notice`; `enqueueEmailChangeNotice` and the `fromEmail`/`fromName` arguments are gone. The renderer and the proactive kind stay so a note already queued before deploy still goes out (it goes stale after 2 hours). Cards, the dock and logging are unchanged.
