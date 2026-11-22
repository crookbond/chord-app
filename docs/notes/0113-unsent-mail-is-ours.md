# 0113 — Unsent mail is ours

**Status**: accepted
**Date**: 2026-08-25
**Relation**: supersedes the Drafts half of
[ADR 0108](./0108-a-folder-is-a-predicate-not-a-sync.md)'s stub reasoning;
applies [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)'s line to
unfinished messages; Wave 2 of
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md).

## Context

Every composer in the app lost its contents on the way out. Type half a reply,
get a phone call, come back — gone. That is the ordinary case for a family
answering school mail on a phone, and it is worse than never having started.

ADR 0108 left the Drafts folder disabled with the reason *we keep no draft
store*, which was true and is now the thing to fix. But it also gave a second
reason that still holds: listing the **provider's** drafts would mean reading a
mailbox we do not mirror, and offering edit affordances over messages we cannot
faithfully round-trip.

So the question is not "drafts or no drafts" but **whose drafts**.

## Decision

**A draft is an unfinished answer, and ADR 0107 puts answering on our side of
the line.** Chord keeps its own draft store; the provider keeps its.

That has a practical consequence that decides it independently: autosave needs
to be cheap. A local row can be rewritten every second and a half without
asking Gmail's permission, without a network round trip per pause, and without
a rate limit. Gmail's `drafts.update` could not be used that way.

### Autosave is debounced, and empty drafts are not saved

Per keystroke is a request per character. Only on unmount loses the case
autosave exists for — the app being *killed* rather than left. So: quiet for
1.5s, then save, and save again on the way out for whatever the debounce had
not committed.

A draft with nothing in it is never written. An empty composer opened and
closed should leave no trace, or the list fills with blanks nobody wrote.

### The upsert rule is what makes it idempotent

A reply or forward has at most **one** draft per thread, enforced by a partial
unique index rather than by hopeful code. So a reply typed across two sittings
is one draft, not two — and the composer can find it again from the thread
alone, having forgotten the id. A composed message has no thread, so the client
holds its id after the first save.

A save whose target row was deleted in another window **falls through to an
insert** rather than throwing. Someone is still typing; losing their words to a
race would be the worst possible moment to be strict.

### The send clears the draft, server-side

`draftId` rides the send / reply / forward request and is deleted **after** the
provider took the message. A client-side cleanup would leave a draft of an
already-sent message whenever that second call failed. Deleting an absent draft
is a success, not an error — a send must never fail on its own tidying.

### The folder says what it holds

The Drafts row goes live, and its footer reads *"Drafts you started in Chord.
Anything you began in your mail app stays there."*

This is the same debt ADR 0108's Sent folder pays about partly-mirrored
mailboxes. A list quietly holding half of what the word "Drafts" means to a
reader would be worse than no list.

## Consequences

- Nothing typed is lost to navigation, backgrounding, or a crash.
- The Drafts folder is real, and honest about its scope.
- Resuming a reply or forward opens the **thread**, not a standalone editor:
  the composer there picks its own draft back up by thread id, so there is one
  place a reply is written rather than two.
- `email_drafts` cascades on both `users` and `email_threads`, so a
  disconnected mailbox or a deleted account does not strand rows.
- Attachments are held by id in the draft, which works precisely because
  ADR 0111 made ids the wire shape. A draft's files are real Chord files that
  survive the draft.

## Alternatives rejected

**Gmail's drafts API.** The apparent "correct" answer, and it fails on the
mechanism: autosave against a remote draft is a network round trip per pause,
rate-limited, and offline-hostile. It also only works for one of four
providers — Outlook has its own draft model and IMAP has `\Draft` in a folder
we do not sync — so it would be three implementations of one feature, two of
them worse.

**Local device storage (AsyncStorage).** Cheaper still, and loses the draft
when you switch devices — which for a phone-and-laptop family is most of the
time. It also cannot be listed on the web client.

**One draft row per save.** Simpler code, and a Drafts list containing forty
copies of the same half-finished sentence.

**Requiring a subject or body before saving.** Would avoid empty rows without
the `isEmpty` check, at the cost of losing a draft that is *only* recipients
and an attachment — which is a real state on the way to sending a photo.
