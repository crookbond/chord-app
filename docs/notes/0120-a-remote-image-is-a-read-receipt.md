# 0120 — A remote image is a read receipt

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 4 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
changes what the ADR 0060 reader renders by default.

## Context

The reader loaded every image in an email. The sanitizer set
`referrerpolicy: no-referrer` and its own comment admitted the limit —
*"browsers may still load the pixel."*

That is not a small leak. A remote image in marketing mail is usually a
**read receipt**: the URL carries a per-recipient token, so fetching it tells
the sender that the address is live, when it was opened, how often, and roughly
from where. It is the mechanism behind every "they opened it 3 times" sales
tool. A family reading school and shopping mail on a phone is announcing all of
that to everyone who mails them.

## Decision

**Block remote images by default; let the reader allow a sender.**

### The default is the whole decision

Gmail loads images and proxies them; Apple preloads everything through a relay.
Both cost infrastructure we do not have — a proxy is a service to run, secure
and pay for. Without one, the honest choices are *load and be tracked* or
*block and look plainer*, and blocking is the one that does not silently spend
the reader's privacy.

`cid:` images are **not** blocked. Those are the message's own attachments,
already downloaded with it: blocking them hides the photo someone actually sent
and stops no tracker.

### The `url()` hole

Rewriting `src` is the obvious half and it is not enough.
`<td style="background-image:url(…)">` fetches on render exactly as an `<img>`
does, and inline `style` is allowed on most tags in the reader's subset. A
blocker that only touches images leaves a working pixel behind.

So `stripRemoteCssUrls` runs on **every** tag's style, not just images. That is
the one piece of this most likely to be got wrong by someone reading the code
later, which is why it has its own tests — quoted, unquoted, spaced,
protocol-relative and uppercase `URL(`.

### The helpers live in the kernel

`isRemoteImageUrl`, `stripRemoteCssUrls` and `countBlockedImages` sit in
`kernel/` rather than beside the renderer, because the renderer is in
`mobile/`, which has **no test harness**. Security-relevant logic that cannot
be tested where it lives should move somewhere it can be.

### An allow list, keyed on the sender

Not a block list: the default is to block, so every row is an exception the
reader chose, and the empty table is the safe state rather than the useless
one.

Keyed on the **address**, not the thread — agreeing to see one newsletter's
images is a decision about that sender, which is what a reader thinks they are
making. Stored server-side so it holds on every device, and resolved into
`EmailThreadDetail.imagesAllowed` on read, so the client never has to compute
it or hold a second list.

Case-insensitive, because senders are inconsistent about it and a reader who
allowed `News@Example.com` meant `news@example.com`.

### The block is visible, and reversible in one tap

A silent block is just a broken-looking email. The thread shows one banner —
*"3 images not loaded · Show · Always"* — counted **across the thread** rather
than per message, or a five-message thread offers the same decision five times.
"Show" is this reading; "Always" is the sender, forever, and re-reads from the
server rather than guessing optimistically.

## Consequences

- Mail with tracking pixels no longer reports back on first open.
- Some mail looks plainer until the reader taps Show. That is the trade, and
  the banner is what keeps it from reading as breakage.
- Existing users see a change in how their mail renders. There is no migration
  to soften it: an allow list starts empty by definition.
- One route serves both directions (`allow: false` removes the permission),
  because changing your mind is the same decision reversed.

## Alternatives rejected

**Load images, keep `referrerpolicy`.** Today's behaviour. It hides *who* is
asking and still confirms the address is real, which is the part that matters
to a tracker.

**Proxy images through Chord.** What Gmail and Apple do, and the best answer
for the reader — the sender learns nothing, images still appear. It is a
service to run, cache, secure and pay for, and it makes us the party fetching
arbitrary URLs on a user's behalf. Worth revisiting; not worth blocking this
on.

**Block only known trackers.** A list to maintain forever that is wrong the day
a sender changes domain, and it treats "is this a tracker" as knowable when the
honest answer is that any per-recipient URL is one.

**A single global "load images" switch.** One setting instead of a list, and it
forces an all-or-nothing choice on a mailbox where the answer genuinely differs
per sender.
