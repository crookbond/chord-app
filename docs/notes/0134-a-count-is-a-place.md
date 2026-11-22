# 0134 — A count is a place, not a number

**Status**: accepted
**Date**: 2026-08-25
**Relation**: makes [0083](./0083-email-stage-1-shell-decisions-on-tiles.md)'s
coverage footer reachable; carves the single exception to
[0073](./0073-email-delete-archive-convergence.md)'s hide-archived rule.

## Context

Reported: *"when we click 'x handled, y expired still owed' it should open what
was handled and what is owed."*

It did not, and reading the path showed worse than a dead tap. All three counts
sat inside one `Pressable` whose handler was:

```ts
if (coverage.unreadable > 0) { …show unclassified… }
```

So **two of the three counts had no destination at all**, and when the third
fired, tapping any part of the line opened the unclassified list regardless of
which count the finger was on.

The obvious fix is what `unreadable` already does — filter the loaded list in
the client (`threads.filter(t => !t.categoryId)`). That does not work here:

- `listThreads` is paginated at 50, and *still owed* means an **expired**
  proposal, so those threads are at minimum ~3 days old (ADR 0009's 72h TTL)
  and routinely past the first page.
- Both sets are computed from `proposals` joined back to threads by
  `gmail:<id>` provenance, which the client cannot derive.

Worth noting the existing `unreadable` tap is only *apparently* correct:
unclassified threads happen to be the newest, so page one usually holds them.
Same latent bug, quieter.

## Decision

`EmailDecisionsResponse.coverage` carries `handledThreadIds` and
`owedThreadIds` beside its counts, and `GET /me/email/threads?ids=a,b,c`
returns exactly those threads. The footer becomes three tap targets, each
opening the traditional list with a banner naming what it is showing.

Ids rather than summaries: the client already has a list that knows how to
render a thread row, so shipping ids reuses rows, badges and tap-through
instead of inventing a second list surface. The lists are capped at 200 while
**the counts stay exact** — a clipped list is a display limit, a wrong number is
a lie.

### The exception to ADR 0073

`?ids=` returns archived threads. ADR 0073 hides archived mail from every
listing surface, and this is the one place that rule is wrong.

The reason is **not** that acting archives things — it does not. Deciding calls
`markSourceThreadsRead` and clears UNREAD, and nothing in Chord archives on the
user's behalf. Archiving afterwards is the user's own tidy-up.

The reason is that `handledToday` counts **what the user did**, off confirmed
proposals, which carry no archive predicate. Filter the list and the footer
reads "3 handled today" above a list of two. A count disagreeing with the list
behind it is worse than showing a thread the mailbox has tucked away.

Note the deliberate asymmetry with `stillOwed`, which **does** exclude archived
threads: archiving an unanswered email cancels the obligation, but it does not
undo an action already taken.

## Consequences

- Ordinary browsing is unchanged — the exception is scoped to a set the caller
  named explicitly, which is not browsing.
- The `unreadable` tap keeps its client-side filter. It is the one count whose
  set is reliably in the first page, and giving it the same treatment would be
  churn for no behaviour change.
- `countStillOwed` is gone, replaced by `stillOwedThreadIds` whose length is the
  count — one query where there were two, and the number cannot drift from the
  list it describes.

## Alternatives rejected

- **Filter the loaded thread list client-side.** The pagination problem above;
  it would show a partial answer that looks complete.
- **Return full thread summaries in the coverage payload.** Duplicates a DTO the
  client already has, and grows a payload fetched on every map open.
- **Make `handledToday` exclude archived threads** so no ADR 0073 exception is
  needed. Then tidying up after yourself silently reduces your record of what
  you did that day, which is a worse answer than the one this avoids.
