# 0126 — An operator is a question only mail can answer

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes Wave 3 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
extends [ADR 0085](./0085-one-search-matching-rule.md) from the matching to the
query itself.

## Context

The last unticked line in Wave 3: operators — `from:`, `has:attachment`, a date
range. Without them, typing `from:mom dinner` searched for the literal string
"from:mom", which matches nothing and looks like the mail is missing.

## Decision

**Parse operators out of the query before anything reads it, and let them
narrow the search to mail.**

### The parse happens on both surfaces

ADR 0085 says the user path and the bot tool must agree about what "matches"
means. If only one of them lifted `from:` out of the text, they would disagree
about what the *query* is, which breaks the same promise one step earlier. So
`parseSearchQuery` runs in both, and both search for what is left.

Only the mail arm applies the filters, because only mail has a sender or an
attachment.

### An operator narrows the search to mail

A task has no sender. A saved place has no attachment. Returning unfiltered
tasks beside filtered mail would answer a question nobody asked — the user who
typed `from:lcps picture` is not asking to also see every task about pictures.

So any operator restricts the result to email. Date range included: no other
arm filters by date, so leaving them in would produce the same mismatch.

### An unrecognised operator stays in the text

`has:cheese` is not a question we can answer, so it stays a search term. The
alternative — dropping it — turns a query into a different, broader query
without telling anyone, which is the failure mode ADR 0102 is about, in a
surface where it would be invisible.

Same for a vague date: `after:tuesday` is not parsed into a guess about which
Tuesday. It stays text.

### An operator with no free text is a real query

"Everything from the school" is `from:lcps.org` and nothing else. That means
the text predicate has to become **conditional** rather than always present,
and the early "empty query" return has to admit a query that is only operators.

## Consequences

- `from:`, `has:attachment`, `after:`/`before:` (ISO dates) and
  `newer_than:`/`older_than:` (`3d`, `2w`, `1m`) all work, on both surfaces.
- `from:` matches the display name as well as the address, because people
  search for "the school", not for an address they never memorised.
- **A latent crash was found and fixed.** The unusable-literal sentinel was
  `'\0nomatch\0'`, and Postgres refuses a NUL byte in a text parameter — the
  branch was previously unreachable (a query with no FTS tokens also had no
  usable literal, so it returned early), and an operator with no free text
  reaches it for the first time. It is `\x01` now.
- Nothing in the UI advertises the operators yet. They are discoverable the way
  they are in every mail client: by someone typing what they type elsewhere.

## Alternatives rejected

**Parse only on the user-facing path.** Half the work, and it makes the two
surfaces read the same string differently — precisely what ADR 0085 exists to
prevent.

**Apply the operators to every category.** `from:` against a task would have to
mean "created by", which is a different question wearing the same word.

**Drop unrecognised operators.** Tidier queries, and it silently answers
something other than what was asked.

**A structured filter UI instead of text operators.** More discoverable, and it
is a different feature: people type these because they already know them from
Gmail.
