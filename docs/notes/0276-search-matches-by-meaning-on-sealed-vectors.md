# 0276 — Search matches by meaning, on sealed vectors

**Status:** Accepted, 2026-10-19. Ships off (`EMBEDDINGS_ENABLED=false`).
Supersedes the "no embeddings" half of ADR 0006 for search; adds a row to
ADR 0257.

## Context

ADRs 0270 and 0271 fixed people and ranking, but keyword search cannot find
an email that says the same thing in other words: "kids excursion paperwork"
does not find "Field trip form due Friday", and "mail from the dentist" does
not find "Reminder from Dr. Patel" from Bright Smiles Dental. Families ask
this way all the time.

Three constraints shaped the answer:

- **Mail is sealed per user (ADR 0201).** A vector says what its text is
  about, and a plaintext vector column (pgvector) would leak that beside
  ciphertext.
- **Keys are per user (ADR 0257).** Chord's own key goes through OpenRouter.
  A BYOK user may hold an OpenRouter, OpenAI, Gemini or Anthropic key, and
  Anthropic has no embeddings API.
- **Vectors are comparable only within one model.** OpenRouter may route chat
  to any model; embeddings cannot float like that.

## Decision

- **One vector per email thread and per file**, made from what Chord already
  has: subject, sender and recipients, category path, receipt/delivery/flight
  facts, and the start of the first and latest messages, read through the one
  body reader (ADR 0268). A file's vector is its name, its summary and its
  first 6,000 characters of text (about two single-spaced pages, ~1,500
  tokens): where a form, letter or itinerary says what it is. Anything later
  in a long document is still found by its words. No new summary is
  generated.
- **Sealed per owner** (`sealBytes`, the file envelope), stored as int8 plus a
  scale: 516 bytes at 512 dimensions, with a similarity error under 0.02.
  `email_thread_embeddings` and `attachment_embeddings` (migration `114`)
  carry `model` and a content hash, so unchanged text is never paid for twice
  and a model change re-embeds.
- **Compared in the app.** A user's vectors are opened once into an LRU cache
  (`EMBED_CACHE_USERS`), refreshed when the stored set changes. Cosine over a
  family mailbox is tens of milliseconds. Person, date and kind filters from
  ADR 0270 apply before the comparison, so meaning never brings in someone
  else's mail.
- **Blended by rank** with the keyword list (reciprocal rank fusion, k = 60);
  `SEARCH_SEMANTIC_MIN_SIM` drops weak meaning-only hits; a hit found only by
  meaning carries `matchedBy: 'meaning'`. Files are blended the same way.
- **Whose key** (`getEmbedderForUser`, the only place that builds one, guarded
  by a test like `getLlm`'s):

  | User | Embeds with |
  |---|---|
  | no own key | Chord's key, metered to their allowance (`token_usage` source `embedding`) |
  | own OpenRouter / OpenAI key | their key, the same model as Chord's (`text-embedding-3-small`), so the vectors match |
  | own Gemini key | their key, `gemini-embedding-001` at 768 (REST: the SDK has no size field) |
  | own Anthropic key | Chord's key, unmetered (`EMBEDDINGS_BYOK_FALLBACK=chord`), or keyword only (`none`) |
  | own Ollama / vLLM | treated like a key that cannot embed |

  Model ids drop the vendor prefix, so OpenRouter's and OpenAI's copies of one
  model are the same id. Each user's mail is always one model; different
  users may differ.
- **Chord's embedding key is configured apart from its chat model**
  (`EMBEDDINGS_BASE_URL` / `EMBEDDINGS_API_KEY`, defaulting to `OPENAI_*` when
  `LLM_PROVIDER=openai`). If Chord's chat moves to Anthropic, meaning search
  keeps working once an embedding key is set; with none, it is off and logged
  once, and everyone gets ADR 0271 search unchanged.
- **OpenRouter calls ask for `data_collection: deny`**, so embedding text is
  only routed to hosts that do not keep or train on it.
- **Backfill**: newest first, bounded per run (`EMBED_PASS_MAX_PER_TICK`), at
  the end of the ADR 0079-gated after-sync passes, and as its own sweep on the
  proactive tick (`EMBED_SWEEP_BATCH` users) so it does not wait for the
  Email tab.
- **Privacy text** now says mail is processed to make it searchable by
  meaning, by the user's provider or Chord's when theirs cannot.

## Consequences

- Eval: with the stand-in embedder, every class reaches 1.00 on a sealed
  mailbox, which proves the pipeline only (its synonyms were written for the
  corpus). `npm run eval:email-search` runs the same set against the real
  model; run it before turning the flag on and tune `SEARCH_SEMANTIC_MIN_SIM`.
- First live run (2026-10-19, `openai/text-embedding-3-small` via OpenRouter,
  19 threads embedded in 1.3 s): keyword-only MRR 0.89 -> blended 1.00, every
  class 1.00, person queries still clean. OpenRouter accepted the
  `dimensions` and `data_collection` fields. The corpus is small: a real
  mailbox has far more near misses above `SEARCH_SEMANTIC_MIN_SIM`, so turn it
  on for one account and check known searches before everyone.
- Cost: about $0.16 per user once at prod's model, then pennies (ADR 0257).
- A BYOK key failure during embedding is logged and the run skipped; it is not
  reported through ADR 0252's key-health nudge (that wraps chat calls only).
- The search box path (`searchHits`) stays keyword-only; it has no UI.
- Vectors die with their row (FK cascade) and with the owner's key (ADR 0201
  erasure): an unopenable vector simply does not match.
- In a multi-process deploy each process holds its own vector cache; the
  version check keeps them correct, not shared.

## Rejected

- **pgvector.** Fast ANN, but plaintext vectors beside sealed mail.
- **Generating and storing a summary per thread to embed.** ADR 0261 chose not
  to store summaries; the subject, facts and first lines carry the topic.
- **Always Chord's key.** Would send BYOK users' mail to a provider they did
  not choose when their own key can do it.
- **One global model.** Forces Gemini users onto OpenAI; per-user models cost
  nothing extra since comparisons never cross users.
- **Keyword fallback inside the meaning arm** (searching meaning only when
  keywords find nothing): blending catches the paraphrase even when a weaker
  keyword match exists.
