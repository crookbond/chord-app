# 0141 — Chord labels are usage-derived and ours

**Status**: accepted
**Date**: 2026-08-28
**Relation**: implements
[`email-chord-labels-plan.md`](../tasks/email-chord-labels-plan.md) Wave 1;
extends [ADR 0125](./0125-a-label-is-not-inside-a-folder.md) browse;
posture mirrors [ADR 0129](./0129-snooze-is-a-mailbox-state-and-only-ours.md);
safe against [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)
because a Chord label has exactly one writer.

## Context

Outlook and IMAP have no Gmail-style user labels that persist in Chord. The
obvious place to store one — `email_threads.gmail_label_ids` — is silently
inert: [`recomputeThread`](../../server/src/services/google/gmail.service.ts)
overwrites that column from the union of message labels after every sync,
mark-read, and archive. A label written there survives until the next tick and
then disappears.

ADR 0107 gave *managing* (trash, star, move, provider labels) to the mailbox
because every management verb is a second writer racing the provider. A label
Chord invents is different: no Gmail filter sets it, no other client touches
it, and there is no provider-side value for ours to race.

## Decision

1. **A Chord label is safe because it has exactly one writer** — that is what
   distinguishes it from every verb ADR 0107 gave to the provider. Wave 1 is
   local only; Wave 2 may push a copy into the mailbox one-way, but never
   reads it back into Chord (two writers would recreate 0107).

2. **It lives in its own column** — `email_threads.chord_label_ids` (jsonb,
   default `[]`). `recomputeThread` never touches it. The id of a Chord label
   is its display name; apply/remove dedupe with
   [`listNameKey`](../../kernel/src/list-name.ts) (ADR 0094).

3. **The label set is usage-derived** — whatever appears in some thread's
   `chord_label_ids`, the same way ADR 0125 derives provider labels from the
   mirror. A label with nothing under it does not exist: there is no create
   step and no empty "your labels" screen. Rename and colour would need an
   `email_labels` table; that is the trigger to revisit, not a reason to build
   the table now.

Browse ORs both columns under ADR 0125's `searchablePredicate` (labelled and
archived stays findable). Writes reuse `POST /me/email/threads/modify` via
`addChordLabels` / `removeChordLabels` and never call the provider. The folder
sheet says so, in ADR 0129's voice: *Chord labels live in Chord; your mail app
won't show them.*

## Alternatives considered

- **Write into `gmail_label_ids`.** Free to list, wiped by `recomputeThread`.
- **`email_labels` join table.** Second store to keep consistent; cleanup on
  thread delete; buys rename/colour we are not shipping.
- **Gmail-only.** Violates ADR 0116 — every mailbox can do a local label.
- **Wave 2 push as load-bearing.** Labelling would then only work where push
  works; an IMAP host that refuses keywords would have no labels at all.

## Consequences

- Migration `062` adds `chord_label_ids`. Provider `addLabelIds` 422s on
  Outlook/IMAP stay honest — they are about *provider* labels.
- `EmailLabelSummary.scope` is `'provider' | 'chord'` so the UI can distinguish
  and so Wave 2 can change the honesty line per mailbox later.
- Wave 2 (push), `label:` search, auto-apply rules, rename, and colour are
  deliberately out of this ADR.
