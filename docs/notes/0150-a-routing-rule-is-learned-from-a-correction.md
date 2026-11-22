# 0150 — A routing rule is learned from a correction, never inferred

**Status**: accepted
**Date**: 2026-09-06
**Relation**: implements the deferred half of
[0077](./0077-user-declared-email-routing.md) ("Learning rules implicitly from
confirm/reject behaviour — deferred"); sits under
[0097](./0097-email-routing-is-a-choice.md) ("only the user decides which group
an email lands in"); one of the three sanctioned email workstreams in
[0149](./0149-the-mail-surface-is-bounded-to-coordination.md).

## Context

Routing an email-derived to-do/event into a shared group is a per-item tap: the
Action Items row shows a **Just me + one chip per shared group** strip
(ADR 0097), the user picks a group, confirms. A standing `sender_domain` /
`category` rule (ADR 0077) can pre-stage the destination, but the only ways to
create one are asking the bot (`set_email_route`) or the Settings editor
(ADR 0123). So a user who routes every "Cub Scouts" email into the family group
by hand repeats that pick forever, and never discovers the feature that would
stop it.

The owner's constraint, stated plainly: **no auto-routing — that is a recipe for
security leaks.** Nothing may cause an email-derived item to reach a shared
group without an explicit per-item confirm.

## Decision

**After a user routes a proposal into a shared group by hand, offer — once — to
make that routing standing. The rule only pre-selects; it never routes.**

- `confirmProposal` returns an optional `routeSuggestion` on the `{ ok: true }`
  result. It is computed **only** from the explicit `targetGroupId` the user
  passed on *this* confirm (the correction), never from the staged fallback,
  and only when every gate holds:
  - the proposal is standalone (`bundle_id` null — ADR 0097 bundles carry no
    override, so there is nothing to learn from);
  - provenance is `gmail:<threadId>` and the thread resolves to a sender with a
    parseable host;
  - the destination is a **shared** group the user still belongs to;
  - **no `sender_domain` rule already routes that host there** (no nag). A rule
    pointing the host at a *different* group still yields a suggestion, with
    `replaces` set so the offer reads "…instead of <that group>".
- The mobile Action Items surface renders `routeSuggestion` as a one-tap offer
  after the confirm ("Always send mail from `pack42.scouting.org` to
  `Doe Family`?"). **Yes** calls the existing `POST /me/email/routes`
  (`setRoutingRule`). Dismiss hides it.
- A learned rule's *entire* effect is that the next proposal from that sender is
  staged with `target_group_id` set — and ADR 0077's confirm flow still
  requires a ✓ on that proposal. It never auto-executes, auto-confirms, or
  fans out.
- **The pattern is the exact sender host** (`from_email.split('@')[1]`), not a
  guessed registrable domain. Narrower is the safe error for a rule the user
  did not type; they can broaden it in Settings.
- **Honesty fix (required):** the Action Items chip strip initialised its
  selection to "Just me" regardless of a proposal's staged `target_group_id`,
  so a proposal a rule had already routed showed "Just me" active while a bare
  ✓ sent it to the rule's group (the staged fallback in `confirmProposal`). The
  strip now starts on the staged group when it is one the user can see, so the
  pre-selected chip always matches where ✓ will send. Bare-✓ behaviour is
  unchanged; only the visible pre-selection is corrected. This is what makes a
  learned rule "tap to send" and not a silent leak.

## Consequences

- One correction produces at most one offer; declining or ignoring it is final
  for that thread (the thread will not produce the same proposal again, and the
  suppression gate covers a repeat sender once any rule exists).
- Learned rules are `sender_domain` only. Category rules stay a
  type-it-yourself feature.
- `email-magic.tsx` (the magic card docked beside the email) has no override
  strip and confirms to the staged group only — it gets no offer. Noted as a
  follow-up; the Action Items surface is where corrections happen.

## Rejected

- **Infer rules from confirm/reject statistics** ("you routed 3 of these to
  Family — make it a rule?"). ADR 0077 already rejected implicit learning; this
  is explicit — one hand-made correction, one offer, one tap.
- **Auto-apply the learned rule to already-pending proposals.** Rewriting a
  decision under the user; the ADR 0097 posture on existing pending proposals
  is to let them age out, not restage them.
- **A "don't ask again" flag.** The suppression gate (a matching rule exists)
  and the fact a resolved thread won't re-propose already cover the nag case.
- **Guess the registrable domain via a public-suffix list.** Adds a dependency
  and a data table to widen a rule the user can widen in one edit; a too-broad
  auto-created routing rule is the exact failure mode this ADR is careful about.
