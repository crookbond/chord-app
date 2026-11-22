# Architecture Decision Records

Why decisions were made. Not *what* the code does — that's the subsystem docs — but *why this and not the alternatives.*

## When to write one

Write an ADR when you:
- Chose between multiple viable options (e.g. SSE vs WebSockets).
- Made a decision that won't be obvious from reading the code (e.g. "kernel is not a workspace" — you'd wonder why forever without an ADR).
- Set a convention others should follow.

Don't write one for:
- Implementation details (use the subsystem doc).
- Bug fixes (use the commit message).
- In-progress exploration (use `../tasks/`).

## Format

One file per decision. Filename: `NNNN-short-slug.md`, where `NNNN` is the next free 4-digit number. Template:

```markdown
# NNNN — <Short title>

**Status**: accepted | superseded by NNNN | deprecated
**Date**: YYYY-MM-DD

## Context
What was the situation? What constraints were we facing?

## Decision
What did we choose? (Short, concrete.)

## Alternatives considered
- **X** — why not.
- **Y** — why not.

## Consequences
What does this decision commit us to? What pitfalls should future readers know about?
```

If a decision is later reversed, *don't delete the ADR*. Mark it `superseded by NNNN` and write a new one. The history matters.

## Index

| ID | Title | Status |
|---|---|---|
| 0001 | [kernel/ as a path alias, not a workspace](./0001-kernel-not-a-workspace.md) | accepted |
| 0002 | [SSE over WebSockets](./0002-sse-over-websockets.md) | accepted |
| 0003 | [Text-based tool protocol, not native function-calling](./0003-text-based-tool-protocol.md) | partially superseded by 0005 + 0022 (fallback only) |
| 0004 | [Group-scoped agent + explicit attachment sharing](./0004-group-scoped-agent.md) | accepted |
| 0005 | [Iterative tool use via native function-calling](./0005-iterative-tool-use.md) | accepted — shipped |
| 0006 | [Keyword retrieval over filenames + summaries](./0006-keyword-retrieval.md) | partially superseded by 0021 (see also 0038) |
| 0007 | [Triggering user identity in bot turn context](./0007-user-identity-in-turn.md) | accepted |
| 0008 | [WhatsApp chat-export import](./0008-whatsapp-import.md) | accepted |
| 0009 | [Consensus-before-commit for bot-proposed writes](./0009-consensus-before-commit.md) | accepted |
| 0010 | [External IM connectors (Slack, Discord, Telegram)](./0010-im-connectors.md) | accepted — implemented |
| 0011 | [Chord group as supergroup; bot-mediated information bridging](./0011-supergroup-bot-mediated-bridging.md) | accepted |
| 0012 | [Proactive event scanning and family-graph nudges](./0012-proactive-event-scanning.md) | accepted; partially superseded by 0015 |
| 0013 | [`.ics` calendar-invite ingest](./0013-ics-calendar-ingest.md) | accepted |
| 0014 | [Google-only auth for real users](./0014-google-only-auth.md) | accepted |
| 0015 | [Server-side Google Calendar write (`Chord` calendar)](./0015-server-side-google-calendar.md) | largely superseded by 0040 (one-way/single-calendar mechanics); supersedes part of 0012; scope-acquisition superseded by 0028 |
| 0016 | [Family graph in SQLite](./0016-family-graph-in-sqlite.md) | accepted — storage now Postgres (0038) |
| 0017 | [Server-authoritative storage; on-device cache deferred](./0017-server-authoritative-with-offline-cache.md) | accepted |
| 0018 | [Listening modes (invocation / passive / active)](./0018-listening-modes.md) | accepted |
| 0019 | [Catchup dynamic folders](./0019-catchup-dynamic-folders.md) | accepted |
| 0020 | [Cross-group personal context (opt-in, default ON)](./0020-cross-group-personal-context.md) | superseded by 0032 (behaviorally) |
| 0021 | [SQLite FTS5 attachment index with chunked excerpts](./0021-fts5-attachment-index.md) | accepted — FTS engine now Postgres tsvector (0038) |
| 0022 | [Quiet-mode bot replies](./0022-quiet-mode-bot-replies.md) | accepted — supersedes the streaming half of 0003 |
| 0023 | [Richer trigger context (group roster + snapshot)](./0023-richer-trigger-context.md) | accepted |
| 0024 | [Event endsAt + per-leg trip rendering](./0024-event-ends-at-and-leg-rendering.md) | accepted — time model extended by 0040 |
| 0025 | [BYO bot tokens for IM connectors](./0025-byo-connector-tokens.md) | accepted |
| 0026 | [Trust list for cross-user task / event assignment](./0026-trust-list-for-assignment.md) | accepted |
| 0027 | [Configurable bot persona](./0027-configurable-bot-persona.md) | accepted — Phase 1 implemented; Phase 2 future |
| 0028 | [Request Google Calendar scope at sign-in](./0028-calendar-scope-at-signin.md) | accepted (supersedes part of 0015) |
| 0029 | [Inline-keyboard actions on Telegram](./0029-tg-inline-actions.md) | accepted |
| 0030 | [Group-chat calendar scope: Chord-target calendar only](./0030-group-calendar-scope.md) | superseded by 0040 (user-owned + group_ids) |
| 0031 | [UUID-referrer soft-link from Telegram welcome DM](./0031-uuid-signup-soft-link.md) | accepted |
| 0032 | [Strict per-group scope for bot reads](./0032-strict-per-group-scope.md) | accepted (supersedes 0020 behaviorally) |
| 0033 | [Calendar busyness policy: `counts_for_busy` + per-event transparency](./0033-calendar-busyness-policy.md) | accepted — extended by 0040 (<5-min free rule) |
| 0034 | [User-configurable daily-briefing time](./0034-configurable-nudge-time.md) | accepted |
| 0035 | [Recency-aware bot context window](./0035-recency-aware-context-window.md) | accepted |
| 0036 | [Bot delivers files by re-posting the attachment, not a URL](./0036-bot-sends-files-not-links.md) | accepted |
| 0037 | [User-managed files: Catchup "Files" tab + path-aware delete](./0037-file-management-and-delete.md) | accepted |
| 0038 | [SQLite → Postgres on the same VM](./0038-sqlite-to-postgres.md) | accepted |
| 0039 | [External-action deep links](./0039-external-action-deep-links.md) | accepted (renumbered from 0022) |
| 0040 | [User-owned, two-way calendar model (UID + SEQUENCE)](./0040-user-owned-two-way-calendar.md) | accepted — design; implementation in progress |
| 0041 | [Native iOS Google OAuth client + per-client refresh-token binding](./0041-native-ios-oauth-client.md) | accepted |
| 0042 | [Proactive calendar-reconnect nudge](./0042-proactive-calendar-reconnect-nudge.md) | accepted |
| 0043 | [Account deletion](./0043-account-deletion.md) | accepted |
| 0044 | [BYOK failure handling + future billing](./0044-byok-failure-and-future-billing.md) | accepted |
| 0045 | [Group lifecycle: delete, leave, invite regeneration](./0045-group-lifecycle.md) | accepted |
| 0046 | [Trip lifecycle: archive past trips (and their files)](./0046-trip-lifecycle-archive.md) | accepted |
| 0047 | [Shareable group-invite links](./0047-shareable-join-links.md) | accepted |
| 0048 | [Native deep-linking for invite links](./0048-native-deeplinks-for-invite-links.md) | accepted |
| 0049 | [Receive forwarded content via an OS share target](./0049-os-share-target.md) | proposed |
| 0050 | [Online calendar import (`import_calendar`)](./0050-online-calendar-import.md) | accepted |
| 0051 | [Post-invocation follow-up window](./0051-post-invocation-followup-window.md) | accepted |
| 0052 | [Apple on-device AI + iMessage/RCS feasibility](./0052-apple-on-device-ai-and-imessage.md) | accepted |
| 0053 | [WhatsApp connector via Twilio (24h window + template gating)](./0053-whatsapp-twilio-connector.md) | accepted — MVP implemented |
| 0054 | [Expo push notifications](./0054-expo-push-notifications.md) | accepted |
| 0054 | [Clipboard intake (paste) + copy-out](./0054-clipboard-intake-and-copy-out.md) | accepted (partial) — duplicate number, see note below |
| 0055 | [Bot-only connector messages follow `mirror_inbound`](./0055-bot-only-connector-visibility-follows-mirror.md) | accepted |
| 0056 | [Workload-aware model routing](./0056-model-routing.md) | proposed — direction confirmed 2026-07-16, with Adrian for design |
| 0057 | [Device calendar as a first-class (optional-Google) source](./0057-device-calendar-as-source.md) | accepted |
| 0058 | [Lists render per-list; no cross-list consolidation](./0058-no-list-consolidation.md) | accepted |
| 0059 | [Unified `search` bot tool across chats, files, and entities](./0059-unified-search-tool.md) | accepted |
| 0062 | [Global search (per-table FTS, user-scoped)](./0062-global-search-fts.md) | accepted |
| 0063 | [Prepaid credits + tier-based model routing](./0063-billing-and-model-routing.md) | accepted — core shipped; Stripe slice pending |
| 0064 | [Phone-as-attribute identity + SMS verification](./0064-phone-as-attribute-identity.md) | accepted — server core shipped |
| 0065 | [Deterministic contact discovery (hashed phone matching)](./0065-deterministic-contact-discovery.md) | accepted — server core shipped |
| 0066 | [In-repo LLM email classifier](./0066-in-repo-llm-email-classifier.md) | accepted |
| 0067 | [Pair groups + cross-user messaging (`message_user`)](./0067-pair-groups-and-cross-user-messaging.md) | accepted — server core shipped; WhatsApp-NLU delivery follow-up |
| 0068 | [Attention-weighted nested email map with inline magic cards](./0068-attention-weighted-email-map.md) | accepted |
| 0069 | [Reply composer: recipients, HTML alternative, Chord-managed signature](./0069-reply-composer-recipients-html-signature.md) | accepted |
| 0070 | ["To Do's" hub: Action Items first, Finance scaffold, Files → Attachments](./0070-todos-hub-action-items-first.md) | accepted |
| 0071 | [Email attachments feed the knowledge base](./0071-email-attachments-into-knowledge-base.md) | accepted |
| 0072 | [Unified calendar settings, info-by-default, one morning message](./0072-unified-calendar-settings-and-one-briefing.md) | accepted |
| 0083 | [Email Stage 1 shell: decisions on tiles](./0083-email-stage-1-shell-decisions-on-tiles.md) | accepted (amends 0068 weighting) |
| 0084 | [Email + pending to-dos join search](./0084-email-and-todos-in-search.md) | accepted |
| 0085 | [One matching rule for both search surfaces](./0085-one-search-matching-rule.md) | accepted |
| 0086 | [Email action axis](./0086-email-action-axis.md) | accepted |
| 0087 | [Email tiles carry archetype facts](./0087-email-tile-archetype-facts.md) | accepted (amends 0068 previews on converted tiles) |
| 0088 | [Email magics see calendar / tasks / trips before extracting](./0088-email-magics-world-context.md) | accepted |

Numbering notes: **0054 is duplicated** (push notifications and clipboard both
claimed it); **0060–0061 were never files** — 0061 (email-map drill-down) exists
only as a decision superseded by 0068. **0136 and 0137 are each duplicated** —
a concurrent branch landed `0136-a-device-calendar-is-not-a-push-target.md`
and `0137-an-ambiguous-calendar-name-is-a-question.md` on top of numbers this
session had already given to the image-proxy and proactive-message ADRs,
and the merge went in without either side renumbering. Not fixed here —
renumbering the calendar pair touches commits and a CLAUDE.md table this
session didn't author.

**This table stops at 0088 and the ones after it were never added to it.** The
live index is the ADR table in [`CLAUDE.md`](../../CLAUDE.md), which every
session loads; read the directory listing for the rest. Next free number:
**0231**. (Re-check `ls docs/notes | tail -3` before trusting this line — several sessions have raced this number recently.)
