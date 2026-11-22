# 0037 — User-managed files: Catchup "Files" tab + path-aware delete

**Status**: accepted
**Date**: 2026-05-22
**Related**: [ADR 0006 — Keyword retrieval](./0006-keyword-retrieval.md),
[ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md),
[ADR 0036 — Bot sends files, not links](./0036-bot-sends-files-not-links.md)

## Context

Until now a user could upload files but never see the full set or remove
one. Two problems followed:

1. **Stale retrieval.** Indexing is additive — a corrected re-upload doesn't
   supersede the old version, so BM25 keeps surfacing both. The only fix was
   deleting the bad file, which had no UI and no endpoint.
2. **No inventory view.** Files were only visible inline in chat history.

## Decision

Add a **"Files" tab** to Catchup, alongside Tasks / Lists / Saves / Trips,
and a **delete** affordance per row.

- **Cross-group aggregation, like its siblings.** Every Catchup tab is a
  per-user union across the user's groups, served by a `/me/*` endpoint.
  Files follows suit: `GET /api/v1/me/files` →
  `listAttachmentsForUser` joins `group_members`, so any group member sees
  every group file (matching the ADR 0004 visibility contract). User-scoped
  attachments are intentionally excluded — the tab is about shared group
  files.
- **Delete = `DELETE /api/v1/attachments/:id`** (authorized via the same
  `userCanRead` gate as the download route). `deleteAttachment`:
  1. `removeAttachmentChunks` — drops the FTS rows so retrieval forgets it
     immediately (this *is* the "reindex" the deletion implies; no global
     re-scan is needed),
  2. deletes the `attachments` row,
  3. unlinks the on-disk file **only when no other row references the same
     `path`.**
- **UI:** a `✕` button per row with a confirm dialog (native `Alert`, web
  `window.confirm`). Matches the existing delete pattern used by Trips /
  Saves rows; the app has no swipe-to-delete primitive and adding one for a
  single surface wasn't worth the gesture-handler/web complexity.

## Why the path guard matters

`copyAttachmentToGroup` (file sharing, ADR 0004) creates a **new row with a
new id but the *same* `path`** — the bytes on disk are shared, only the
index chunks are duplicated per id. An unconditional `fs.unlink` on delete
would therefore corrupt the shared copy in another group. So delete unlinks
the file only after confirming no sibling row still points at that path; the
last referrer's deletion is what finally removes the bytes. Chunk removal and
the row delete are always per-id and safe.

## Consequences

- A new SSE event `attachment.deleted` is broadcast to the file's group for
  future client cache invalidation; no consumer wires it yet (the Catchup
  screen refreshes on focus / after the mutation).
- Deletion is irreversible; the confirm dialog is the only guard.
