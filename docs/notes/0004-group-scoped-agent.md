# 0004 — Group-scoped agent + explicit attachment sharing

**Status**: accepted
**Date**: 2026-04-17
**Covers**: D2, D3 from [`docs/tasks/README.md`](../tasks/README.md)

## Context

Two related questions:
- **D2** (memory scope): where does the bot read from? Can memory span groups?
- **D3** (privacy): in a group, what attachments is the bot allowed to see?

The demo flows imply some cross-group recall (Flow 4 pulls John's home address from the Doe family group into the Friends group). That's nice but risks leakage — Chord shouldn't silently read across groups without a user-authored bridge.

## Decision

**The agent is strictly group-scoped for reads.** For a bot turn triggered in group `G`, the model only sees:

- Messages in group `G` (last N), and
- Attachments the **triggering user** is allowed to read *in the context of this turn*, as enforced by `document_permissions` (see [`docs/data-model.md`](../data-model.md)).

Concretely, `services/bot/retrieval.ts` unions:

| Source | Included? |
|---|---|
| Attachments with a `document_permissions` row granting **group `G`** | yes (typical shared-group files) |
| Attachments with a `document_permissions` row granting **the triggering user** | yes (private-to-user files that were explicitly permissioned into this chat) |
| Anything readable only in some other group `H ≠ G` | **no** (unless the user has granted a permission row that makes it readable in `G`) |
| Anything owned by another user | **no** |

**Sharing is explicit.** Users extend read access by creating permission rows — today primarily via the mobile upload "also share with…" flow and `POST /api/v1/attachments/:id/share`.

**No silent cross-group reads.** If retrieval in `G` finds nothing, the server may emit `bot.share-offer` suggesting an attachment the user already uploaded elsewhere — but it does not silently inject that other group's content into the prompt.

## Alternatives considered

- **Per-user global memory pool.** Simpler ("everything John ever told Chord is recallable anywhere John is present") but creates privacy surprises across unrelated groups and makes it hard to reason about what the bot will say next.
- **Opt-in bridges between groups.** Permit "Chord, remember my family's calendar here" from a Friends group and the bot auto-reads family context going forward. Composable but the surface area is large and error-prone for a demo.
- **Single "library" scope per user, visible in all their groups.** Same leak risk as the first alternative.

## Consequences

- Attachment selection for bot context lives in `services/bot/retrieval.ts` (`selectAttachmentsForTurn`), not as ad-hoc SQL inside `buildLlmContext`.
- `POST /api/v1/attachments/:id/share` remains the explicit bridge for copying visibility across groups/users.
- Adult-only groups (`groups.adults_only`) can further restrict which permission rows apply to guest-tier members (see `fetchAttachmentsVisibleTo` in `retrieval.ts`).
