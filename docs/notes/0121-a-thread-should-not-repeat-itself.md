# 0121 — A thread should not repeat itself

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 4 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
changes what the ADR 0060 reader shows, alongside [ADR 0120](./0120-a-remote-image-is-a-read-receipt.md).

## Context

A five-message thread rendered as five full messages, each of which ended with
a quoted copy of the ones above it. The last card contained the entire thread a
second time, and the reader scrolled past the same text five times to find the
sentence that was new.

Every mail client solves this the same way, because there is only one sensible
answer: fold the quoted history, fold the older messages, and leave the newest
one open.

## Decision

**Fold the repetition, and make each fold one tap from open.**

### Where the quote starts

`splitQuotedText` / `splitQuotedHtml` in `kernel/src/email-quote.ts` return
`{ visible, quoted }`.

The html split runs on the **raw** body, before the sanitizer, because the
thing that identifies a quote container is the class the sender's client put on
it — `gmail_quote`, `yahoo_quoted`, `moz-cite-prefix`, `divRplyFwdMsg` — and
`class` is not in the reader's allowed-attribute list. Sanitize first and the
evidence is gone; all that is left is a bare `<blockquote>`, which catches
Gmail but not Outlook. Splitting first leaves both halves with unbalanced tags,
which is fine: the sanitizer that runs next closes them.

The text split looks for an attribution line (`On … wrote:`, including the
two-line form Gmail wraps it into), `-----Original Message-----`, Outlook's
underscore rule, an Outlook `From:`/`Sent:`/`To:` header block, or a run of
lines beginning with `>`.

Two rules keep the guesswork honest:

- **A run of one `>` line is not a quote.** It is usually someone quoting a
  phrase mid-sentence.
- **A split that leaves nothing visible collapses nothing.** Top-posted mail
  with no new text above the quote is common; folding it would render a blank
  message. Hiding mail is worse than showing a quote, so every uncertain case
  resolves to *show everything*.

### The helpers live in the kernel

Same reason as ADR 0120: the renderer is in `mobile/`, which has no test
harness. A quote splitter is exactly the kind of heuristic that needs a table
of real-world cases pinned to it, so it lives where a test can reach it — 15 of
them, one per client convention.

### Folding messages

The newest message opens; the rest fold to one line of sender, date, a
paperclip if it has attachments, and a preview. **The fold shows what is behind
it**, which is what separates folding from hiding. A thread with one message
folds nothing and gets no control at all.

An explicit tap outranks the default in both directions, so the newest message
can be folded away too.

### Print on the web, share on a phone

`printableThreadHtml` builds a standalone document — no `<link>`, no
`<script>`, nothing that loads from the network — and the browser's own print
dialog takes it from there. It is handed **the same sanitized html the screen
is showing**, image blocking included, so printing cannot become the request
that ADR 0120 just prevented. Its parameter is named `sanitizedHtml` because
the builder passes markup through unescaped and could not do otherwise;
everything around it (subject, sender, recipients) is escaped.

On native there is no print without `expo-print`, which is a new native module
and therefore a new build. Rather than ship a Print button that opens a share
sheet and hope nobody notices, the button says **Share** on a phone and hands
the system a plain-text rendering. Two honest verbs beat one that is true on
one platform.

## Consequences

- The reader stops repeating itself, which is most of what makes a long thread
  unreadable on a phone.
- Quote detection is a heuristic and will occasionally miss — a client with an
  unfamiliar convention shows its quote. That is the failure we chose: the
  alternative failure hides someone's actual message.
- Print output follows the image setting. A reader who has not tapped Show gets
  a printout without the remote images, which is the same thing they are
  looking at.
- `expo-print` remains the thing to add if native print is ever wanted; nothing
  here has to change to accommodate it.

## Alternatives rejected

**Split the quote server-side, at sync.** It would be computed once instead of
per render, and the AI passes could use it. But the split would be frozen at
whatever the heuristic was on the day the mail arrived, and improving it later
would mean a backfill over every message. It is cheap to do at render.

**Sanitize first, then split.** Simpler ordering, and it loses every marker
except `<blockquote>` — which is precisely the Outlook and Yahoo cases.

**Collapse aggressively, showing only the first paragraph.** Some clients do
this. It compounds the guess: now both *where the quote starts* and *how much
of the message matters* are being decided for the reader.

**Add `expo-print` for native print parity.** A new native module and a new
build, to serve a verb almost nobody performs on a phone. The share sheet is
the platform's own answer, and on iOS it is also the way to a printer.
