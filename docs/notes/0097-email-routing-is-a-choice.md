# 0097 — The model does not choose which group your email lands in

**Status**: accepted
**Date**: 2026-08-22
**Supersedes**: the LLM group-matcher half of
[0063](./0063-email-magic-suggestions.md); keeps and elevates
[0077](./0077-user-declared-email-routing.md)'s user-declared rules.

## Context

Email-derived suggestions could be routed to one of the owner's shared groups.
Where they went was decided by an LLM call: `llmGroupMatcher` saw the group
names, the subject, the snippet and a few confirmed persona facts, and returned
a group or null. The answer was written to `proposals.target_group_id`, and the
owner's confirm executed the entity **there**, fanning it out to everyone in
that group.

The safety story was real as far as it went, and it is worth stating precisely
because it is what makes this a change of posture rather than a bug fix:

- The proposal itself was staged in the owner's **personal** group. The raw
  email was never shared.
- Nothing executed without a confirm. There is no auto-confirm path anywhere —
  the only callers are the user's chat "yes" and a button tap.
- Candidates were only the owner's own groups, and membership was re-checked at
  execution ([0032](./0032-strict-per-group-scope.md) held).
- The destination was even visible pre-confirm as a `→ group` chip
  ([0077](./0077-user-declared-email-routing.md)).

What it did not have is the thing that matters: **the user could not say no to
the routing without saying no to the item.** One tap meant "yes, this is a real
to-do" *and* "yes, show it to my family", and the chip was display-only — there
was no control to change it. A user who wanted the reminder privately had to
reject the suggestion and retype it.

That is consent by bundling, and the decision being bundled is a
sharing decision made by a language model from a subject line.

## Decision

**Only the user decides which group an email-derived item lands in.**

1. `llmGroupMatcher`, `parseGroupMatch` and the `GroupMatcher` seam are
   **deleted**, not disabled. A dormant matcher is an invitation to re-enable it
   for a plausible reason.
2. `target_group_id` at staging time is set **only** by a user-declared routing
   rule ([0077](./0077-user-declared-email-routing.md)) — a decision the user
   made in advance, in their own words, about a sender domain or a category.
3. Everything else stays personal. `target_group_id` is null, and a plain
   confirm creates the item in the owner's personal group.
4. `confirmProposal` accepts an explicit `targetGroupId`, membership-enforced,
   which overrides whatever the proposal was staged with. The Action Items row
   renders that as a chip strip — **Just me** (default, pre-selected) plus one
   chip per shared group.

So routing still exists, in two forms, and both are the user's: a standing rule
they wrote, or a tap at the moment of confirming.

### Only the standalone confirm path takes the override

A screenshot bundle ([0029](./0029-proposal-action-cards.md)) resolves several
entities in one tap; "put *that* one in the family group" is not expressible
there. Bundles keep their staged destination.

### The membership check now does real work

It was previously a backstop against a value we generated ourselves, with a
comment saying so ("they always do"). Now the value can come from a client, so
the check is the actual boundary. A group the confirmer does not belong to is
refused with `exec_failed`, never silently ignored and never routed.

## Consequences

**Suggestions no longer arrive pre-routed, so shared-group fan-out will drop
unless people opt in.** That is the intended trade: fewer items reach the family
group, and the ones that do were sent there deliberately. `set_email_route`
already exists for anyone who wants the old convenience, and the chip strip
makes routing a one-tap decision rather than a settings trip.

**One less LLM call per suggestion-producing thread.** The matcher ran once per
thread that yielded a suggestion; that spend is gone. The persona-facts lookup
that only fed it is gone too.

**The `→ group` chip means something different now.** It used to say "the model
thinks this belongs to X." It now only appears when a rule the user wrote sends
it to X. Same pixels, honest content.

**Existing pending proposals keep their model-assigned `target_group_id`.** No
backfill: they expire within 72h, and rewriting a pending decision under the
user is worse than letting a small number age out. Their destination is at
least still visible and still confirm-gated.

## Alternatives considered

**Keep the matcher but make its answer a pre-selected chip the user can
change.** Preserves the convenience, and the choice becomes visible. Rejected:
a pre-selected default is what most people accept, so this keeps the model
effectively deciding while adding the *appearance* of consent — the worst of
both. If routing defaults to something, it must default to private.

**Keep the matcher, gate it on a confidence threshold.** Cheap, and
[0076](./0076-email-derived-people-and-family-facts.md) has precedent for a
bounded auto-write. Rejected: confidence in "which family group is this for" is
not calibrated against anything, and the cost of being wrong is disclosure to
other people, which is not undone by deleting the item afterwards.

**Ask the user in chat when routing is unclear.** Fits the ask-don't-guess
pattern [0077](./0077-user-declared-email-routing.md) uses for group names.
Rejected here: magics run in a background sync pass with nobody present, so the
question would arrive detached from the mail that prompted it. The chip on the
card asks the same question at the moment the user is already deciding.

**Leave it alone — it was already confirm-gated.** Defensible on the letter of
it. Rejected on the substance: a single yes that bundles "this is real" with
"share this with my family" is not consent to the second thing.
