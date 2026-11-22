# 0125 — A label is not inside a folder

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes §1.3's "list labels" and "browse arbitrary labels" in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md); extends
[ADR 0108](./0108-a-folder-is-a-predicate-not-a-sync.md)'s predicate model.

## Context

Two rows in the audit: **list labels/folders** (no route; `listLabels()` had
exactly one internal caller) and **browse arbitrary labels**. The folder sheet
has had a greyed-out "Labels" row with a chevron since ADR 0083.

Both look like they need a provider call per mailbox, and one of them does not.

## Decision

**Derive the label list from the mirror, and browse a label with one more
predicate.**

### The list comes from the mirror

Every provider lands its label set in the same `gmail_label_ids` column, so one
`jsonb_array_elements_text` over the user's threads answers for all of them —
no provider call, no per-provider branch, and it is impossible for the list to
disagree with what browsing will find.

Where a provider carries no user labels — Outlook and IMAP mirror only the
synthetic `INBOX` / `UNREAD` / `SENT` — the list is honestly **short**, and the
sheet says why rather than showing an error or an empty box. That is the same
posture ADR 0108 took for the Sent banner: state the coverage, don't let a
short list read as loss.

Gmail's ids are opaque (`Label_17`), so names come from `labels.list` — but
only for Gmail, only when the mirror actually holds user labels, and a failure
downgrades to showing the id rather than failing the request. A mailbox with no
labels costs no API call at all.

Telling a user label from a system one needs no API `type` field: every Gmail
system label is an uppercase constant, so "not in that set and not a
`CATEGORY_`" is complete.

### Browsing one reads across folders

This is the part worth writing down. In Gmail, **labelled** and **archived**
are orthogonal, and the mail most likely to carry a label is precisely the mail
that left the inbox — filing it *is* labelling plus archiving. An inbox-scoped
label view would show almost nothing, and the user would conclude the label was
empty.

So a label query uses `searchablePredicate` (everything except Trash) rather
than the current folder's predicate. A label is not a place inside the mailbox;
it is a thread that reaches across all of them, which is exactly the reach
search has and for the same reason.

### Reading, never writing

ADR 0107 gave labelling to the provider. Nothing here changes that: this adds a
way to *look* at what the provider filed, and the "apply an arbitrary label"
row stays where 0107 left it.

## Consequences

- The greyed-out Labels row works, on every provider that has labels to show.
- Outlook and IMAP users see an honest "no labels in your mirrored mail" rather
  than a feature that appears broken.
- One `labels.list` call per label-sheet open on Gmail. Not cached, because the
  sheet is opened rarely and a stale name is worse than a round trip.
- A label name that changes on the provider side shows its new name
  immediately, since names are resolved at read time rather than stored.

## Alternatives rejected

**Fetch the label list from each provider.** The obvious build. It needs a
per-provider branch, returns labels that may have no mail in the mirror (so
browsing them shows nothing), and makes the list a thing that can disagree with
what browsing finds.

**Scope a label to the current folder.** Consistent with how the sheet's other
rows behave, and wrong: it would hide most of what carries the label.

**Store a `label` column.** Same objection as ADR 0108's `folder` column: a
second source of truth that can drift from the label set it was derived from.

**Sync Outlook categories and IMAP keywords so every provider has labels.**
That is a real feature, not a translation of this one, and ADR 0116 already
noted it as the thing to build *if* label parity is ever revisited.
