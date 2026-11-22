# 0142 — Chord label push is one-way and optional

**Status**: accepted
**Date**: 2026-08-30
**Relation**: Wave 2 of
[`email-chord-labels-plan.md`](../tasks/email-chord-labels-plan.md);
extends [ADR 0141](./0141-chord-labels-are-usage-derived-and-ours.md);
operator shape from [ADR 0126](./0126-an-operator-is-a-question-only-mail-can-answer.md)
+ [ADR 0085](./0085-one-search-matching-rule.md);
capability posture from [ADR 0116](./0116-parity-is-what-a-mailbox-can-do.md).

## Context

Wave 1 made Chord labels local on every mailbox. Users also asked whether a
label can appear *in* Gmail / Outlook / IMAP. That is a different feature: it
writes into the provider, and on IMAP it may not even be possible.

If push were load-bearing, labelling would only work where push works — an IMAP
host that refuses keywords would have no labels at all. Wave 1 already answered
"can I file this in Chord"; Wave 2 only answers "also tag the mailbox."

## Decision

1. **Push is an optional enhancement.** Local `chord_label_ids` always apply.
   A failed provider write is logged and does not fail the HTTP request — the
   Chord label is the feature; the mailbox tag is the extra. Opt-in, default
   off, per mailbox (and `users.chord_label_push_enabled` for primary Gmail).
   Distinct from `gmail_sync_labels_enabled` (tile → Gmail label sync).

2. **Push is one-way.** Never read categories / keywords / Gmail labels back
   into `chord_label_ids`. Two writers would recreate ADR 0107. Removing a tag
   in Outlook leaves the Chord label; the switch copy says so.

3. **Provider form is `Chord/<displayName>`** — same family as
   `maybeSyncCategoryLabels`, so user-chosen names do not collide with ordinary
   mailbox labels. IMAP atoms that cannot carry spaces are encoded in kernel.

4. **Capability is per mailbox.** Gmail and Outlook are supported when
   connected (`Mail.ReadWrite` / `gmail.modify` already held). IMAP is supported
   only when `PERMANENTFLAGS` advertises `\*`; probe at connect/reconnect, never
   STORE-and-hope. The UI offers the switch only where `labelPushSupported`.

5. **`label:` is an ADR 0126 operator** and lands on **both** search paths in
   the same change (ADR 0085). It matches Chord names case-insensitively or an
   exact `gmail_label_ids` id paste; any operator still narrows results to mail.

## Alternatives considered

- **Default on.** Rejected — matches `gmail_sync_labels_enabled` opt-in
  precedent; tagging someone else's mailbox without asking is a surprise.
- **Two-way sync.** Recreates 0107 the moment Outlook deletes a category.
- **Outlook master categories / colour.** Needs `MailboxSettings.ReadWrite` and
  a re-consent; ADR 0124 / 0130 declined that cost for less.
- **Overloading `gmail_sync_labels_enabled`.** That flag means tile sync, not
  user-chosen Chord labels; conflating them would flip the wrong switch.
- **`label:` on one search path only.** Breaks ADR 0085 one step earlier.

## Consequences

- Migration `063` adds push flags on `email_accounts` + `users`.
- Push hooks after `applyChordLabelPatch`; provider failures never roll back
  the local column.
- Folder-sheet honesty becomes per-mailbox once push is on for that mailbox.
- Rename, colour, auto-apply rules, and reading provider tags back remain out.
