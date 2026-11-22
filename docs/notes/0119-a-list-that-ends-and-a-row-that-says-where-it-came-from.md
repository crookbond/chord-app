# 0119 — A list that ends, and a row that says where it came from

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes the two survivors of Wave 1 and the per-account filter from
Wave 3 in [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
depends on [ADR 0116](./0116-parity-is-what-a-mailbox-can-do.md) making every
mailbox worth distinguishing.

## Context

Three small gaps that share one surface — the Traditional list.

The list showed the newest 50 threads and stopped. The server had accepted a
`cursor` since it was written; no client had ever sent one. So a mailbox with
more than fifty threads simply ended, with nothing to say it had.

And with ADR 0116 mirroring Outlook and IMAP properly, a merged list finally
contains mail from several mailboxes with no way to tell which is which, or to
look at one at a time.

## Decision

### Keyset pagination, not offset

The cursor is the last row's `last_message_at`, and the next page asks for
older than that.

The alternative — `OFFSET 50` — is wrong here in a way that only shows up in
use: mail arrives while you scroll, every row shifts down by one, and page two
either repeats the row that moved or skips the one it displaced. A keyset is
stable against inserts above it because it names a position in the data rather
than a count from the top. There is a test for exactly that: seed three, take
a page, insert something newer, take the next page, and assert nothing repeats.

The client also **dedups on id** when appending. A thread whose newest message
lands between the two requests can legitimately satisfy both queries, and the
dedup is cheaper than reasoning about whether it can't.

"Is there more" is inferred from a full page rather than tracked: a short page
is the end. That is one fewer thing for the server to be right about.

### `'primary'` is a value the filter needs

`account_id IS NULL` is ADR 0080's convention for the Gmail on the user row.
A filter that takes an account id therefore cannot express "that one" — an
empty string means *no filter*, and null is not a query parameter. So the
filter takes the literal `'primary'`.

An unknown value is **not** rejected. It matches nothing, which reads as an
empty mailbox rather than an error page over a stale client's saved filter —
the same posture ADR 0086 took for `?action=` and 0108 for `?folder=`.

### The row carries the address, not just the id

`accountEmail` rides on the summary via a left join, so the client can label a
row without holding a second lookup table and without a second request. The
chip shows the **local part** (`family@yahoo.example` → `family`): a row has no
space for a domain, and the local part is what tells two of someone's own
mailboxes apart.

Both the chip and the filter row appear **only with more than one mailbox
attached**. With one, every row would carry the same chip, which says nothing
and costs a line.

## Consequences

- A long mailbox scrolls.
- Two mailboxes are visibly two mailboxes, and can be read separately.
- The cached cold-start list is now suppressed when an account filter is on, as
  it already was for folders and action filters (ADR 0108). Priming a cold
  start from a filtered subset looks exactly like missing mail.
- `listThreads` gained a join, so its predicates are all table-qualified now;
  an unqualified `category_id` would have been ambiguous.

## Alternatives rejected

**Offset pagination.** One integer instead of a timestamp, and it silently
corrupts the boundary whenever mail arrives mid-scroll — which, on a mail
client, is the normal case rather than the edge one.

**A `hasMore` flag from the server.** Honest, and one more thing to keep true
across every filter combination. A short page already means the same thing.

**Showing the full address on the row.** Unambiguous and too long; it pushes
the subject out of the line that matters.

**Always showing the mailbox chip.** Simpler code, and a label that is constant
for most users is noise rather than information.
