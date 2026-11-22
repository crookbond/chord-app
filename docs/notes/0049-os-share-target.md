# 0049 — Receive forwarded content via an OS share target

**Status**: proposed
**Date**: 2026-06-10
**Related**: [ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md),
[ADR 0008 — WhatsApp import / ingest pipeline](./0008-whatsapp-import.md),
[ADR 0047 — Shareable group-invite links](./0047-shareable-join-links.md),
[ADR 0031 — UUID-referrer soft-link](./0031-uuid-signup-soft-link.md)

> **Not yet built.** This ADR scopes the work and records the decisions taken
> with the product owner (destination = group picker). Implementation follows
> on a confirm.

## Context

Today content only gets *into* Chord from inside Chord: type a message, tap
the composer `+` (files) or 🖼️ (photos, [chat composer commit]), or use the
chat-import button. There is no way to be in **another** app — Photos, Safari,
WhatsApp, Mail, a PDF viewer — and push a screenshot / link / file *to* Chord.
Every other messaging app the user has appears in the OS Share Sheet; Chord
doesn't. The ask: **add Chord to the share sheet so users can forward content
into it.**

## Decision

Add a native **share target** (iOS Share Extension + Android `ACTION_SEND` /
`SEND_MULTIPLE` intent filter) using the community Expo config plugin
**[`expo-share-intent`](https://github.com/achorein/expo-share-intent)** —
there is no first-party Expo module for *receiving* shares. The shared payload
is handed to the JS app on open; from there it flows into the **existing**
upload / message paths.

### Destination: always a group picker

A forwarded item must land in a group (Chord is strictly group-scoped, ADR
0004). **The receive flow always opens a group picker** — the user chooses the
destination every time (product decision, 2026-06-10). No silent default to
the personal "My Chord" group.

- New route `mobile/app/share.tsx` is the share-intent landing screen: it reads
  the pending shared payload, shows a preview (filename / thumbnail / URL /
  text snippet) and a **single-select** list of the user's groups (personal +
  named), and on confirm routes the content to that group.
- The group list reuses the selection pattern already in `SharePicker`
  (`mobile/app/groups/[id]/index.tsx`) — extracted into a shared component so
  both the cross-post picker and this destination picker stay in sync.

### Payload → existing flow mapping

| Shared type | Handling |
|---|---|
| **Image(s)** | `uploadFile(groupId, asset)` → `postMessage(📎)` — identical to the 🖼️ composer path; multi-image shares loop like multi-asset upload |
| **File** (PDF, etc.) | same `uploadFile` → `postMessage` path |
| **URL** | `postMessage` with the URL as the body (the bot's `save_link` offer then applies), so it threads through the normal link-handling, not a bespoke path |
| **Text** | `postMessage` with the text as the body |

Nothing new on the server — these are the same endpoints the composer already
calls. The ingest / `trip_classifier` / indexing pipelines pick the content up
exactly as if it had been uploaded in-app.

### Signed-out resume

If a share arrives while signed out, stash the payload (AsyncStorage, e.g.
`chord.pendingShare`) **before** routing to Google sign-in, and replay it after
auth — the same proven pattern as the pending join-code (ADR 0047) and the
Telegram `?ref=` referrer (ADR 0031). The keys are independent and compose.

### Platform reality

- **Requires a dev/preview/production EAS build.** Share targets do not exist
  in Expo Go, and not on web. The share entry simply isn't present there — a
  clean no-op, no fallback needed. **This feature cannot be exercised in the
  web/dev harness; it's verified on a device build only.**
- **iOS** needs an **App Group** (`group.app.chord.demo`) shared between the app
  and the Share Extension target so the extension can hand large payloads to the
  app via the shared container. The `expo-share-intent` plugin configures the
  entitlement, the extension target, and the app-group; EAS provisions it
  (the App Group must also be registered on the Apple Developer portal).
- **iOS Share Extensions run in a memory-limited (~120 MB) separate process.**
  Large videos / huge files can OOM the extension; v1 scopes to images, common
  docs, URLs, and text, and copies bytes through the app-group container rather
  than holding them in the extension.
- **Android** declares intent filters for `image/*`, `application/pdf`,
  `text/plain`, and `*/*` (single + multiple), `autoVerify` not applicable.

## Alternatives considered

1. **Deep-link / universal-link only (ADR 0048).** Universal links make Chord
   *open* a `chordapp.ai` URL, but they do **not** put Chord in the share sheet
   — you can't "Share → Chord" a photo with a deep link. Different mechanism;
   doesn't satisfy the ask. (The two compose: a share extension for inbound
   content, universal links for inbound navigation.)
2. **Hand-rolled native Share Extension (no plugin).** Full control, but it's
   bespoke iOS/Android native code to maintain against every SDK bump.
   `expo-share-intent` is the maintained community standard and keeps the
   project config-plugin-only. Rejected for the demo's maintenance budget;
   revisit if the plugin proves limiting.
3. **Default to the personal "My Chord" group (no picker).** One-tap, lowest
   friction, and "My Chord" is a natural inbox. Rejected by the product owner
   in favour of explicit per-share group choice.

## Implementation sketch

1. `npx expo install expo-share-intent`; add its config plugin to `app.json`
   (declares the iOS extension + app-group, Android intent filters).
2. `mobile/app/share.tsx` — landing route; `useShareIntent()` (or the provider)
   reads the payload; renders preview + single-select group list; on confirm
   dispatches per the mapping table; signed-out → stash + OAuth resume.
3. Extract the group-select list out of `SharePicker` into a shared component
   (`mobile/src/GroupSelect.tsx` or similar) reused by both pickers.
4. `mobile/src/share-intake.ts` — payload → `{uploadFile | postMessage}`
   routing helper (mirrors `finalizeUpload`), unit-testable.
5. EAS build (preview) → test: Share from Photos (image), Safari (URL), Files
   (PDF), Messages (text) → Chord → pick group → item appears in that chat.

## Open questions / follow-ups

- **URL handling depth.** Post-as-message (bot offers `save_link`) vs. directly
  invoking the save path. Start with post-as-message; revisit.
- **Large media / video.** Out of v1 (iOS extension memory). Decide later
  whether to stream large files through the app-group container.
- **Background delivery if the app is killed** mid-upload — rely on the user
  reopening for now.
