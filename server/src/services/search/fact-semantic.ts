/**
 * Facts matched by meaning (ADR 0284). A chat holds at most a few hundred
 * short facts, so their vectors are made when a search needs them: every fact
 * passed in that has no vector of the asker's model, or whose text changed,
 * is embedded in one call and stored; then all are compared with the
 * question. Not sealed — the facts themselves are not (ADR 0201).
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { getEmbedderForUser, type Embedder } from '../llm/embeddings.js';
import { recordTokenUsage } from '../tokens.service.js';
import { queryVector, type SemanticHit } from './semantic.js';
import { contentHash, cosine, packVector, unpackVector } from './vectors.js';

const BATCH = 64;

export interface FactText {
  id: string;
  /** The line a person reads: "Maya · allergy: peanuts". */
  text: string;
}

async function vectorsFor(db: Kysely<DB>, userId: string, embedder: Embedder, facts: FactText[]) {
  const stored = await db
    .selectFrom('memory_embeddings')
    .select(['memory_id', 'content_hash', 'vec'])
    .where('model', '=', embedder.id)
    .where(
      'memory_id',
      'in',
      facts.map((f) => f.id),
    )
    .execute();
  const byId = new Map(stored.map((r) => [r.memory_id, r]));
  const out = new Map<string, Float32Array>();
  const todo: Array<FactText & { hash: string }> = [];
  for (const f of facts) {
    const hash = contentHash(embedder.id, f.text);
    const row = byId.get(f.id);
    if (row && row.content_hash === hash) out.set(f.id, unpackVector(row.vec));
    else todo.push({ ...f, hash });
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const { vectors, tokens, costUsd } = await embedder.embed(
      batch.map((b) => b.text),
      'document',
    );
    const now = new Date().toISOString();
    for (let k = 0; k < batch.length; k++) {
      const vec = packVector(vectors[k]);
      await db
        .insertInto('memory_embeddings')
        .values({ memory_id: batch[k].id, model: embedder.id, content_hash: batch[k].hash, vec, embedded_at: now })
        .onConflict((oc) =>
          oc.columns(['memory_id', 'model']).doUpdateSet({ content_hash: batch[k].hash, vec, embedded_at: now }),
        )
        .execute();
      out.set(batch[k].id, unpackVector(vec));
    }
    if (embedder.metered && tokens > 0) {
      await recordTokenUsage(db, {
        userId,
        source: 'embedding',
        ref: `facts:${batch.length}`,
        model: embedder.id,
        promptTokens: tokens,
        completionTokens: 0,
        costUsd,
      }).catch(() => undefined);
    }
  }
  return out;
}

/**
 * The facts closest in meaning to `query`, best first, above
 * `SEARCH_SEMANTIC_MIN_SIM`. Empty when the asker has no embedder or the
 * embedding call failed — the word match still answers.
 */
export async function semanticFactMatches(
  db: Kysely<DB>,
  userId: string,
  facts: FactText[],
  query: string,
  opts: { limit: number },
): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q || facts.length === 0) return [];
  const embedder = await getEmbedderForUser(db, userId);
  if (!embedder) return [];
  try {
    const [vecs, qv] = await Promise.all([vectorsFor(db, userId, embedder, facts), queryVector(db, userId, embedder, q)]);
    if (!qv) return [];
    const hits: SemanticHit[] = [];
    for (const f of facts) {
      const v = vecs.get(f.id);
      if (!v) continue;
      const similarity = cosine(qv, v);
      if (similarity >= env.SEARCH_SEMANTIC_MIN_SIM) hits.push({ id: f.id, similarity });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, opts.limit);
  } catch (err) {
    logger.warn('fact meaning search failed', { userId, err: (err as Error).message });
    return [];
  }
}
