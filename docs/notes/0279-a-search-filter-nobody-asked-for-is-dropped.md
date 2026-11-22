# 0279 — A search filter nobody asked for is dropped

**Status:** Accepted, 2026-10-20. Applies ADR 0229's rule to the search tool
(ADR 0270).

## Context

The chat search for "show me emails from mallory" told the user there was no
mail from Steve Mallory. There was plenty. Running the same search directly
on the prod VM found his thread. The chat call, once arguments were logged
(PR #99), was:

```
{ from: "Steve Mallory", query: "", categories: ["emails"],
  after: "2026-09-01", before: "2026-10-20",
  emailAction: ["to_do", "reply_needed", "informational", "other"],
  emailKind: "delivery", hasAttachment: false, to: "", limit: 10 }
```

The model filled in every optional filter. `emailKind: "delivery"` alone
limited the search to parcel mail. The bot then reported the empty result as
a fact about the mailbox, and on the next turn invented a thread id for
`read_email`. The schema is not strict, so nothing forced the model to fill
these fields; it chose to.

ADR 0229 met the same behaviour with `repeat` on events: a value the model
adds on its own is checked against the user's own words, because a prompt
alone did not stop it.

## Decision

- **A filter is kept only when the user could have asked for it.**
  `dropUnaskedMailFilters` (`bot/search-filter-guard.ts`) reads the user's
  own messages: the triggering message plus up to 8 earlier ones from the
  last 30 minutes, the bot's messages left out (`recentUserText`, same window
  as `repeatWasAsked`). The side chat (ADR 0277) has no stored message, so
  it passes its user messages as `userText`.
  - `emailKind` stays only if a word for that kind was said (package,
    shipped, tracking; receipt, order, paid; flight, airline; invite, rsvp,
    meeting).
  - `hasAttachment: true` stays only for attachment, file, pdf, document,
    photo and the like.
  - `emailAction` stays only for reply, respond, to-do, waiting, follow up
    and the like.
  - `after`/`before` stay only when a time was named: a month, a weekday,
    today/yesterday, weeks/months/years, ago/since/before/after, a year, a
    numeric date.
- **Some values are never a filter, with or without a message:** an empty
  `from`/`to`, `hasAttachment: false`, and all four email actions at once
  (that also leaves out mail not yet sorted).
- **No message to read means the call is taken as given.** This covers a
  scripted call or a proposal confirm, as in ADR 0229.
- Each filter's description now says to leave it out unless the user asked.
  The server check is what holds; the description only makes it rarer.
- A dropped filter is logged (`search: dropped unasked filters`), with names
  only.

## Consequences

- "emails from X" searches X's mail, whatever the model adds.
- A filter the user really meant, but said in words outside these lists, is
  dropped. The search then returns more than asked, not less, which is the
  safe direction.
- English word lists only, like ADR 0229.

## Rejected

- **Prompt only.** ADR 0229's precedent: the instruction was there, and the
  model still filled the field.
- **Retrying without filters when the result is empty.** It hides real empty
  results ("any receipts from Costco this month?" can truly be none) and
  doubles the work on every miss.
- **Asking the model to justify each filter.** Same model, same mistake.
