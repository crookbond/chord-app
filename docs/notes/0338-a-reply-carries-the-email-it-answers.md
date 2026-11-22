# ADR 0338 — A reply carries the email it answers

**Status:** Accepted, 2026-11-13. Amends ADR 0260 (signature in the box) and
the reply half of ADR 0107.

## Context

The owner replied to an email with a well-formatted signature and the reply
read as a plain note. The cause: a reply from a Gmail, second-Gmail or IMAP
mailbox carried only what was in the composer box. `buildReplyRaw` built the
message from that text, and its HTML half was the same text with line breaks.
There was no "On …, X wrote:" section, so the original (its formatting, its
sender's signature, the earlier messages under it) was not in the reply.
Gmail still threads it by its headers, but anyone reading the reply in
another client, or Gmail's own "show quoted text", saw nothing.

Outlook did not have this problem for sends. Chord sends an Outlook reply
through Graph's `/reply`, and Microsoft adds the original under the comment
with its formatting. It did have it for the copy in the Drafts folder (ADR
0303): that copy starts from `createReply` and is then `PATCH`ed with the box
text, which replaces the body Microsoft had built, quote included.

The same report showed a second complaint: the composer showed the user's
rich signature as plain text (an address in brackets after each link), so a
reply looked like it would go as plain text even when it would not. The box
is a plain text field and the rich version only replaced it at send
(`outgoingBodies`).

## Decision

1. **A reply quotes the message it answers**, the way every mail client
   does, at send time and not in the box (so the box stays short, and the AI
   draft (ADR 0197) still rewrites only what the user wrote). One step,
   `withQuotedOriginal` (`services/email/reply-quote.ts`), used by every
   reply path that builds its own MIME (primary Gmail, a second Gmail, IMAP)
   and by the Drafts-folder copy for all providers (Outlook included, since
   its `PATCH` replaced Microsoft's quote).
   - **HTML half**: the reply, then `On <date>, <name> <address> wrote:` and
     the original's HTML inside `<blockquote class="gmail_quote">` (the
     class Gmail, Apple Mail and Chord's own reader (ADR 0121) fold). The
     original is cleaned on the way out (`sanitize-html`): no scripts,
     forms, frames, `<style>`, event handlers or `javascript:`; images kept
     except `cid:` ones (the attachments they name are not re-sent, so they
     would only be broken pictures). An original with text only is quoted
     as escaped text.
   - **Text half**: the same line and the original's visible text, each line
     prefixed `> `.
   - The date is in the user's zone (`forwardDateLabel`, as forward uses).
   - The message quoted is the reply's anchor (`replyAnchor`, the same one
     the threading headers and recipients come from), so what is quoted is
     what is answered.
   - **Not quoted**: an automatic reply (ADR 0124 vacation, ADR 0314); an
     anchor with no stored body (nothing to quote is better than a header
     over nothing); and an original over 400,000 characters of HTML, which is
     quoted as text instead.
   - The stored sent copy holds what was sent, quote included; the reader
     folds it.
2. **Outlook sends are unchanged.** Microsoft already quotes on `/reply`.
3. **The composer shows a rich signature as it will look.** Replaced, before
   it shipped, by ADR 0339: the composer has a Plain / Rich switch, and Rich
   is a formatted editor with the signature at its bottom.

4. **An unsent draft shows in its thread** (owner: "don't want to go fetch
   them in the Drafts folder"). The mail list marks a thread holding an
   unsent reply or forward with a red **Draft** before its preview
   (`EmailThreadSummary.hasDraft`, from `threadsWithDrafts`; a message
   already queued to send (ADR 0115) is not a draft), and the open thread
   shows the reply draft as a card after the last message: who it is to and
   its opening lines, tap to continue it. The Drafts folder stays.

## Consequences

- Replies are longer on the wire. A long thread's reply carries the whole
  history once, as every client's does.
- Remote images in the quoted original load in the recipient's client, as
  they do when any client quotes.
- An original Chord never fetched a body for is not quoted.

## Rejected

- **Putting the quote in the box.** The box would open with pages of
  someone else's text on a phone, autosave would store it, and the AI draft
  would have to be told to leave it alone.
- **Quoting as plain text only.** The point of the report is that the
  formatting went missing.
- **Letting Gmail add the quote.** The API sends exactly the MIME it is
  given; Gmail's web composer adds the quote, not the send endpoint.
- **Re-attaching `cid:` images.** Costs a provider fetch per inline picture
  on every reply, for logos the recipient already has.
- **A rich text editor for the box.** A native module and a new build (ADR
  0260 already rejected it).
