# 0260 — A signature can be rich, and every send asks one function for it

**Status**: accepted
**Date**: 2026-10-16
**Extends**: ADR 0069 (plain-text signature), ADR 0131 (formatting is a small vocabulary)

## Context

The owner's signature is a web link. ADR 0069 made the signature plain text, and
ADR 0131 let a `[text](url)` in a body become a link in the HTML half, but a signature
that was more than a line of text (a link, a logo, a colour, a small table) had no way
to be one.

Looking at how the signature got onto a message found a worse problem than the missing
feature: it was appended in **eight places** (compose and reply, for Gmail, an attached
Gmail, Outlook and IMAP), each copied from the one before at a different time. They
differed in spelling, in whether the HTML was built once or twice (the IMAP and Outlook
replies built it again for the stored sent copy), and in what they read from the user
row; Outlook sends HTML only and never a text part. None of that was a decision.
Adding "rich" to eight copies would have been eight chances to drift again.

## Decision

- **One function builds the bodies.** `withSignature(body, user)` in
  `services/email/signature.ts` returns the text half and the HTML half, and all eight
  sends call it. A test (`every send path asks the same function`) fails the build if any
  other file builds the `-- ` separator itself. A plain-text signature produces
  byte-for-byte what every path used to.
- **A signature is plain text or cleaned HTML.** `users.email_signature_html` (migration
  110) holds the HTML; `email_signature` stays the plain text, and when there is HTML it
  is **derived** from it (links keep their address: `My site (https://…)`), so the text
  half of a message is still readable and the two can never disagree. Outlook, which
  sends HTML only, loses nothing.
- **The HTML is cleaned on the server, on the way in.** It is pasted from anywhere and
  goes out under the person's name, so it passes an allow-list (`sanitize-html`): links,
  bold / italic / underline, line breaks, lists, simple tables, and images — **https
  only** — plus a short list of harmless styles (colour, font, size, weight, alignment,
  padding, a border). Scripts, event handlers, `javascript:` links, `data:` and `cid:` and
  plain-http images, iframes, forms, objects, `<style>` and `<link>`, `<base>`, `<meta>`,
  SVG, and any style that fetches a resource (`url()`), runs (`expression()`) or positions
  itself off the page are removed. What is stored is what was kept, and Settings reads it
  back so the person sees what was kept, not what they typed.
- **Setting one means replacing the other.** Typing a plain signature clears the HTML
  (the old HTML must not ride out beside the new text); clearing the HTML clears it.
  One rule, `signaturePatch`, used by the Settings route and the bot.
- **Settings.** The Signature field stays; under it, *Use a rich (HTML) signature* swaps
  it for a monospace HTML editor with a live preview (the person's own images load
  directly there — `EmailBody ownContent` — because they chose them) and *Use plain text
  instead* goes back.
- **Chat.** `set_email_signature { text?, html?, clear? }` (personal 1:1 only), which was
  missing even for the plain signature. It writes straight away (the user said it),
  cleans like the route, and reports whether the result is rich.

## Consequences

- A signature image is a remote https URL the recipient's mail client fetches, so the
  sender can see it was opened. That is the person's own choice for their own mail; there
  is no upload, because hosting a public image endpoint is a different feature.
- Not done: importing the existing signature from Gmail / Outlook (needs scopes we do not
  hold), a WYSIWYG editor, per-mailbox signatures, or a different signature for replies.
- A rich signature that cleans down to nothing is refused rather than saved as empty.

## Rejected

- **Allowing raw HTML through to the message.** A signature is the one place a pasted
  blob goes straight into outgoing mail.
- **Leaving the eight copies and adding HTML to each.**
- **Keeping the HTML as the only form.** The text half of a message and the stored sent
  copy both need plain text.

## Addendum 2026-10-22: the signature is in the box, not added at send

The signature was appended at send time, so the composer never showed it. People
could not tell whether it would go, and deleting it was impossible. Owner rule: show
it while typing, send what is in the box, and if the user deletes it, none goes.

- **The composer opens with it.** New message, reply and forward start with a blank
  line, then `-- ` and the plain signature (`bodyWithSignature` in
  `kernel/src/email-signature.ts`, one rule for the app and the server). A resumed
  draft is left as it was saved. A box holding only the signature counts as empty:
  nothing is autosaved, Send stays off, and a saved draft can still be restored
  over it (`isOnlySignature`).
- **The send adds nothing.** `withSignature` is now `outgoingBodies`: the text half
  is the body exactly. When the body still holds the user's signature unchanged and
  they have a rich one, the HTML half shows the rich version in its place
  (`findSignature`); an edited signature is the person's own text and goes out as
  written. In a forward the note, signature included, stays above the forwarded
  message.
- **An AI draft rewrites only the text above it.** The app sends the part above the
  signature as the draft to revise and puts the signature back under the answer,
  unless the user had deleted it. The prompts no longer say the app appends one.
- **Mail nobody types gets it when it is made**, so the send path stays the same for
  everything: a chat-drafted new message or forward note (`queueComposedEmail` /
  `queueForwardedEmail`, which also covers the family invite), a chat reply on
  confirm, and the vacation auto-reply. A chat reply opened with Edit gets it in the
  box like any reply. The unsubscribe `mailto:` request goes without one (a machine
  reads it).
- **The app learns the signature from Settings** (`useEmailSignature`, re-read each
  time a composer opens).

Consequence: an app build from before this change shows no signature and, with this
server, sends none. That matches what it showed. It is fixed by the update.

Rejected: keeping the append and only showing a read-only preview (cannot be
deleted, the request), a per-message "include signature" switch (one more control
for what deleting the text already says), and sending the rich HTML whenever the
plain text is still present but edited (that would send what the user removed).

## Addendum 2026-11-06: a signature per mailbox

Reported: every mailbox sent the same signature, so mail from a work
Outlook went out signed like personal Gmail. Each mailbox can now have its
own. Stored in `users.defaults` key `mailbox_signatures` (`{ ['primary' | accountId]: { text, html } }`,
no migration); a mailbox with no entry uses the shared `users.email_signature` /
`email_signature_html` as before, and an entry with both halves null means that
mailbox sends none. One reader, `mailboxSignatureRow(db, userId, accountId)`, used
by every send path (primary and attached Gmail, Outlook, IMAP, the Drafts-folder
copy), `signedBody` (chat-drafted mail, now given the sending mailbox) and the
vacation reply (the mailbox it answers from). One writer, `setMailboxSignature`
(same `signaturePatch` cleaning), behind `PUT /me/email/mailbox-signature`
(`useShared: true` drops a mailbox's own) and `set_email_signature`'s new
`mailbox` / `useShared` fields; the bot's `mailbox` is honoured only when the
conversation named it (ADR 0229), else the shared signature changes. Composers
open with the signature of the mailbox the mail leaves from (thread's for reply
and forward, `EmailForwardPreview.accountId`), and changing From in a new
message swaps an untouched signature for the new mailbox's (`swapSignature`,
kernel); an edited one is left alone. Settings shows "All mailboxes" plus a
chip per mailbox when there are two or more. Rejected: a column per account
(the primary has no account row, ADR 0145's asymmetry) and copying the shared
signature into every mailbox (a later shared edit would reach none of them).

**Default signature (owner, 2026-11-06).** Someone who never set a shared
signature signs with `DEFAULT_EMAIL_SIGNATURE`, "Get Chord at https://www.chordapp.ai"
(`sharedSignature` in kernel, read by `mailboxSignatureRow` and `GET /me/settings`).
NULL now means never set; clearing writes '' (`signaturePatch`), which means none.
Rows cleared before this change were stored NULL and so get the default too:
they cannot be told apart from never-set.

**An outdated signature in the box (2026-11-13).** Prod: a reply to Hunter
from the Neural Outlook mailbox went out with no rich signature. Its reply
draft held an older copy of that mailbox's signature (the email link read
`tom@neuralads.ai`, since corrected to `john@`), and the send uses the rich
version only for an exact text match, so it went as typed text with nothing
said. A box opened with a stale cached signature, or a draft saved before the
signature changed, ends up the same way. Now: the reply and forward composers
swap an untouched signature when the saved one changes while they are open
(`useSignatureFollow`, as the new-message composer already did on a From
change); every composer shows a note when the box ends in a `-- ` block that is
not the saved signature (`hasOutdatedSignature`), with **Use saved signature**
(`replaceOutdatedSignature`) or **Keep this one**; and the send logs a warning
when a rich signature is not used because of such a block. Not done: replacing
it without asking (it may be an edit made on purpose for this one message).

**A rich signature is edited as it looks (owner, 2026-11-13).** Settings no
longer opens a rich signature as a box of HTML. It is drawn in a page of its
own whose body is editable (`RichSignatureEditor`: a sandboxed iframe on web
with only `allow-scripts`, a WebView on a phone; the page document and its
script are `signatureEditorDocument` / `SIGNATURE_EDITOR_SCRIPT` in kernel).
Typing changes the words; clicking or tapping a link opens a field for where
it goes (`signatureLinkInput` turns an address, site or phone number into a
link; `setSignatureLinkHref` writes it, or removes the link and keeps its
text). The HTML is behind **Edit HTML**. The page reports its HTML to the app
(`parseSignatureEditorMessage` reads it), and saving goes through the same
server clean-up as before, so the page itself is trusted with nothing. The
page is rebuilt only when the HTML changes from outside it (paste, picture,
link edit, another mailbox), so typing keeps the caret. Rejected: a WYSIWYG
library (a native module and a new build), hiding the HTML with no way to edit
(a wrong link, the prod case, could then only be fixed by pasting the whole
signature again).
