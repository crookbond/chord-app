# 0149 — The mail surface is bounded to family coordination

**Status**: accepted
**Date**: 2026-09-05
**Relation**: extends [0107](./0107-chord-reads-and-answers-gmail-manages.md)
(answering vs. managing) with a second, tighter line *inside* answering; sets a
convention every email-touching change must follow; sanctions the lane in
[`docs/tasks/product-direction-2026-08.md`](../tasks/product-direction-2026-08.md)
("Chord reads and classifies mail and turns it into action items").

## Context

ADR 0107 drew one line — Chord answers mail, the provider files it — and left
"answering" to be read generously. It has been. The ~40 ADRs since (0108–0147)
built: folder predicates, keyset pagination, per-mailbox account chips, own-drafts
with debounced autosave, undo-send with a server hold, recipient autocomplete,
remote-image blocking *and* a fetch-through proxy, unsubscribe in three flavours,
a Chord-sent vacation responder on every provider, verified send-as aliases, a
markdown formatting subset, quoted-history folding, snooze as a mailbox state,
bulk triage with swipe gestures, label browsing plus one-way label push,
user-chosen mailbox nicknames, and four interchangeable AI-view layouts.

Every one has a local ADR and a sound local reason. Several shipped over an
explicit "recommend deferring" ([0129](./0129-snooze-is-a-mailbox-state-and-only-ours.md)
snooze; [0146](./0146-the-email-map-is-a-feed.md)/[0147](./0147-let-people-choose-their-email-view.md)
the layout menu). Collectively they answer *"does a mailbox do this?"* — not
*"does the family need this to coordinate?"* `services/email/` is now ~8.5k
non-test LOC across 43 files, the size of the whole agent (`services/bot/`), and
in the same window the coordination pillars (memory, proactive beyond reminders,
trips, `update_task`) and the **harness-shaped** email work — email→people/family
facts, email→group routing, the briefing's email section — got a fraction of that
attention. `EMAIL_PERSONS_ENABLED` defaults on and has still never been checked
against a real mailbox.

The drift is not a bug in any one decision. It is what "use your judgement per
feature" produces when the incumbent (Gmail, free, already on the phone) sets the
comparison and every gap looks small on its own.

## Decision

**A mail feature earns a place in Chord only if it produces or improves a shared
family artifact** — a task, event, list item, person or important date, a routing
outcome, a briefing line, or a proposal that becomes one of those. Reading and
replying (ADR 0107) stay, because they are the input to that pipeline and the
family's response to it.

**Net-new mail-client parity and polish is frozen.** No new work on folders,
labels, snooze, draft UX, formatting, send-as, vacation replies, image handling,
triage gestures, or view layouts — unless it is a correctness fix to something
already shipped, or it directly feeds the pipeline above. What exists keeps
working and keeps being fixed; it does not grow.

**The gate, on every email-touching change** (commit body or PR description, one
line): *name the shared family artifact this produces or improves.* "A nicer
inbox" is a rejection — that belongs in Gmail. This is ADR 0102/0107's rule
("say it in the product, don't just make it true in the code") turned on the
roadmap instead of on a tool result.

**The sanctioned lane for email effort** is the three under-built harness
workstreams, ahead of any further mail-client surface:
1. **Email → people & family facts** — `person-extraction.ts` (ADR 0076),
   verified against a real mailbox and its output made visible on the People
   screen.
2. **Email → group routing you can see and correct** — routing rules
   (ADR 0077/0123) reaching shared groups through the consent surface
   (ADR 0097), not just personal.
3. **The email section of the daily briefing** — `digest.service.ts`
   (ADR 0072/0091), the one place email signal is already routed to the family.

## Alternatives considered

- **Continue parity-by-ADR.** Each next gap is a few days and reads reasonable in
  isolation. That is exactly the mechanism that built a second product; the
  answer cannot be another case-by-case judgement call.
- **Hard freeze on all email work.** Throws out the differentiated pipeline
  (classification → magics → proposals → calendar/tasks) along with the polish.
  The pipeline is the reason the mail surface exists.
- **A checklist of allowed vs. banned features.** Goes stale the first time a
  genuinely coordination-serving feature isn't on it. The gate is a *question*,
  answerable for cases not yet imagined.

## Consequences

- Real, nice mail features will not ship: cross-provider snooze parity, HTML
  compose, richer label management, a drafts folder that lists the provider's
  drafts. That is the design working — Gmail has them.
- `docs/tasks/email-parity-audit.md` is reframed, not resumed: Wave 2 (outbound)
  is "enough"; Wave 3 (finding things) continues only where it serves recall of
  family context, not filing.
- A reviewer gets a one-line reason to bounce an email PR, and the author gets
  the question before they start.
- Same risk ADR 0107 took — the mail surface can read as unfinished. Same
  mitigation: state it in the product ("Chord turns your mail into your family's
  to-dos and calendar; your mail app is still where you file"), don't leave it
  implied.
- Falsification: if six months of email commits still can't each name a shared
  artifact, this ADR failed and the mail surface has a life of its own again.

## Rejected

- **Deleting the shipped parity features to match the new line.** They work, they
  are done, and removing a working undo-send helps nobody. The line is about
  what we *add*.
- **Folding this into ADR 0107 as an addendum.** 0107's line (answer vs. manage)
  is orthogonal and still holds; this is a second cut, and burying it would make
  it as easy to read past as the "recommend deferring" notes were.
