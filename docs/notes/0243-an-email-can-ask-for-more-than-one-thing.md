# ADR 0243 — An email can ask for more than one thing

**Status:** Accepted (2026-10-12)
**Amends:** [0137](./0137-a-proactive-message-is-not-always-the-briefing.md)
(the one-suggestion-per-thread invariant), [0063](./0063-billing-and-model-routing.md)
**Related:** [0110](./0110-the-ai-passes-must-be-shown-the-email.md),
[0132](./0132-a-to-do-is-not-a-list-item.md),
[0180](./0180-a-read-email-earns-its-own-pass.md),
[0187](./0187-a-confirmed-suggestion-does-not-get-a-second-chance.md)

## Context

The email suggestion pass returned at most one suggestion per thread. That was
never argued for. The first extractor prompt said "extract ONE actionable
item", and later work was built on top of it:

- ADR 0137's duplicate guard (`threadAlreadyProposed`) refused a second
  proposal of the same tool from the same thread, on the stated ground that a
  thread yields one suggestion.
- The extractor's return type was one suggestion or null; deliveries, flights
  and receipts were added as side blocks to keep it that way.
- The reply was capped at 300 tokens.

Nothing told the model which item to pick when an email held several, so the
choice was arbitrary. Three things made that worse:

- A thread is mined once, ever (the `magic` extraction mark), so whatever was
  not picked was never looked at again.
- The model sees the first 2,000 characters unless it asks for the whole
  message, and it was told to ask only when one detail was cut off.
- A list suggestion carried a single entry, so "bring cupcakes, napkins and
  juice" became one of the three.

A school note with a form due Friday, a picture day and a bake-sale request
produced one card.

## Decision

**The extractor returns every separate actionable item in the email, soonest
first, up to `EMAIL_MAGICS_MAX_ITEMS` (default 4).**

1. **Reply shape.** `{"items":[…]}`, each entry one of the existing kinds. A
   list entry carries `items: string[]`. The delivery, flight, receipt and
   `needMore` keys stay on the reply object beside `items`. A bare suggestion
   object (the old shape) is still read.
2. **What counts as separate** is stated in the prompt: each item must pass
   every existing rule on its own; one obligation is never split into steps;
   the same thing is never emitted in two shapes; entries for one list go in
   one list item. Most emails still yield one or none.
3. **Which ones, when there are too many.** The prompt orders by what comes
   due first, undated last, and keeps the soonest. The server keeps the first
   N in the order given (`capSuggestions`). The cap counts cards: each event,
   each to-do, each distinct list. A list holds at most 12 entries.
4. **One proposal per list.** Entries for the same list (by `listNameKey`,
   ADR 0094) are staged as a single `add_list_item` proposal.
5. **An advisory stands alone** (ADR 0180). If any item is an advisory,
   nothing else from that email is staged. This is enforced in
   `capSuggestions`, not left to the prompt.
6. **A thread is staged from once.** `threadAlreadyProposed` is now asked
   without a tool: if the thread already has a pending or confirmed proposal of
   any kind, a later pass stages nothing. ADR 0137's guard was "one per tool",
   which with several to-dos per thread would let a re-mine add a reworded
   copy of the second or third. Rejected and expired proposals still do not
   count (ADR 0187).
7. **Long emails.** `needMore` may also be set when the visible text stops
   partway through a run of separate dated items. The deep-read budget is
   unchanged.
8. **Reply cap** 300 → 600 tokens (about 2,400 characters).

`EmailExtractor.extract` returns `EmailSuggestion | EmailSuggestion[] | null`,
so every existing stub still compiles.

## Consequences

- A long email can now produce up to four cards. Bulk mail is mostly kept out
  of this pass already (ADR 0127), and the on-the-hook rule (ADR 0179) applies
  to each item.
- Opening an email that the background pass already produced cards for no
  longer adds a card. Before, the read-time pass (ADR 0180) could add one of a
  different kind. An email the background pass produced nothing for is
  unaffected.
- A thread with an invite or trip proposal (same `gmail:` provenance) also
  gets nothing more from a later read-time pass. Before, it could get a
  stray `create_event` beside a trip bundle.
- Threads already mined keep their single suggestion; marks are not cleared
  (ADR 0110's reason: the mark is what stops re-proposing rejected items).
- Output tokens per call can roughly double on a multi-item email. Input
  tokens grow by the longer prompt only.
- `EMAIL_MAGICS_MAX_ITEMS=1` restores one card per email.

## Addendum 2026-10-12 — first run against a real model

A four-part email ("I agree, lets meet for lunch tomorrow at 2p. lets also set
time for next week Monday at 4p. … please email Alice to set Ben's doctor
appointment. and email Alice if she is free at 3p tomorrow?") was run through
`llmExtractor` on gpt-4.1-mini and gpt-5.4-mini
(`magics-multi-item.live.test.ts`, skipped unless `MAGICS_LIVE=1`). The
envelope worked; three readings did not, and the prompt now states each:

- **A time the sender states or agrees to is a fixed slot, and each is its own
  event.** gpt-5.4-mini read both times as unconfirmed and folded them into one
  "reply about lunch and Monday" to-do. This loosens the older rule that a
  meeting request with no confirmed slot is a reply to-do: that rule now covers
  only requests with no specific slot ("when are you free?", a choice of
  times). The card is still the user's confirmation.
- **Asking the recipient to contact a third person is its own to-do**, in the
  email's terms and with no deadline unless one is stated. It was being
  rewritten as "Reply to <sender> with times that work".
- **A second time with no stated purpose is titled "Meeting"**, not a copy of
  the first event's title.

Both models then returned two events and two to-dos. Each was run only once or
twice per prompt version.

## Alternatives rejected

- **Keep one, but tell the model how to pick.** Still drops real obligations
  for good, because of the once-ever mark.
- **No cap.** A bulletin with twenty dates becomes twenty cards (the ADR 0092
  pile-up).
- **Keep the per-tool guard.** Lets a re-mine add reworded second and third
  to-dos; looser title matching was already rejected in ADR 0137.
- **One proposal bundle per email** (ADR 0029 shape). A bundle is confirmed as
  a whole, and these items are independent: the user may want the form
  to-do and not the picture-day event.
- **A second LLM call for "anything else?".** Doubles the cost of every
  thread to serve the minority that hold more than one item.
