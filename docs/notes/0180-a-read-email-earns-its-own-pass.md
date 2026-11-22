# 0180 — A read email earns its own pass

**Status**: accepted
**Date**: 2026-09-17

## Context

The magics pipeline (ADR 0063 onward) mines email in the *background*, and
over ADRs 0109/0127/0143/0179 it grew several deliberate skip rules: the bulk
deny-list, discretionary broadcasts (Coupons/Newsletters), read-and-old mail,
and — the strongest one — a permanent once-ever extraction mark once a thread
has been mined at all. All of that is correct for an unattended sweep across
an entire mailbox, where a wrong guess or a wasted LLM call costs a phantom
card nobody asked for, multiplied by however many threads the sweep touches.

None of that reasoning holds once a person has the message **open**. They are
already reading it — a suggestion costs them nothing extra to see, and the
cost the gates exist to avoid (spending an LLM call on the ~95% of mail
nobody looks at) does not apply to the one thread a tap just opened. Today,
though, opening an already-mined, bulk, or discretionary-category thread
shows nothing more than what the background sweep decided days or weeks
earlier, or nothing at all if the sweep skipped it outright. A message that
looks like a phishing attempt is exactly the kind of mail the bulk gate is
likely to have skipped (it often carries the same `List-Unsubscribe`-shaped
signals as ordinary marketing), and it is exactly the moment — the reader
looking straight at it — Chord is best placed to say something.

## Decision

Opening a thread (`GET /me/email/threads/:id`) now unconditionally runs one
extraction pass on **that thread alone**, bypassing every background gate —
bulk, discretionary-broadcast, archived, unread/age window, category — through
a new interactive entrypoint, `runReadTimeEmailMagics`. It shares the actual
extraction + staging logic with the background sweep (`runEmailMagics`'
per-thread body factored out into `extractAndStage`) rather than being a
second, simplified copy: a suggestion staged this way goes through the exact
same dedup (`shouldStageEventProposal` / `shouldStageTaskProposal` /
`shouldStageListItemProposal` / `threadAlreadyProposed`) as one staged by the
sweep, so the two passes can never disagree about whether something is
already proposed (the ADR 0085 lesson — one matching rule, not two).

New top-level suggestion kind, `advisory`: when nothing is actionable but the
message itself is the concern (a phishing/spoofing/scam tell — a mismatched
sender, a request for credentials or payment that doesn't fit the real
relationship, a fake urgent deadline), the extractor says so in one plain
sentence instead of `none`. Stored on the thread (`read_advisory_json`) and
rendered as a caution banner in the reader; never staged as a proposal —
there is nothing to confirm about a warning, and (by construction) it never
co-occurs with an action suggestion for the same message: a scam does not
also get a task inviting the user to comply with it. Ordinary mail — the
overwhelming majority — still resolves to `none` and renders nothing, the
same quiet default the rest of the pipeline already uses.

**Once per thread, not once per open.** A new extraction-mark kind, `read`
(widens `email_extraction_marks.kind`'s CHECK constraint, migration 077),
records that the interactive pass ran for this thread. A later re-open
re-serves the stored advisory and whatever proposal already exists rather
than re-asking the LLM — a reader flipping back to an already-open thread, or
the ADR 0082 foreground refresh re-fetching the same route, must not
multiply cost for no new signal. This mark is deliberately **independent**
of the `magic` mark the background sweep uses: a thread the sweep skipped
(bulk, coupon, stale-read) or already mined gets its own `read` mark and can
reach its own outcome. "Regardless of whether it's done" is the point, not
an oversight — the two passes answer different questions ("what does this
mailbox need mined, unattended, at scale" vs. "what does this ONE message
someone is looking at right now need said").

Best-effort and synchronous: awaited inline in the thread-open route, the
same latency shape as ADR 0072's on-demand `summarize_email`, and wrapped so
a failure (LLM error, timeout) never fails the thread open — the reader still
renders, just without a fresh pass. Behind `EMAIL_READ_TIME_MAGICS_ENABLED`
(default on), since — unlike every background pass, whose whole design keeps
the *usual* tick at zero LLM calls (ADR 0110/0159) — this is a real, present
per-open cost: opening any not-yet-read-pass thread costs one LLM call, by
design.

## Alternatives considered

- **Loosen the background sweep's own gates instead.** Defeats the point of
  ADRs 0109/0127/0143/0179 — those gates stay correct for the unattended,
  whole-mailbox case; the problem is scoped to the one thread someone is
  actually reading, not the sweep's coverage.
- **A separate, simplified interactive extractor that doesn't share staging
  with the background pass.** Repeats the ADR 0085 mistake — two copies of
  "should this stage?" is how that promise breaks; sharing `extractAndStage`
  keeps them provably in sync.
- **Let `advisory` co-occur with an action suggestion.** A scam should never
  also produce a task/event that walks the user through complying with it;
  keeping the kinds mutually exclusive is the safer default.
- **Re-run the LLM on every re-open.** An already-open reader re-rendering,
  or a foreground refresh re-fetching the same thread, is not a new "I am
  reading this for the first time" signal — the `read` mark makes the pass
  idempotent the same way `magic`/`person` already are.

## Consequences

Every thread a user opens for the first time costs one extra LLM call beyond
whatever the background sweep already spent (or didn't) on it — a real,
per-open cost, gated behind its own flag rather than folded silently into an
existing "usually free" pass. A thread already flagged advisory stays
flagged; nothing here retracts a caution once shown. The interactive pass
deliberately does **not** run the invite-probe or trip-classifier
short-circuits the background sweep uses (those are about correctness of
*automatic* staging against calendar-invite/trip semantics); it relies on the
shared dedup helpers alone to avoid a duplicate proposal, which is the same
protection the background sweep's own plain-extraction branch already leans
on.

## Addendum 2026-11-10: the invite check and the AI gates apply here too

This ADR said the read-time pass skips the sweep's invite check and relies
on dedup. That was wrong. Prod: Tom Kent's Outlook invite "Tom/John on
Billing & SMB" was 12:30 PM Eastern, and its body has no time (Outlook keeps
it on the meeting object). The read-time pass ran first, since the thread
was not sorted yet. It ran the model, and the model filled in midnight.
The sweep then read the invite properly, found the thread already had a
card, and staged nothing. The "invite wins" retraction missed it by 30
minutes of its 12-hour window.

Both passes now run the same `stageInviteIfInvite` (ADR 0074) before
anything else. An invite is the thread's one outcome. A failed check skips
WITHOUT the `read` mark, so the email is checked again. A card the model
made from that same invite thread (no invite UID) is withdrawn when the
invite card is staged.

The pass also sits behind the gates the sweep does: AI consent (ADR 0283)
and the allowance (ADR 0079/0325). The post-sync warm-up (ADR 0219) used to
run after the sweep had stopped at those gates. Without consent it marked
the thread `read` after the model call was refused, so that email was never
checked later. Neither gate writes a mark.

## Addendum 2026-11-09 — an open still respects the other mailbox's check

The warm-up (ADR 0219/0221) already skipped a thread whose copy in another of
the user's mailboxes had its read-time check (`crossAccountMarkQuery`, bug 12),
but a real open asked only its own `read` mark, so opening the second copy of a
cc'd email staged a second set of cards under a provenance no dedup compares.
The open now takes that check as its own and returns the other copy's advisory,
if any. A thread whose every message is in Spam or Trash is checked like any
other: a first version skipped it, and the owner reversed that (2026-11-10) -
opening a Spam or Trash email is the user's choice. The bypass this ADR is about is unchanged: an open
still ignores the bulk, discretionary, archived and age gates.
Not done: a copy whose twin was only mined by the sweep (`magic`, never opened)
still gets its own pass on open, and can stage a twin card.
