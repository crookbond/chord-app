# 0036 — Bot delivers files by re-posting the attachment, not a URL

**Status**: accepted
**Date**: 2026-05-22
**Related**: [ADR 0003 — Text-fence tool protocol](./0003-text-based-tool-protocol.md),
[ADR 0005 — Iterative tool use](./0005-iterative-tool-use.md)

## Context

When a user asked the bot for a file already in the chat ("give me the
Lakeside calendar PDF"), it replied with a **fabricated** URL such as
`https://example.com/LakesideCalendar2026-2027_updated20260112.pdf
(link saved)` — and persisted it via `save_link`.

Root cause was an integration gap, not a model defect:

1. The attachment context block (`attachmentBlock` in
   `server/src/services/bot/context.ts`) injected each file's filename,
   summary, and extracted text — but **no identifier and no URL**. The model
   had no ground-truth handle for the file.
2. The only file-shaped tool was `save_link`, whose schema requires a
   `z.string().url()`. Asked for "the file," the model had no real URL, so it
   synthesized a plausible one from the filename/dates it could see; the string
   passed URL validation and `save_link` "succeeded."

A URL is also the wrong primitive here: `GET /api/v1/attachments/:id`
(`server/src/routes/files.ts`) is session-authenticated, so any link the bot
emits resolves only in-app / same-origin and 401s in an anonymous external
browser. Handing the user a URL would trade a fabricated link for a misleading
one.

## Decision

The file is already in the chat — **send it, don't link it.** Messages already
support files first-class (`kind: 'file'` + `attachmentId`,
`kernel/src/types/message.ts`), and the mobile client renders any message
carrying an `attachmentId` as an authenticated, downloadable `AttachmentCard`
regardless of sender (`mobile/app/groups/[id]/index.tsx`).

So:

- **New `send_file { attachmentId, note? }` tool.** The executor resolves the
  attachment, applies the same scope gate as `look_at_attachment` (a file owned
  by *this* group, or one the asker uploaded personally — never a sibling
  group's), and posts a bot-authored `kind: 'file'` message referencing the
  real attachment id, broadcast over `SSE.message`. The model passes an opaque
  id, so there is nothing to hallucinate.
- **Expose the attachment id in the prompt.** `attachmentBlock` now emits
  `· id <id>` per file. This also closes a latent gap: `look_at_attachment`'s
  description already told the model to "pass the attachmentId from the system
  prompt's attachment block," but the block never contained one.
- **Instruct against link fabrication.** The files block and both tool prompts
  (native + text-fence) now state: to send a file use `send_file`; never
  invent/paste a URL for a file; `save_link` is for external web pages only.

`send_file` is a write tool (not read-only), not personal-only, and not
proposable (no confirmation step — re-posting an existing visible file is
benign).

## Consequences

- The bot can no longer satisfy "give me the file" by inventing a URL; it
  delivers the actual file, which renders as a tappable download in-app.
- External-bridge delivery is **out of scope**: `send_file` posts with
  `autoMirror: false`, so a user who asked from Telegram/Slack sees the file in
  the Chord app, not pushed over the bridge. Mirroring files to connectors
  (which need per-platform upload support) is future work.
- `save_link` keeps its meaning — external web links the user provides — and is
  explicitly steered away from files already in the chat.
