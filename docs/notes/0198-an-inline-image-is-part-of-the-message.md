# 0198 — An inline image is part of the message

**Status**: accepted
**Date**: 2026-09-23

## Context

Prod report: the reader "does not pick up remote images". Remote images were
in fact loading through the ADR 0136 proxy; the image that was missing was
`<img src="cid:image626147.jpg@DD2A01E4.8287D995">` — a signature logo
carried as a part of the message itself. ADR 0120 had deliberately left
`cid:` unblocked ("those are the message's own attachments"), but nothing
ever resolved one to its bytes, so every inline image (logos, pasted photos,
screenshots in a reply) rendered as nothing. Worse on Outlook: Graph's
`hasAttachments` ignores inline parts, so the part list was stored as `[]`
and there was nothing to resolve against.

## Decision

- **Record the Content-ID with the part.** `EmailAttachmentRef.contentId`
  (normalized by the kernel's `normalizeContentId`: `<…>` and `cid:` stripped,
  percent-decoded, lower-cased) is captured for Gmail (the part's
  `Content-ID` header — nameless inline parts now count too), Outlook
  (`isInline` on the list, then a per-part read for `contentId`, since Graph
  cannot `$select` a `fileAttachment` property on the base collection) and
  IMAP (mailparser's `cid`). Outlook lists parts whenever the body has a
  `cid:` reference, not only when `hasAttachments` is true.
- **Serve it by Content-ID.** `GET /me/email/inline?k=&m=&c=` authenticates
  with the ADR 0136 sealed image token (an `<img>` cannot send the session
  header), resolves the message row scoped to the token's user, matches the
  part by `contentId`, and returns it through the existing per-provider
  `fetchEmailAttachmentData` — `image/*` only, transparent pixel on any
  failure.
- **Not gated on the remote-image setting.** The bytes come from the
  reader's own mailbox; showing them tells no sender anything, so the
  sanitizer rewrites `cid:` whenever an inline resolver exists, independent
  of `blockRemoteImages`.
- **Heal on open.** `getThreadWith` treats a message whose body references
  `cid:` but whose part list carries no Content-ID as "missing", so rows
  stored before this re-read their parts once when opened.
- **Not a file.** A part the body already shows in place is left out of the
  attachment chips (and the folded-message paperclip).

## Consequences

- Inline images ride the image token, which is minted only when
  `EMAIL_IMAGE_PROXY` is on (the default). With the proxy off they stay
  unrendered, as before.
- A body referencing a Content-ID that no part carries re-reads the part list
  on each open of that thread — one provider call, bounded to thread opens of
  malformed mail.
- Print/share has no token and leaves `cid:` as is.

## Rejected

- **Matching `cid:` to a filename** (Outlook names inline parts after the
  local part of the Content-ID). A heuristic that works for one client's
  naming, when the real identifier is available.
- **Inlining the bytes as `data:` URIs server-side** on thread open. Every
  open would fetch every inline part and ship it in the JSON whether the
  message is ever unfolded; the URL route fetches only what renders.
