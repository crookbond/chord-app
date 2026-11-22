# 0123 — A rule says where mail goes, not what happens to it

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 4 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
puts a UI on [ADR 0077](./0077-user-declared-email-routing.md)'s rules, bounded
by [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md).

## Context

The audit lists "filters/rules editor in Settings (the data model already
exists)". The data model is ADR 0077's `email_routing_rules`, and until now the
only way to write one was to *ask the bot* — `set_email_route` in a personal
chat. A user who wanted to see their rules had to remember to ask.

But "filters" in a mail client means something bigger than what that table
holds: match a message, then **archive it, label it, mark it read, forward it,
delete it**. Building that is the obvious reading of the audit line, and it is
the wrong one.

## Decision

**Settings edits routing rules, and routing rules only.**

A rule answers one question — *which group does this mail belong to* — and its
effect is that a suggestion from that mail lands in the family group instead of
staying private. Every other verb on that list is **filing**, which ADR 0107
gave to the provider on purpose: a filter that auto-archives is a second writer
racing Gmail's own filters against the same mailbox, and the loser is whoever
looks last.

So the editor shows what exists, adds, and removes. Three routes, no new
concepts.

### The kind is shown, not asked

ADR 0077 infers `sender_domain` vs `category` from the pattern — a dot and no
spaces is a domain. The editor displays the inference under each rule rather
than making the user choose between two words that mean nothing until you know
the schema. If the inference is wrong, the fix is to type a different pattern,
which is the same edit either way.

### Every write returns the whole list

`POST` and `DELETE` both respond with the full rule set, so the client replaces
rather than patches. The list is small and bounded by how many groups a person
has; a merge on the client would be four lines of code that can drift from what
the server did.

### Membership is checked on the way in

ADR 0077 already enforces membership at match time. Here the group id comes
from a **client**, which is exactly the case the write-side check exists for —
the bot path resolved the group from a name it had just listed for that user,
so it never handed over an id the user could pick.

## Consequences

- Rules stop being invisible: they are listed where every other setting lives.
- The bot tool and the editor write the same rows, so a rule set by voice shows
  up in Settings and vice versa.
- Someone will eventually ask for auto-archive here. The answer is in ADR 0107,
  and this ADR exists so that answer is findable.
- A user with no shared groups sees an explanation instead of an empty form,
  since a rule with nowhere to route is not a thing they can make.

## Alternatives rejected

**A full filter editor (archive / label / mark read / forward).** What "rules"
means in every other client, and a direct violation of ADR 0107's split. It
also duplicates a feature the provider already has, with worse fidelity, and
races it.

**Let the user choose the rule kind.** More explicit, and it asks a question
whose answer is derivable from what they typed.

**Keep it bot-only.** Cheapest, and it leaves the user unable to answer "what
rules do I have" without a conversation.
