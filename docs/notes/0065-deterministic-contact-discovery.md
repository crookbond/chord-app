# 0065 — Deterministic contact discovery (hashed phone matching)

**Status**: accepted — testable server core shipped (`contact_links`, resolve endpoint, `resolveContactToUser`); mobile `expo-contacts` upload is a follow-up
**Date**: 2026-07
**Builds on**: [ADR 0064 — phone-as-attribute identity](./0064-phone-as-attribute-identity.md)
**Respects**: [ADR 0004 — group-scoped agent](./0004-group-scoped-agent.md), [ADR 0032 — strict per-group scope](./0032-strict-per-group-scope.md)
**Enables**: the flagship cross-user `message_user` (Workstream E) — which *creates* a shared pair group rather than crossing scope
**Workstream**: Friends & Family release plan — C

## Context

With a verified phone attribute (ADR 0064), we can answer "which of my phone
contacts is on Chord?" and, from that, "who does the name *Adrian* in
'message Adrian' refer to?". The existing `resolveAssignee`
(`bot/executor.ts`) only matches a name against the **current group's** roster —
correct for group tasks, useless for a 1×1 where the target isn't in any shared
group yet. We need a resolver bounded to the **sender's own address book**.

## Decision

### Hashed matching, client-side hashing

The mobile client reads device contacts (`expo-contacts`), normalizes numbers to
E.164 (libphonenumber), **hashes them on-device** with the shared pepper, and
uploads `{ name, phoneHashes }`. `POST /me/contacts/resolve` matches those
hashes against verified users' `phone_hash` (ADR 0064) and returns the Chord
users among them. **Raw device numbers never leave the phone.**

The hash is `HMAC-SHA256(CONTACT_HASH_PEPPER, e164)`. The pepper is a shared
build-time constant (env on the server, bundled in the app) so both sides
produce the same value.

**Privacy posture (explicit):** this is *not* cryptographically private the way
Signal's enclave is. The pepper ships in the client, and phone numbers are
low-entropy, so a party holding the app binary could brute-force a hash. What it
buys: a raw DB dump *alone* (without the pepper) can't be rainbow-attacked, and
numbers aren't stored or transmitted in the clear. Acceptable for a <50-person
F&F cohort; revisit before a broad public launch.

### `contact_links` is the durable name→user map

Migration `023_contact_links`: one row per (owner, resolved contact) —
`owner_user_id`, `contact_name` (the owner's local label), `phone_hash`,
`chord_user_id`, `UNIQUE (owner_user_id, phone_hash)`. **Only contacts that
matched a verified Chord user are persisted** — non-matches are dropped, so we
never retain a hash of someone's entire address book. Both user FKs are
`ON DELETE CASCADE` (account deletion, ADR 0043, sweeps them). Re-uploading
upserts (latest name wins).

### `resolveContactToUser(senderUserId, name)` — strictly sender-scoped

Searches **only the sender's own `contact_links`**: exact (case-insensitive)
name match first, then a first-name / prefix / whole-word fallback so
"Adrian" resolves "Adrian Gupta". Returns `match` | `ambiguous` (one name →
two Chord users, caller disambiguates) | `none`. It **never** falls back to a
global user search — a name only resolves through the caller's address book.
This is the key scope property: the flagship acts on another user only via a
sender who already has them as a contact, and the message then lands in a
pair group (ADR 0032 satisfied, not bypassed).

Endpoints: `POST /me/contacts/resolve`, `GET /me/contacts` (the resolved list).
Kernel: `ResolveContactsRequest` / `ResolvedContact` / `ResolveContactsResponse`.

## Consequences

- The name→user map is per-user and permissioned by "is it in *your* contacts",
  which is exactly the trust boundary the flagship needs.
- `resolveContactToUser` is distinct from the group-scoped `resolveAssignee`;
  both stay, used in different contexts (pair/1×1 vs. in-group).
- Only resolved matches are stored, bounding what a compromise exposes to
  "people the owner both knows *and* who are on Chord", not the whole address book.
- The mobile contacts-permission flow + upload, and wiring `resolveContactToUser`
  into `message_user`, are the remaining Workstream C/E steps; the server
  contract is fixed and tested.

## Alternatives considered

- **Send raw numbers, match server-side.** Rejected — needlessly ships every
  contact's number to the server; hashing on-device is strictly better for the
  same result.
- **Enclave-grade private set intersection (Signal-style).** Rejected for F&F —
  large effort for a threat model beyond a 50-person trusted cohort. The posture
  is documented so the upgrade path is a conscious later decision.
- **Global name→user resolution.** Rejected — it would let a personal-group turn
  address *any* Chord user by name, the exact cross-scope leak ADR 0032 forbids.
  Bounding resolution to the sender's contacts keeps the flagship inside scope.
- **Reuse the free-text `saves` contact rows.** Rejected — those are group-scoped,
  unstructured, and carry no phone/user link; a dedicated table is the clean map.
