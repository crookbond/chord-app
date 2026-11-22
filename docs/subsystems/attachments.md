# Attachments

## Upload

`POST /api/v1/groups/:id/files` — multer memory storage, field name `file`, 20 MB ceiling.

Pipeline (`services/attachments.service.ts`):
1. Generate `a_<nanoid>` id.
2. `mkdir -p data/files/group/<gid>/<attId>/`.
3. Sanitise filename (`[^a-zA-Z0-9._-]` → `_`, truncated to 128 chars).
4. Write buffer to disk.
5. Insert row with `indexed_at=NULL`, `summary=NULL`, `extracted_text=NULL`.
6. **Fire-and-forget** `runAttachmentExtraction(...)` — the upload response returns immediately.

## Extraction (`attachments.extract.ts`)

Handles three format families:
- **Text-like** (`text/*`, or extension in `{txt, md, markdown, json, csv, tsv, log, yaml, yml, ini, conf}`) — `fs.readFile(path, 'utf8')`.
- **PDF** (`application/pdf` or `.pdf`) — `pdf-parse` dynamic import.
- **Everything else** — skipped; `extracted_text` stays NULL.

`extracted_text` is truncated to 40 000 characters before storage.

## Summarisation

If extraction yielded text, we ask the configured LLM for a ≤400-token bullet summary. Prompt instructs: capture dates, IDs, names, key facts; omit meta-commentary. Failure is logged and the row still gets `indexed_at` set with `summary=NULL`.

When `LLM_PROVIDER=mock`, the mock provider produces a canned bullet list regardless of content — good enough to exercise the plumbing.

## Scope + privacy

- `scope_kind` is `group` or `user`. Current upload route only creates `group`-scope rows; a `POST /users/me/files` endpoint is a planned extension for private uploads.
- Download (`GET /attachments/:id`): group-scope files require membership; user-scope requires `att.scope.userId === req.userId`.

## Bot context

See [bot.md](./bot.md) for how summaries are injected. Briefly:
- Bot sees up to 12 summaries per turn — pinned first, then most-recent.
- Filename and summary are both in-prompt; the bot can refer to "Nolan school calendar" and the reader knows what it's citing.

## Pinning

`PATCH /attachments/:id { pinned: true }`. A pinned attachment is always injected (subject to the 12-item cap). Intended use: calendars, reference docs, travel confirmations.

## Mobile upload UX

`expo-document-picker` in `mobile/app/groups/[id]/index.tsx`. Picks one file, uploads, then immediately posts a `📎 {filename}` chat message that references `attachment.id`. The file bubble renders the same as a normal text bubble right now — we haven't added a specialised file-bubble with MIME icon yet.

## Known gaps

- **No OCR**. Scanned PDFs give empty text.
- **No DOCX / XLSX / PPTX** support.
- **No thumbnails or inline image rendering** in the chat bubble.
- **Email ingestion not wired** — the ingest address is purely decorative.
- **No deduping or content-hash checks** — uploading the same file twice creates two attachments.
- **Extraction is fire-and-forget** — if the process restarts mid-extraction, the attachment stays `indexed_at=NULL` and will never be re-processed. Add a "pending extraction" sweep on boot if this matters.
