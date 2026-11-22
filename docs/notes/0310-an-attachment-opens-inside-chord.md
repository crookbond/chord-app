# 0310: An attachment opens inside Chord, and an Office file is read like a PDF

Date: 2026-10-30
Status: Accepted
Extends: [ADR 0305](./0305-a-pdf-opens-inside-chord-on-the-web-too.md) (PDF viewer on the web), the phone PDF viewer (`mobile/app/file-viewer.tsx`)
Extends: [ADR 0071](./0071-email-attachments-into-knowledge-base.md) (attachments feed extraction and the auto-filers)
Respects: [ADR 0269](./0269-what-the-security-questionnaire-says-is-true.md) (no token in a URL, active types never rendered)

## Context

Only a PDF opened inside Chord. A Word document, spreadsheet, slide deck, text
file or photo went to the iOS share sheet, to another Android app (Chord has
to hand the file over: Android has no viewer an app can host), or to a new
browser tab or a download. The owner asked that attachments stay in the app.

Separately, an Office file was never READ: `extractAndSummarize` handled
images, PDFs and plain text, so a school schedule sent as `.docx` or `.xlsx`
had no extracted text, was not searchable by content, and never reached the
auto-filer (`classifyAndAutoFileAttachment`) that turns a document into trips,
events and other action cards. The owner asked that this be true on the
iPhone; it is server-side, so it is true everywhere.

What each platform can draw, checked:

- **iOS**: the web view (WKWebView, already the PDF viewer) draws Word, Excel,
  PowerPoint, Pages/Numbers/Keynote, RTF, images, audio and video from a local
  file, chosen by its extension. Apple's Quick Look controller is a little
  better (slide paging) but is a native module and a store build.
- **Android**: the web view draws HTML, images and text only. Nothing else is
  available in-process, so Chord must render the file itself.
- **Web**: the browser draws PDF, images, audio and video; nothing else.

## Decision

**One viewer screen and one kernel rule for every file.** `fileViewerPlan(mime,
name, platform)` (`kernel/src/file-viewer.ts`) gives the file's format and how
it is drawn, or null to keep the old behaviour (share sheet / other app /
download). The format comes from type and name as ADR 0305 did for PDF: a
generic type (`octet-stream`, `zip`, empty) defers to the name, a named type of
the same family is refined by it (`application/msword` on a `.docx`;
`application/vnd.ms-excel` on a `.csv`, since Windows labels every CSV so), and
a named type of another kind wins outright (`text/html` named `x.docx` is not
shown). HTML and SVG are never shown anywhere.

Drawn by:

| | iOS | Android | Web |
|---|---|---|---|
| PDF | web view | pdf.js page | browser |
| Word `.docx` | web view | docx-preview page | docx-preview page |
| `.doc`, `.rtf`, PowerPoint, Pages, Numbers, Keynote | web view | not shown | not shown |
| Excel `.xlsx`/`.xls`, `.ods`, CSV | web view (CSV/ODS: SheetJS page) | SheetJS page | SheetJS page |
| text (`.txt`, `.md`, `.json`, `.log`, …) | text page | text page | text page |
| images | web view | image page | browser |
| audio / video | web view | not shown | browser |

**The bytes must match the format before anything is drawn**
(`bytesMatchFormat`: zip / OLE / RTF / PDF / image signatures; text = no NUL in
the first 1024 bytes). A file that only claims a format goes to Share /
Download. On the phones the first 1024 bytes are read from the downloaded copy;
the copy is saved with the format's extension when its name lacks one
(`viewerFileName`), because the iOS web view decides by extension.

**Chord's own pages** (`mobile/src/file-render-page.ts`) carry the file inside
the page as base64, so the file never leaves the device. They load only the
pinned library, each with a subresource-integrity hash (jszip 3.10.1,
docx-preview 0.3.5 from jsDelivr, SheetJS 0.20.3 from SheetJS's own CDN since
the npm/cdnjs copies stop at 0.18.5 with known security fixes missing), and a
content security policy allows nothing else (`connect-src 'none'`, images and
fonts from `data:` only). Spreadsheet and text cells are written with
`textContent`, never as HTML. On web the page runs in an iframe with
`sandbox="allow-scripts"` and no `allow-same-origin`, so it has an origin of
its own and cannot reach Chord's storage or session; it reports `loaded` /
`error:` by `postMessage`, checked against the iframe's window. On the iPhone
a file the web view draws itself is shown with script OFF (a PDF keeps the
setting it shipped with). The Android PDF page is the pdf.js page that shipped
before, unchanged. Files over 15 MB are not written into a page.

**Office files are read on the server** (`server/src/services/office-text.ts`):
`.docx` (body, footnotes, endnotes), `.xlsx` (every sheet, shared strings, and
date-formatted cells turned into dates, since a serial number is not a date to
the model), `.pptx` (slides in order), `.odt`/`.ods`/`.odp`, and `.rtf`. These
are zip archives of XML, read with `adm-zip` and `htmlparser2` (both already
dependencies); nothing is rendered or run. Archives are capped (5,000 entries,
30 MB per part, 60 MB in all, checked from the headers before inflating) so a
zip bomb costs nothing. The text then takes the same path as a PDF's:
stored (sealed, ADR 0201), indexed, summarised, and handed to the auto-filer,
so an Office attachment yields the action cards a PDF would.

No bot tool: viewing changes nothing (CLAUDE.md's rule is for new ways to
change something).

## Consequences

- No native module, so this ships as an over-the-air update on both phones.
- Android still hands PowerPoint, `.doc`, `.rtf`, iWork files and audio/video
  to another app, and the web still downloads them. No JavaScript renderer for
  those is good enough; converting them to PDF on the server (LibreOffice) is
  the way to cover them and is not built.
- docx-preview handles ordinary documents well and complex layouts (text
  boxes, floating images) approximately. On a narrow screen pages flow to the
  screen width instead of being drawn at paper size.
- A spreadsheet shows at most 2,000 rows and 60 columns per sheet and says
  when it cut. Formulas show their computed values.
- The viewer pages fetch their library from a CDN on first open; offline, they
  show the error and Share / Download. The integrity hash means a changed file
  on the CDN fails to load rather than running.
- Not read on the server: old binary `.doc`/`.xls`/`.ppt`, Pages/Numbers/Keynote.
  Their text would need another dependency; left until asked.

## Rejected

- **Google Docs / Office Online viewers.** They need the file at a public URL
  and send it to Google or Microsoft, which breaks ADR 0201's sealing.
- **Quick Look (iOS) now.** Better slide paging; a native module and a store
  build for little gain over the web view.
- **LibreOffice on the server for everything.** Covers every format on every
  platform, but means a large install, CPU per conversion, and parsing hostile
  documents in a big C++ program on the server. Kept as the next step if the
  formats above prove to matter.
- **Bundling the libraries into the app.** Keeps them offline, but the SheetJS
  build alone is ~1 MB, and putting it in the JS bundle loads it for every
  user on every launch; the pinned CDN copy with an integrity hash is what
  pdf.js already does.
- **Rendering HTML attachments.** An HTML file in mail is a phishing page as
  often as not; it stays a download.
