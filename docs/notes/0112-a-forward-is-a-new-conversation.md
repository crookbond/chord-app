# 0112 — A forward is a new conversation

**Status**: accepted
**Date**: 2026-08-25
**Relation**: built on [ADR 0111](./0111-a-file-is-sent-by-id-not-by-bytes.md),
which it was waiting for; completes Wave 2 outbound in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md) alongside
compose (ADR 0107) and reply (ADR 0069).

## Context

Forward is the last of the three ways a person sends mail, and the audit had it
sitting behind attachments for a reason: **a forward that arrives without the
file the sender meant to pass on has failed in the one way the sender cannot
see.** Passing on the attachment *is* the forward, most of the time. So it
could not ship until ADR 0111 made attachments real.

The shape question is whether forward is a variant of reply — same composer,
different recipients — or its own thing.

## Decision

**Its own thing, because the audience is new.**

Everything follows from that:

- **No threading headers.** A reply belongs in a conversation the recipients
  are already part of. A forward goes to someone who was never in it, and
  `In-Reply-To` pointing at a message they cannot see does nothing useful.
- **The original is quoted, not appended to.** The
  `---------- Forwarded message ----------` block with From / Date / Subject /
  To is what every client has used for twenty years, and it is the only part
  of a forward the recipient reads for context.
- **Plain text, from `body_text`.** Not a reconstructed HTML quote. The sender
  is passing on what they read, and a re-rendered version would silently differ
  from it. (ADR 0110 means `body_text` now exists for every mirrored message,
  including HTML-only ones, so this is no longer a thin quote.)
- **Its own screen**, with the recipient field focused and the note empty. A
  reply already has its recipients and wants the cursor in the body; a forward
  is the reverse.
- **The note is optional.** "Here, look at this" is the whole message most of
  the time, and requiring text to send would be a lie about what forwarding is.

### The newest message, not a chosen one

"Forward this email" means the thing on screen, and the reader opens on the
latest message. Per-message forward is a bigger UI — a control on every message
in the thread — than it is worth before anyone asks.

### A file we cannot fetch stops the send

The original's attachments are pulled from the **provider** at forward time
(they were never stored — ADR 0080 streams them on demand). If one cannot be
fetched, the forward is **refused whole**, not sent thin.

Both failure shapes are caught: `fetchEmailAttachmentData` returns null for a
part it cannot address and **throws** when the provider 404s it. Only the null
case was handled at first, and the test caught it — a raw
`mock gmail: attachment … not found` would have reached the route as a 500
where the sender needed a sentence (ADR 0102).

`includeAttachments: false` is the way to send it without them. That is the
sender's decision to make, offered as a switch, and not one to make for them
silently.

## Consequences

- Wave 2 outbound is complete: compose, reply, reply-all, forward, attachments.
- A forward is not mirrored into the thread it came from, because it is not
  part of it. On Gmail it appears in Sent on the next sync (ADR 0108); on
  Outlook and IMAP it does not, which is the same partial-Sent limitation that
  folder already states on its banner.
- `checkOutgoingSize` had to come out of `loadOutgoingAttachments`: a forward
  carries files fetched from the provider, which never pass through the loader,
  and a limit enforced on one of two paths is not a limit.

## Alternatives rejected

**Forward as a mode of the reply box.** Fewer files, and wrong in use: the
recipient field is the first thing a forward needs and the last thing a reply
does. It also makes "reply" the concept that owns sending, when the thing they
share is a MIME builder, not an intent.

**Keeping the threading headers so it stays in the conversation.** Tidy in the
sender's mailbox, confusing in the recipient's, where it references a message
they were never sent.

**Quoting the HTML body.** Closer to what the sender saw on screen, at the cost
of re-rendering someone else's markup into a new message — and of differing
from it in ways nobody would notice until it mattered.

**Sending what we can and warning about the rest.** The ADR 0107 failure with
extra steps. A warning does not un-send a forward that arrived without its
attachment.

## Addendum 2026-10-27: the sender sees what they forward, and it is the message they picked

The forward screen showed only the sender's note. The quoted original was built
on the server at send time, so nobody saw what they were passing on until it
had gone - and it was always the newest message, even when the reader had
another one open.

**What is shown is what is sent, from one source.** `GET
/me/email/threads/:id/forward/preview` returns the header lines, the body and
the original's files, read by the same `loadForwardSource` the send uses and
built by the same kernel `forwardHeaderLines` / `buildForwardBody`
(`kernel/src/email-forward.ts`). The composer shows it under the note, read-only:
the header, the full body (quoted history unfolded - it all goes), and each file
by name, struck through when "Include the original files" is off. The switch is
shown only when there are files. A test reads the sent MIME back from the Gmail
mock and checks it contains exactly the previewed header and body.

**The quoted body is the visible text, not `body_text`.** The decision the
preview forced: the reader shows the HTML, and the send quoted the text/plain
part, which can say something else (ADR 0268) or be missing. Both now use
`bodyForModel`: the HTML rendered to visible text when the message has any,
else the plain part. The forward stays plain text (the twenty-year format and
this ADR's rejection of quoting HTML stand), so the preview renders that text
through `EmailBody` with no HTML, no images and no tappable links - which also
satisfies the ADR 0120/0136 image rules and the ADR 0294 danger rule by
construction, and is truthful because it is the text the recipient gets.

**A message nobody opened is fetched first.** Found while checking the preview:
a body (and its part list) is stored when the thread is opened, so forwarding
a message that had not been opened - a resumed draft, or an older message in
the thread - quoted an empty body and carried no files, with no error. The
shared loader now fetches it the way opening the thread does
(`getThread` / `getAccountThread`) when either is missing. The other places
that pass a body on (bot `read_email`, share-to-group) already read through
`getThread`.

**The Date line is readable.** It was the stored ISO instant; it is now "Tue,
Oct 27, 2026 at 10:03 AM" in the forwarder's zone (`users.last_tz`, else
`BRIEFING_DEFAULT_TZ`) via `forwardDateLabel`.

**Forward passes on the selected message.** Owner direction: forward the
email selected in the thread. That is the message the reader's bar already
answers (the one opened last, ADR 0222), else the newest - for forward the
plain newest, not the reply target, since forwarding your own sent message is
a real thing to want. The Forward row names it ("Ms Chen · Oct 20") in a
multi-message thread, the screen takes it as `?message=`, and the request and
preview carry an optional `messageId`. A message id not in that thread returns
nothing (404), never a fallback to the newest: forwarding a different message
than the one shown is the failure this fixes. The send passes the id the
preview showed, so the two cannot drift.

**A forward draft remembers its message.** `email_drafts.forward_message_id`
(migration `132`; 130 is held by an open PR), null = the thread's newest,
which is what every earlier forward draft meant. The composer's autosave
stores the message its preview shows, Drafts reopens the forward on it, and
the outbox (ADR 0115) forwards it. A save that omits the field leaves the
stored value alone, so an older app's autosave cannot unpin it. A selection
made just now in the reader beats the one on the draft.

**Chat: the card is the check.** Owner direction: "forward from X to Y - show
the mail preview in bot, confirm that's the email and forward". `forward_email`
(ADR 0214) already staged a confirm card, but it named only the subject. Now,
when the card is staged, the server runs the same `forwardPreview` and puts the
sender, date, opening 280 characters and file names on it, and pins that
message (`messageId`) - the tap forwards exactly what the card showed, even if
a reply lands in between. These fields are hidden from the model's schema and
overwritten at staging, so a model cannot put words on the card the email does
not contain. The description gives the recipe for "forward from <sender> to
<person>": `search` with `from`, take the newest hit unless the user named a
subject or date. The app's confirm row shows the whole preview (like a reply
draft); WhatsApp/Telegram print the card's lines. No new tool: the existing one
gained what it was missing.

Consequences: the note no longer fills the screen - it grows with its text and
the whole page scrolls (`KeyboardScrollView`, ADR 0297), so the note stays
reachable above a long email. The copy in the mailbox's own Drafts folder
(ADR 0303) is built by the same loader (`forwardDraftContent`), so it quotes
the draft's message, as visible text, with the readable date - the same thing
the send will.

Rejected: quoting the HTML so the preview could render it richly (re-opens this
ADR's rejection, and every provider's MIME path), rendering the original HTML in
the preview while sending text (shows something other than what goes),
rebuilding the quote on the client from the thread detail (a second copy of the
rule, and the client cannot derive visible text the way the server does),
a separate "forward from X" bot tool (the existing `forward_email` plus
`search`'s `from` already find the email; a second tool would be a second
place to get the confirm step wrong), and letting the model choose the
message on the card (a card the model writes is not a check).
