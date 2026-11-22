# ADR 0326 — A signature picture is kept by Chord, and a pasted signature keeps its pictures

**Status:** Accepted (2026-11-06)
**Amends:** [ADR 0260](./0260-a-signature-can-be-rich-and-built-in-one-place.md)

## Context

ADR 0260 made a signature rich HTML but kept only pictures at a public
`https://` address and left uploads out. In practice that ruled out most
signatures people actually have:

- **Outlook, Apple Mail and Word** put a signature's logo inside the copied
  HTML (`data:` URLs) or refer to a file only the copying app can read
  (`file:///…/clip_image001.png`, `cid:`, `blob:`, `webkit-fake-url:`). The
  cleaner dropped all of these, so the signature saved without its picture,
  and said nothing.
- **Pasting** a signature into the box brought across only its text: the box
  takes HTML code, and copying a rendered signature puts the rendered version
  on the clipboard. To include a picture, someone had to write
  `<img src="https://…">` by hand, pointing at a picture they had already put
  online somewhere.

The owner asked for both to work: a pasted signature keeps its pictures, and
pasting needs no knowledge of HTML.

## Decision

**Chord keeps the picture and serves it at a public, unguessable link.**

- `signature_images` (migration `141`): id (24 random characters), owner,
  type, bytes, SHA-256. The same picture twice from one user is one row, so
  re-pasting a signature does not pile up copies. At most 100 per user.
- `POST /api/v1/me/email/signature-images` (session) takes base64 and answers
  `{ url }`. The type is read from the **bytes** (PNG, JPEG, GIF, WebP), never
  from what the client says, and **SVG is refused** (it can carry script).
  A picture wider than 800 px or heavier than 300 KB is drawn smaller with
  `sharp` (already a dependency); an animated GIF is left alone unless it is
  too big to keep. Over 1 MB after shrinking (or ~1.45 MB sent) is refused
  with a sentence, never truncated.
- `GET /api/v1/signature-images/:id` needs **no session**: the people who
  load it are the recipients of mail the user sent, through their mail app
  or its image proxy. It answers the bytes with `nosniff`, `default-src
  'none'` and a year's immutable cache, and is mounted **before the general
  rate limit**, because one provider's image proxy fetches for many
  recipients from a few addresses.
- The link is built on the public site (`webOrigin()`, `/api/` goes to the
  server) in production, and on the address the app reached the server at
  elsewhere, so a dev preview can load it. Off production the signature
  cleaner lets an `http://` picture through **only** when it is one of these
  links; production still takes `https` only.
- **Not sealed** (ADR 0201): the picture goes out in mail to anyone the user
  writes to, so sealing it at rest protects nothing. It goes with the
  account (FK cascade); mail already sent then shows no picture, which is
  what deleting an account means.

**Pasting converts on the device.** The rules are in
`kernel/src/signature-paste.ts` (tested in the server suite):
`cleanPastedSignatureHtml` takes the copied fragment (`StartFragment`, else
`<body>`) and drops head/style/script/XML islands, comments, Word's VML
copies of a picture (keeping the `<img>` fallback beside them) and Office
namespaced tags, and **writes the `<style>` block's look onto the elements**
first: Outlook and Word keep a signature's font, size and colour in classes
(`p.MsoNormal`, `span.Title`), and the saved signature keeps only inline
styles, so without this the formatting went with the style block. Simple
selectors only (`tag`, `.class`, `tag.class`, comma lists), by specificity
then order, the element's own `style` last so it wins; `@media`/`@font-face`
and `mso-` declarations are left out, and the page's `body` style is carried
by a wrapping `<div>`. The server's allow-list then keeps what it always
kept (colour, font family/size/weight/style, alignment, spacing, borders);
`pastedImageNeed` `pastedImageNeed` says each picture is `keep` (https),
`upload` (a `data:image/…` in the HTML) or `from_clipboard` (a reference
only the copying app could read); `replaceImageSources` gives each picture
its new link by position, and drops one that has none rather than leaving
a broken image. `mobile/src/signature-paste.ts` uploads:

- **Web:** a paste into either signature box that carries HTML or a picture
  file is taken over (`useWebSignaturePaste`); a `from_clipboard` picture is
  matched, in order, to the image files the clipboard carried; plain text
  pastes as before. Pasting into the plain box turns the signature rich,
  keeping the text around the paste, and replaces Chord's own default line
  rather than keeping it. Wide pictures are drawn smaller on a canvas before
  upload.
- **iPhone and Android:** a text box cannot receive formatted paste, so
  **Paste signature** reads the clipboard's HTML and picture with
  `expo-clipboard` (already in the native build; HTML on both platforms,
  JPEG when a PNG would be too heavy). Same conversion.
- **Add picture** (all three) picks one from the photo library
  (`expo-image-picker`, already built in) and adds it under the signature.

Pictures that could not be kept are counted and said under the box.

**Chat:** `set_email_signature` gains `pictureFileId` — a picture the user
sent in this chat, added under the `text`/`html` given or under the current
signature. Only an image in this chat or the user's own upload may be used
(`look_at_attachment`'s rule). An id that names nothing here, beside text
to save, is treated as a filled-in field (ADR 0229) and the text is saved
without it; on its own it refuses and says nothing was saved.

**Found with it:** the whole Signature section in Settings sat inside the
"main Gmail connected" block, so someone with only an Outlook, Yahoo or
second Gmail mailbox could not set a signature at all (and the per-mailbox
chips of ADR 0260's addendum never showed for them). It now shows with any
mailbox connected.

## Consequences

- A recipient's mail app may block the picture until they choose to show
  images — the same as any linked picture. Embedding it as an attachment
  (`cid:`) was not chosen: each provider's send path would need a related
  part, and every message would carry the bytes.
- The dev web preview cannot show these pictures: its sandboxed frame (ADR
  0316) is refused anything on `localhost` by the browser. Production
  serves them from `https://chordapp.ai`, which the frame loads. Checked by
  loading a public https picture through the same kind of frame.
- Pictures are never deleted while the account lives: a signature changed
  today still leaves last month's mail pointing at the old picture.
- Not checked on a phone: the native Paste signature and Add picture
  buttons, and how each mail app on iOS/Android fills the clipboard.

## Rejected

- **Storing the `data:` URL in the signature.** Gmail and Outlook web strip
  `data:` images from received mail, and every message would carry the bytes.
- **Attaching the picture to each message (`cid:`).** Four send paths to
  change, the bytes in every message, and some clients show it as an
  attachment.
- **A WYSIWYG editor.** A new dependency and a native build; pasting into the
  existing box and reading the clipboard does the job.
- **Keeping SVG.** Script inside an image served from Chord's own origin.
- **Sealing the bytes.** They are sent to strangers by design.
