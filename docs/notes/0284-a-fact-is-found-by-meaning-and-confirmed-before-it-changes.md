# 0284 — A fact is found by meaning, and confirmed before it changes

**Status:** Accepted, 2026-10-20. Extends ADR 0281 (correct/forget in chat)
with ADR 0276's embeddings.

## Context

ADR 0281's `correct_memory` / `forget_memory` find a fact by words: every word
the user says must appear in who the fact is about, its key or its value.
"forget what Maya eats" does not find `Maya · dietary preference = vegetarian`,
and the bot can only say it found nothing. `list_memories` has no way to look
for anything: it returns the newest 30 facts and leaves the model to scan them.

ADR 0276 already turns mail and files into vectors and compares them by
meaning. Facts were never included.

## Decision

**Fact vectors are made when a search needs them, not by a background pass.**
A chat holds at most a few hundred facts, each one short line, so embedding
every visible fact that lacks a current vector is one small call (a few
thousand tokens the first time, nothing after). `memory_embeddings
(memory_id, model, content_hash, vec)` keeps them: one row per fact per
embedding model, because only vectors of one model are comparable and
different members may use different models (ADR 0276). The text embedded is
the line a person reads, `<who> · <key>: <value>`; a changed value changes the
hash and is embedded again. Not sealed: facts themselves are not (ADR 0201
leaves confirmed family content readable), and a vector says less than the
row it came from. The row goes with the fact (`ON DELETE CASCADE`).

The embedder is the asker's, chosen by ADR 0276's one function
(`getEmbedderForUser`); Chord's key is metered to the asker as `embedding`.
No embedder (embeddings off, or a key that cannot embed) means word matching
only, exactly as before.

**A meaning match is never acted on directly.** `correct_memory` /
`forget_memory` still act when the words match exactly one fact. When the
words match nothing, the closest facts by meaning (at most 3, above
`SEARCH_SEMANTIC_MIN_SIM`) come back as `suggested`, nothing is changed, and
the bot asks "Did you mean Maya · dietary preference: vegetarian?". Deleting
the wrong fact because it sat closest in a vector space is not a mistake a
person can see coming; asking costs one reply.

**`list_memories` takes a `query`.** With one, it returns the facts that match
by words or by meaning, merged by reciprocal rank (ADR 0276's `fuseRanks`).
When nothing matches it says so and returns the plain list, so the model can
still answer from what is there.

The unified `search` tool (ADR 0059) does not get a facts category in this
change: that is a new kind of hit in the kernel types and the app's search
screen.

## Consequences

- "forget what Maya eats" now gets a question instead of "nothing found".
- The first meaning search in a chat embeds its facts; that call is on the
  asker's key or metered to them.
- A fact changed through the family profile is re-embedded on the next search
  (its hash no longer matches).

## Rejected

- **A background embedding pass for facts.** Mail needs one because a mailbox
  is too large to embed on demand; a chat's facts are not.
- **Acting on a confident meaning match.** No threshold makes a wrong delete
  acceptable when asking first is one reply.
- **Sealing fact vectors.** The facts are not sealed; the vector would be
  better protected than its source.
- **One vector per fact regardless of model.** Vectors from different models
  cannot be compared.
