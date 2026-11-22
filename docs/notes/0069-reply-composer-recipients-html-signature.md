# 0069 — Reply composer: recipients, HTML alternative, Chord-managed signature

**Status**: accepted
**Date**: 2026-07-15

## Context

The email reader's reply (ADR 0060) sent a bare plain-text message to the
latest sender only: no reply-all, no cc/bcc, no signature (Gmail signatures
are applied by Gmail's own clients, not by `messages.send`), and no HTML —
replies looked terse and unformatted next to normal mail.

## Decision

- **Recipients**: `EmailReplyRequest` gains optional `to`/`cc`/`bcc` (validated
  email arrays, ≤50 each). Omitted `to` still falls back to the latest sender,
  so plain reply is unchanged. The **client** computes reply-all prefills
  (latest sender → To; its To+Cc minus the user's own address → Cc) because it
  already holds the message DTO; the server never guesses. The thread screen
  gets a Reply / Reply-all segmented control and a collapsible To/Cc/Bcc
  editor. Bcc rides as a header in the raw RFC-2822 message — Gmail delivers
  to it and strips the header, and we never persist bcc in the mirror.
- **Signature — Chord-managed, not imported from Gmail.** A plain-text
  `users.email_signature` (migration 026), edited in Settings, appended
  server-side after the conventional `"-- "` separator. Importing the user's
  real Gmail signature was rejected: it needs the extra `gmail.settings.basic`
  sensitive scope (more consent + verification surface on top of ADR 0062)
  and imports HTML we'd have to sanitize; a Chord-owned signature also works
  in mock mode.
- **HTML**: replies now send `multipart/alternative` — the typed plain text,
  plus an HTML part derived by `textToHtml` (escape + `<br>`). No rich-text
  composer; the HTML part exists so replies render with line breaks intact in
  HTML-first clients and gives the signature a future formatting path.

## Alternatives considered

- **Server-computed reply-all** — needs the server to re-parse the latest
  message per request and still ship the result to the client for editing;
  the client already has the data.
- **Import Gmail signature** (`gmail.settings.basic`) — extra sensitive scope
  + HTML sanitization for marginal gain; revisit if users ask for parity.
- **Rich-text composer** — heavy RN dependency; deferred until plain replies
  with signatures prove insufficient.

## Consequences

- The sent-message mirror row stores the signed text and the generated HTML,
  so the thread view shows exactly what was sent (bcc excluded by design).
- Existing single-recipient behavior and tests are unchanged when the new
  fields are omitted.
