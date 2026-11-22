# 0130 — An alias is only offered once it is verified

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes §1.2's send-as row in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md); applies
[ADR 0116](./0116-parity-is-what-a-mailbox-can-do.md)'s parity rule and
[ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)'s honesty rule.

## Context

The audit said *"From is always the mailbox's own address; no alias table, no
`sendAs` lookup"*, filed as needed "the moment compose meets multi-account".

Half of that had already been built: compose has a **From picker across
connected mailboxes** (ADR 0119's account work), and it appears only when there
is more than one to choose from. The genuine gap is narrower — **an alias
within one mailbox**: sending as `treasurer@school.org` from a personal Gmail
that is verified to do so.

The obvious blocker turned out not to exist. `users.settings.sendAs.list` is
covered by **`gmail.modify`**, which Chord already holds — so unlike the
vacation responder (ADR 0124), this costs no new OAuth scope and no re-consent.
Worth checking rather than assuming: the same feature under
`gmail.settings.basic` would have been a very different decision.

## Decision

**Offer only verified addresses, and re-check the choice on the way in.**

### Verification is the entire feature

Gmail does not reject an unverified From. It **silently rewrites** it to the
authenticated address, sends the message, and returns success. So a picker that
listed unverified aliases would show the user an address, send from a different
one, and report that it worked — the ADR 0102 failure with a 200 response code.

`verificationStatus === 'accepted'` is therefore the filter, with the primary
address exempt because it *is* the authenticated one.

### The From is checked server-side

The client picks from a list the server gave it, but the request is still a
client's, and a From header is exactly the field worth being strict about. An
address that does not appear in the verified set is **refused with a 400**, not
quietly replaced with the mailbox's own — because a message that goes out from
somewhere other than where the sender chose is not the message they wrote.

### Gmail only, and that is what parity means here

ADR 0116's rule is that parity is about what a mailbox can **do**. Graph needs
a SendAs permission we do not hold and offers no equivalent enumeration; IMAP
has no concept of an alias at all. So aliases appear on the primary Gmail and
nowhere else — not a limit we impose, but the shape of those mailboxes. The
picker simply does not render for an account that has nothing to offer.

### The picker appears only when there is a choice

One address means no decision to make, and a "Send as" row above every compose
would be furniture. Same rule the mailbox picker already follows, and the same
rule ADR 0119 used for the per-account chip.

## Consequences

- Someone who sends as a club or school address can do it from Chord.
- An alias added in Gmail appears without a reconnect, because the list is read
  live rather than stored. A verification that lapses removes it the same way.
- A `listSendAs` failure returns an empty list rather than an error: composing
  from your own address must keep working when the alias lookup does not.
- Attached mailboxes ignore `from` entirely, which is why the route refuses the
  combination rather than accepting and dropping it.

## Alternatives rejected

**A Chord-side alias table the user types into.** No provider call, works on
every provider — and it cannot know whether the address is verified, so it
would confidently offer aliases Gmail will silently rewrite. That is the exact
failure this ADR exists to prevent.

**Ask for `gmail.settings.basic`.** Unnecessary: `gmail.modify` covers the
read. Asking for a broader scope than a feature needs is how consent screens
become something users click past.

**Offer unverified aliases with a warning.** "This may not work" is not a thing
a person can act on at the moment of sending, and the failure is invisible
afterwards — the message looks sent, because it was.

**Set the From on attached (Outlook/IMAP) accounts too.** SMTP will usually
accept any From, which is precisely the problem: it would produce mail that
fails SPF/DKIM alignment and lands in spam, or gets rejected hours later by the
receiving server.
