# 0122 — Unsubscribe is three different promises

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 4 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
applies [ADR 0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)'s
honesty rule to an outbound action. Extracts ADR 0050's SSRF guard.

## Context

`List-Unsubscribe` has been captured on every message since ADR 0109, where it
serves as a bulk-sender signal. Nothing ever offered to *use* it, so a family
mailbox filling with lists had no exit inside Chord.

The header looks like one capability. It is three, and they differ in the only
way that matters here — **what is true after the tap**:

| Header | What we can do | What we may say |
|---|---|---|
| https + `List-Unsubscribe-Post` (RFC 8058) | POST, and it is done | "Unsubscribed." |
| `mailto:` (RFC 2369) | Send the request | "Request sent." |
| https alone | Open the page | Nothing — the reader finishes it |

Collapsing those into one "Unsubscribed" toast is ADR 0102's failure in a new
place: reporting a write we did not perform. The user's next question is *why
am I still getting this*, and the answer would be that Chord lied.

## Decision

**One button, three outcomes, each described in words that are true of it.**

`parseUnsubscribe` (kernel, tested) reads both headers and returns the kind.
The kind rides on `EmailThreadDetail`, so the button can be labelled before it
is tapped, and `unsubscribeThread` performs whatever that kind allows.

### One-click needs both headers

An https URI **alone** is a link. POSTing to it anyway is a guess about
somebody else's endpoint — plenty of them are ordinary preference pages where a
POST does nothing, or something unintended. RFC 8058 exists precisely to say
"this endpoint accepts an unattended POST", so we require it to have said so.

`http://` is never one-click even with the Post header, because RFC 8058 is
https-only.

### A mailto beats a link

When a sender offers both a `mailto:` and a page, we take the mailto: we can
actually send it, and the reader is done. The message leaves from **the account
that received the mail**, not the primary mailbox — a list keys on the
subscribed address, and unsubscribing from the wrong one silently fails.

### The URL came out of an email

So it is exactly as trustworthy as the sender, which is to say not at all. The
one-click POST goes through the **same SSRF guard** as the ADR 0050 calendar
fetch, re-screened on every redirect hop, https-only, with a 10s timeout.

That guard moved from `fetch-ics.ts` into `utils/ssrf.ts` when unsubscribe
became its second caller. One guard, imported — not a second copy that drifts.
A test proves a URL resolving to `10.0.0.5` never reaches `fetch`.

### Headers ride the thread open on Graph

Gmail and IMAP hand us full headers during sync, so both are free. Graph does
not: `internetMessageHeaders` has to be `$select`ed, and putting it on the
**delta** would pull every header of every message down the hot path to answer
a question only ever asked about a thread someone opened. It goes on the
message fetch instead.

That makes an unobserved header meaningfully different from an absent one, so
the upsert now writes `list_unsubscribe` **only when the provider supplied it**
— `undefined` leaves the column alone, the way `body_excerpt` already worked.
Without that, every delta tick would wipe what a thread open had discovered.

### Remembering that we asked

`email_unsubscribes` records (user, sender, kind, when). It keeps the button
honest on a second visit — "Unsubscribe again" rather than a fresh
"Unsubscribe" for a list already told twice — and it is the first real signal
for the bulk-mail gate, which has been waiting for evidence about which senders
a user actually wants gone.

## Consequences

- Lists can be left from inside Chord, on all three providers.
- Most mail will offer `link` or `mailto`, not one-click. That is the honest
  shape of the world, and the wording follows it.
- Outlook shows the button only after a thread is opened, since that is when
  its headers arrive. The alternative was a heavier delta for every message.
- ADR 0109's bulk signal gets stronger on Outlook for the same reason — but
  only for opened threads.
- A failed one-click says so and offers nothing further. The sender's link is
  usually still in the mail body.

## Alternatives rejected

**POST to any https unsubscribe URI.** More one-click coverage, and a guess
about someone else's endpoint. RFC 8058 is the sender telling us it is safe.

**Only ever open the link.** Trivially honest and nearly useless: it hands the
reader a web page for the one case (one-click) the standard designed to avoid
exactly that.

**Report every kind as "Unsubscribed".** What most clients imply. It is the
ADR 0102 failure: a claim about the world that we did not verify and cannot.

**Put `internetMessageHeaders` on the Graph delta.** Uniform capture, and it
inflates the hot sync path for a question asked about a tiny fraction of
threads.

**Auto-unsubscribe from bulk senders the user never reads.** Tempting, and it
decides on someone's behalf that a relationship is over. Every unsubscribe here
starts with a tap.
