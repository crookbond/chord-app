# 0305: A PDF opens inside Chord on the web too

Date: 2026-10-27
Status: Accepted
Extends: the in-app PDF viewer for iPhone and Android (`mobile/app/file-viewer.tsx`, commits 12f4f645 / c070019c)
Respects: [ADR 0269](./0269-what-the-security-questionnaire-says-is-true.md) (file headers, no token in a URL)

## Context

On the phones a PDF attachment opens in Chord's own viewer. On the web it left
the app: Firefox opened a new tab, Chrome downloaded it. Gmail shows the PDF
inside the mail page, and the owner asked for the same.

Why the two browsers differed, traced before changing anything:

- The web app never opens a file route directly. The API authenticates with
  the `x-chord-token` header, not a cookie, so a plain link would arrive with
  no session (and ADR 0269 removed `?token=` outside the two SSE streams). Every
  web open already did `fetch` with the header, `res.blob()`, then
  `window.open(URL.createObjectURL(blob), '_blank')` (`fetchAttachmentBlobUrl`,
  `fetchEmailAttachmentBlobUrl`, `open-email-attachment.ts`, the chat and
  To Do's file cards).
- A `blob:` URL carries no headers. The server's `Content-Disposition: inline`
  (ADR 0269 `safeFileHeaders`, inline only for images and PDF) and `nosniff`
  never reach the browser that opens the blob; the only thing that survives is
  the blob's TYPE, which is the response's `Content-Type`.
- For an email attachment that type is whatever the sender's mail client
  wrote (`attachment-fetch.ts`: the provider part's `mimeType`, else
  `application/octet-stream`). Many clients label a PDF
  `application/octet-stream`. A new tab holding an `octet-stream` blob is a
  download in Chrome. A correctly typed one is shown by the browser's viewer in
  a new tab, which is what Firefox did. So "Firefox: new tab" is the code
  working as written, and "Chrome: download" is the sender's label (or Chrome's
  own "Download PDFs" setting, which no page can override).

## Decision

**A PDF opens in the same viewer screen on every platform.** On the web,
`showPdfOnWeb` (`mobile/src/api.ts`) fetches the bytes with the session header
as before, and:

1. checks they start like a PDF (`looksLikePdf`: `%PDF-` in the first 1024
   bytes, the spec's allowance);
2. wraps them in a new blob typed `application/pdf` — the sender's label is
   dropped, which is what stops Chrome downloading it;
3. pushes `/file-viewer` with the `blob:` URL, where the web branch draws it in
   an `<iframe>`: the browser's own PDF viewer (PDFium in Chrome, pdf.js in
   Firefox, Safari's), no new library. The header has X (close) and Download
   (an `<a download>` on the same blob). The URL is revoked when the viewer
   unmounts. A reload of `/file-viewer` keeps the address but not the blob, so
   the screen checks it and says to close and tap the file again.

**Which files go there is one kernel rule**, `opensInPdfViewer(mimeType,
filename)` (`kernel/src/pdf-viewer.ts`): a PDF type, or a generic type
(`octet-stream`, empty, `force-download`) with a `.pdf` name. A NAMED other
type (`text/html`, `image/png`) never does whatever the name says. Decided
before the fetch, so every other file keeps its synchronous
`window.open('', '_blank')` (popup-blocker safe) exactly as before.

**A file that claims to be a PDF but is not is downloaded**, not shown: the
relabel is only safe because the bytes were checked. An HTML file named
`x.pdf` therefore never renders on our origin — it would not anyway (a blob
typed `application/pdf` goes to the PDF viewer, not the HTML parser), but the
check keeps the viewer from showing a broken frame for it.

No server change: ADR 0269's headers stay as they are, and nothing puts the
session in a URL. Images keep the lightbox. The phones are unchanged (they
already used this screen; their call sites take the same `opensInPdfViewer`
decision only on the web branch).

## Consequences

- Chrome with "Download PDFs" turned on (chrome://settings/content/pdfDocuments)
  still downloads, from inside the iframe; no page can override that setting.
- Mobile Safari (iPhone/iPad browsers, not the app) draws only the first page
  of a PDF in an iframe. The Download button still gets the whole file; the
  native app is unaffected (WebView renders it fully). If this matters, the web
  branch can draw pages with pdf.js as the Android branch does.
- The blob lives as long as the viewer, not 60 seconds after a tab opened.

## Rejected

- **Changing the server's `Content-Type` to `application/pdf` for `.pdf`
  names.** Fixes Chrome's download but not the new tab, and trusts a name the
  sender chose in a header ADR 0269 deliberately derives from the type.
- **A plain link with a cookie or `?token=`.** ADR 0269 removed URL tokens;
  the API has no cookie session.
- **pdf.js on the web.** Works everywhere, but the browsers' own viewers are
  better (search, zoom, print) and need nothing loaded. Kept as the fallback
  for the Mobile Safari case above.
- **A sandboxed iframe.** Chrome refuses to draw a PDF in one.
