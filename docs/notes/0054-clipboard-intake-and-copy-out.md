# 0054 — Clipboard intake (paste) + copy-out

**Status**: accepted (partial — see "Shipped vs. deferred")
**Date**: 2026-06-15
**Related**: [ADR 0049 — Receive forwarded content via an OS share target](./0049-os-share-target.md),
[ADR 0036 — Bot sends files, not links](./0036-bot-sends-files-not-links.md),
[ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md)

## Context

Content gets *into* Chord from inside Chord: type a message, tap the composer
`+` (files) or 🖼️ (photos). The OS **share target** (ADR 0049, not yet built)
adds inbound-from-another-app. Neither covers the most reflexive desktop/web
gesture: **paste**. A user copies a screenshot or a block of text elsewhere and
expects ⌘V / Ctrl+V in the composer to drop it into the chat. Symmetrically,
nothing lets a user **copy content out** of a Chord message — the app only ever
*writes* invite links and pairing codes to the clipboard
([`join-code.ts`](../../mobile/src/join-code.ts),
[`settings.tsx`](../../mobile/app/groups/[id]/settings.tsx)), never reads
content in or copies message content out.

`expo-clipboard` is already a dependency. **Plain-text paste already works for
free** — the RN `TextInput` gets the OS paste menu on native and the browser
paste on web with zero code. So this ADR is really about **images** (paste in,
copy out) and the **copy-text-out gesture**, not text-into-the-composer.

## Decision

Treat paste as a **third intake funnel that converges on the existing upload
path**, and add a long-press **copy-out** gesture. No server change — these are
the same endpoints the composer already calls.

### Paste-in → existing flow (the merge point)

A pasted image becomes a `PendingAsset` and is handed to `setPendingAssets`,
exactly like the picker paths. That means it inherits the **`UploadConfirm`
modal for free**: a stray ⌘V shows a "send this file?" preview rather than
silently posting — the **accidental-paste guard**. From there `finalizeUpload` →
[`uploadFile`](../../mobile/src/api.ts) → `postMessage` is unchanged.

```
attach sheet (Photos / Files) ─┐
paste                          ─┼──► PendingAsset ──► setPendingAssets ──► UploadConfirm ──► finalizeUpload
share tgt (ADR 0049)           ─┘        (ADR 0049 may extract a shared share-intake helper later)
```

The composer row is a single `+` that opens a WhatsApp-style **attach bottom
sheet** (`AttachSheet`: Photos / Files tiles) on native, or the OS file dialog
directly on web. New intake types (Camera, **Paste image**) become **tiles in
that sheet**, not new buttons on the row.

We deliberately **do not** pre-extract a shared `share-intake.ts` helper here:
paste lives inside the composer where `finalizeUpload` and `UploadConfirm`
already exist, so reusing component state is the smaller change. The share
*target* (ADR 0049) runs in a separate `share.tsx` route without that state and
is the right place to extract the shared helper when it's built.

### There is no single paste API — it splits by platform and content type

| | Text | Image |
|---|---|---|
| **Web (RN-Web)** | free (TextInput) | a document-level `paste` listener, gated on composer focus, reads `clipboardData.items`, pulls the image `File` (which *is* the web `PendingAsset.file`) |
| **Native (iOS/Android)** | free (OS paste menu) | no paste-image-into-TextInput event exists — needs an **explicit affordance**: a **Paste image** tile in the attach sheet calling `Clipboard.getImageAsync()` |

On web the listener is attached to `document` (not the RN-Web node, whose ref
shape is less stable) and **only acts when the composer is focused** and only on
image items — text items fall through to the browser's default paste. On native
there is no event when the user copies an image, so the pattern is a sheet tile
that reads the clipboard on tap (iOS shows a "pasted from…" banner on every
clipboard read, so we read **on tap**, never by polling `hasImageAsync()`); the
tile can be hidden/disabled unless `hasImageAsync()` is true.

### Copy-out: long-press the bubble

Long-pressing a message bubble copies its **text** via
`Clipboard.setStringAsync`, with a transient "Copied" indicator. No context menu
in v1 — the press *is* the copy. **Image-copy-out is deferred** (see below): it
needs fetch-attachment → base64 → `setImageAsync` on native vs.
`navigator.clipboard.write([ClipboardItem])` on web, a platform branch not worth
the cost until asked for.

### URL paste = the existing save path, nothing bespoke

A pasted URL is just pasted text; once *sent as a message* the bot's existing
`save_link` offer fires. No paste-time URL interceptor — same conclusion ADR
0049 reached for shared URLs ("post-as-message, the bot's save_link offer then
applies").

## Shipped vs. deferred

**Shipped now (verifiable in the web/dev harness):**

- **Web image paste** into the composer (document `paste` listener → `PendingAsset`
  → `UploadConfirm`).
- **Copy-text-out** via bubble long-press.

**Shipped (device-only — needs a device/EAS build to exercise, like the ADR
0049 share target):**

- **Native image paste.** A **Paste image** tile in `AttachSheet`:
  `getImageAsync({format:'png'})` → strip the `data:…;base64,` prefix → write the
  bytes to `FileSystem.cacheDirectory` (legacy `writeAsStringAsync`,
  `encoding: 'base64'`; added `expo-file-system`) → `PendingAsset {uri,name,mimeType}`
  → `setPendingAssets`. The tile always shows and reads the clipboard **on tap**
  (no `hasImageAsync` poll — that trips iOS's "pasted from…" banner); a tap with
  no clipboard image surfaces an inline error.
- **Camera.** A **Camera** tile: `requestCameraPermissionsAsync()` →
  `launchCameraAsync({mediaTypes:['images'],quality:1})`, mapped to a
  `PendingAsset` exactly like the photo picker. iOS `NSCameraUsageDescription`
  via the `expo-image-picker` plugin `cameraPermission`; Android `CAMERA` permission.

**Deferred (dependency / scope):**

- **Image-copy-out** (platform-branched, see above).

## Alternatives considered

1. **Paste straight to chat, no confirm.** Lowest friction, but a reflexive ⌘V
   with a stale clipboard image silently posts to a family group with no undo.
   Rejected for the `UploadConfirm` reuse, which is also *less* code (no new dialog).
2. **Paste-into-composer as a preview chip.** A third UI pattern to build and
   keep in sync; `UploadConfirm` already trains users for "you're about to
   send this." Rejected.
3. **Extract a shared `share-intake.ts` helper up front** (per ADR 0049's
   sketch). Speculative here — paste already has `finalizeUpload` in scope.
   Defer the extraction to whoever builds the 0049 route.
4. **Context menu on long-press (Copy / Forward / Delete …).** Heavier; v1 only
   needs Copy, and direct-copy-on-press is faster. Revisit if more per-message
   actions land.

## Open questions / follow-ups

- **Native paste UX** — settled: a **Paste image** tile in the attach sheet
  (`AttachSheet`), not a row button. Open sub-question: hide the tile vs. grey it
  out when `hasImageAsync()` is false. Decide when the device-build pass picks it up.
- **Image-copy-out** — worth the platform branch? Wait for a user ask.
- **Web text-selection vs. long-press.** Wrapping the bubble in a `Pressable`
  may suppress native text selection on web; acceptable for the demo since
  long-press *is* the copy gesture, but revisit if select-and-⌘C is missed.
