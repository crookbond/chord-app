# 0281 — Chord says what it remembers, and can be told to forget

**Status:** Accepted, 2026-10-20. Builds on ADR 0009 (proposed facts),
docs/notes/0189 (subjects and the lighter bar) and ADR 0164 (`remember_fact`).

## Context

Chord already learns family facts. After every bot turn a second model call
(`bot/extraction.ts`) reads the exchange and writes durable facts (an allergy,
a school, a home airport, who is related to whom) to the `memories` table as
`proposed`; ADR 0164's `remember_fact` writes a fact the user states outright
as `confirmed`. Three things were missing:

1. **Nobody saw it happen.** A learned fact went quietly to the Saves tab. The
   only trace in the chat was a `task` card for `remember_fact`, with no way
   to take it back.
2. **It could not be corrected or forgotten in chat.** `deleteFact` and the
   supersede chain existed, but no bot tool used them, so "no, it's tree nuts"
   or "forget that" went nowhere.
3. **It never tidied up.** Restating a known fact made a new pending card each
   time (the proposed-duplicate check compared only with other proposed rows,
   never with the confirmed one). Proposed facts nobody answered stayed
   forever. The same fact saved under two keys (`favorite_food`,
   `favorite_cuisine`) stayed twice.

## Decision

### A notice where the fact was said

When extraction writes a NEW fact, a `memory` card is added to the bot reply
of that turn (one card per fact: who it is about, what was learned, and its
state). When the turn has no visible reply in Chord (passive listening, a
silent bridge turn), the card goes to the sayer's personal 1:1 chat in a
`system` message ("From your message in <chat>, I noted:"), which sends no
push and is not mirrored to bridges. A fact that already existed (same
subject, key and value, confirmed or proposed) gets no card: nothing new was
learned.

Card states, rewritten on the stored card whenever the fact changes:

| state | means | buttons (sayer only) |
|---|---|---|
| `proposed` | Chord inferred it; not used until kept | Keep · Not right |
| `saved` | confirmed; used in replies | Forget |
| `replaced` | a correction or merge superseded it | none; shows the new value |
| `removed` | rejected or forgotten | none |

`memory_notices (memory_id, message_id)` links a fact to its card. It is a
separate table with no foreign key to `memories`, because a forgotten fact's
row is deleted and the card must still be found to say "removed".
`refreshMemoryNotice` is the one function that rewrites a card; every path
that changes a fact calls it (confirm, reject, forget, correct, the lighter-bar
decay, the clean-up pass, the family profile's edit/delete).

Bridged chats (WhatsApp, Telegram) do not get the card: the reply has already
been sent by the time extraction finishes.

### Correct and forget in chat

Two new tools, `correct_memory { memoryId? | match, value }` and
`forget_memory { memoryId? | match }`. They act only on facts the asker can
already see in that chat — the same rule as `list_memories` (household and
roster facts of the group, plus the asker's own), so a tool call can never
reach another member's private facts. `match` is words naming the fact
("Maya's allergy"); every word must appear in the fact's subject, key or value.
One match acts; several return `ambiguous` with candidates and the bot asks;
none returns `not_found` and the bot says so. Correct writes a new confirmed
row that supersedes the old one (history kept); a proposed one is replaced.
Forget rejects a proposed fact and deletes a confirmed one. Both report
exactly what changed, and the old card updates.

The extraction prompt is now given the facts Chord already holds for that
sayer and chat, so it reuses their keys and does not propose them again.

### A clean-up pass

`maybeCleanupMemories` runs from the proactive tick at most every
`MEMORY_CLEANUP_HOURS` (24):

- **Deterministic, every run:** remove a proposed fact that repeats the live
  confirmed value (case and spacing ignored); keep only the newest proposed
  fact per subject and key; remove proposed facts older than
  `MEMORY_PROPOSED_TTL_DAYS` (30) that are not on the lighter-bar timer.
- **Model, only for chats whose confirmed facts changed since the last
  review** (`groups.memories_reviewed_at`, at most
  `MEMORY_CLEANUP_GROUPS_PER_RUN` (10) chats a run): for each subject with two
  or more confirmed facts, the model names facts that say *the same thing*
  and which one to keep. Code checks every id belongs to that subject and
  supersedes the others with the kept one. The model never writes a value, so
  a merge cannot invent anything; history stays in the supersede chain.
  Skipped for an owner who is not entitled (ADR 0079); tokens recorded as
  `memory_cleanup` unless the owner brings their own key (ADR 0193).

Contradictions (two different home airports under different keys) are not
resolved by the pass; that needs a question to the user and is left for later.

## Consequences

- Every learned fact is visible once, where it was said, with a way to undo it.
- A notice is one card per fact; a turn that teaches five things shows five
  cards. Extraction is capped at 20 facts a turn already.
- The family-profile edit/delete routes still let any member of a group change
  a member's fact there (the roster screen shows them by design). The chat
  tools are stricter on purpose; aligning the two is a separate decision.
- Extraction itself still records no token usage; the clean-up pass does.

## Rejected

- **A file per fact, like a coding assistant's memory.** Chord has many
  families, per-person privacy and per-group sharing; rows already carry all
  of it.
- **One summary notice per turn.** Each fact needs its own Keep/Forget.
- **Posting every notice to the personal chat.** The notice belongs next to
  what was said, when that is visible.
- **Letting the clean-up pass rewrite values.** A merge that writes new text
  can say something nobody said.
- **Forget as a soft delete.** "Forget that" means the fact is gone; the
  supersede chain already keeps history for corrections.
