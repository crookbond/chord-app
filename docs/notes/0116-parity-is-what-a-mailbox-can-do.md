# 0116 — Parity is what a mailbox can do

**Status**: accepted
**Date**: 2026-08-25
**Relation**: pays the debt [ADR 0108](./0108-a-folder-is-a-predicate-not-a-sync.md)'s
Sent banner was carrying; widens [ADR 0071](./0071-email-attachments-into-knowledge-base.md)
and [ADR 0110](./0110-the-mirror-was-buying-half-a-message.md) past Gmail;
follows the multi-provider model of [ADR 0080](./0080-multi-account-email-providers.md).

## Context

Four mailbox kinds — primary Gmail, secondary Gmail, Outlook/Graph, generic
IMAP — and a growing set of features that quietly meant *Gmail's* features.
Every one arrived for the provider it was easiest on, with a comment promising
the others later, and the comments outlived their reasons.

The rule this ADR settles: **parity is about what a mailbox can DO.** It is not
about flattening limits. Gmail accepts a 24MB attachment and Graph's inline
path takes about 3MB; holding Gmail to 3MB would not be parity, it would be
constraining one provider by another's limit. ADR 0111's per-provider caps
stay, and stay per-provider.

Three real gaps, found by reading rather than assuming:

| | primary Gmail | secondary Gmail | Outlook | IMAP |
|---|---|---|---|---|
| mirror scope | all mail | all mail | **inbox only** | **inbox only** |
| attachments → knowledge base | ✅ | **✗** | **✗** | **✗** |
| body backfill for old rows | ✅ | **✗** | n/a | n/a |

## Decision

### Sent is mirrored everywhere

Outlook gains a second delta stream against `mailFolders/sentitems`; IMAP gains
a pass over the `\Sent` special-use mailbox. Both were structural: Graph synced
`mailFolders/inbox/messages/delta` and IMAP opened `INBOX`, so mail the user
sent from any other client simply did not exist in Chord.

Both cursors were **already JSON blobs**, so a second stream extends the shape
rather than needing a migration, and a cursor written before this ADR still
parses — the inbox keeps its position and Sent starts fresh on the next tick.

Sent messages are stored with `SENT` and no `INBOX`, which is the shape Gmail's
mirror already has, so ADR 0108's folder predicates work on them unchanged.

Two details are load-bearing rather than tidy:

- **The mock needed the folder too.** Its `deltaPage` ignored the argument, so
  both streams would have returned the same messages — importing everything
  twice while looking like it worked. A test against that mock would have been
  worse than no test.
- **No Sent folder is a real state**, not an error. A bare IMAP host may have
  none; `listSentWindow` returns null and the pass is skipped, rather than
  guessing at a mailbox name and syncing somebody's Drafts into their Sent. A
  Sent folder we cannot read must also not fail an inbox sync that already
  succeeded.

The consequence is that **ADR 0108's Sent banner loses its apology.** It said
"your other mailboxes only mirror what Chord sent" because that was true; it is
not true any more, so the sentence goes rather than being reworded.

### Attachment import runs on every provider

This was Gmail-only for a reason that had **stopped being true**. The code said
*"attached-account messages have no fetchable Gmail attachment parts"*, but the
part list now lives on the row (`attachments_json`, stored at sync by every
provider since ADR 0110) and the bytes come from `fetchEmailAttachmentData`,
which has dispatched per provider since the download route needed it — and
which ADR 0112 already used to build forward.

Widening it **deleted** code: the pass no longer reaches for a Gmail API at
all. A stale constraint is worth re-reading before it is worked around.

It now skips rows whose `attachments_json` is null — "nobody has looked yet",
not "none" — so those wait for the body backfill instead of sitting at the head
of the queue every tick.

### Body backfill covers every Gmail mailbox

`backfillMessageBodies` moves out of `gmail.service.ts` into
`services/email/body-backfill.ts`, and resolves an API per account rather than
assuming the primary. It had to move: reaching an attached account's API means
importing `gmail-account.service`, which imports `gmail.service` back. Same
cycle `attachment-fetch.ts` sits above, and the same fix.

Outlook and IMAP are absent from it **on purpose, not by omission** — both
store bodies inline at sync, so there is no gap to fill.

## Consequences

- Sent and archived mail are real on every provider, so ADR 0108's folders and
  ADR 0110's search mean the same thing whichever mailbox you attached.
- Files arriving at an Outlook or Yahoo account now reach the knowledge base,
  so the bot can find them.
- One API call per mailbox per backfill page, not one per message: a page of
  gaps is usually all from the same account.
- Still deliberately asymmetric: **labels**. Gmail has a label API, and ADR
  0107 already decided that managing is the provider's job — Outlook categories
  and IMAP keywords are the equivalents if that is ever revisited, and the
  route 422s honestly in the meantime rather than dropping the write.

## Alternatives rejected

**One shared attachment size cap.** The thing the parity framing most invites,
and wrong: it would refuse on Gmail a file Gmail would take, to keep a single
number true for Outlook. Parity is what a mailbox can do, not the smallest
limit among them.

**Syncing all Outlook mail via `/me/messages/delta`.** One stream instead of
two, and it drags in Deleted Items, Junk and Drafts — folders we deliberately
do not mirror. Two named streams say what they mean.

**Guessing a Sent folder by name when SPECIAL-USE is absent.** The finder does
fall back to a small set of well-known names, but returning null beyond that is
the honest end: syncing an unrelated mailbox because it sorted first is worse
than having no Sent folder.

**Leaving attachment import Gmail-only until someone asked.** Its blocker had
already dissolved; carrying the restriction forward would have been maintaining
a limitation nothing required.
