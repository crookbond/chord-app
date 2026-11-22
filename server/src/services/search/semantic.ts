/**
 * Matching by meaning (ADR 0276): the question's vector against the user's own
 * stored vectors, compared in the app.
 *
 * Vectors are sealed per user (ADR 0201), so there is no database-side index:
 * a user's vectors are opened once into memory and kept, refreshed when the
 * stored set changes (count + newest write). At family-mailbox size (tens of
 * thousands of threads, 512 numbers each) a full comparison is a few tens of
 * milliseconds. Only vectors made by the user's current model are compared.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { openBytes } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { getEmbedderForUser, type Embedder } from '../llm/embeddings.js';
import { recordTokenUsage } from '../tokens.service.js';
import { cosine, unpackVector } from './vectors.js';

interface UserVectors {
  model: string;
  version: string;
  ids: string[];
  vecs: Float32Array[];
}

const userCache = new Map<string, UserVectors>();
const queryCache = new Map<string, { vec: Float32Array; at: number }>();
const QUERY_TTL_MS = 10 * 60_000;

export function __resetSemanticCachesForTests(): void {
  userCache.clear();
  queryCache.clear();
}

async function loadThreadVectors(db: Kysely<DB>, userId: string, model: string): Promise<UserVectors> {
  const stamp = await db
    .selectFrom('email_thread_embeddings')
    .select([sql<number>`count(*)`.as('n'), sql<string | null>`max(embedded_at)`.as('latest')])
    .where('user_id', '=', userId)
    .where('model', '=', model)
    .executeTakeFirst();
  const version = `${stamp?.n ?? 0}|${stamp?.latest ?? ''}`;
  const hit = userCache.get(userId);
  if (hit && hit.model === model && hit.version === version) {
    // Most recently used goes last, so the oldest is evicted first.
    userCache.delete(userId);
    userCache.set(userId, hit);
    return hit;
  }
  const rows = await db
    .selectFrom('email_thread_embeddings')
    .select(['thread_id', 'vec'])
    .where('user_id', '=', userId)
    .where('model', '=', model)
    .execute();
  const ids: string[] = [];
  const vecs: Float32Array[] = [];
  for (const r of rows) {
    try {
      vecs.push(unpackVector(await openBytes(r.vec)));
      ids.push(r.thread_id);
    } catch (err) {
      logger.warn('search vector could not be opened', { userId, threadId: r.thread_id, err: (err as Error).message });
    }
  }
  const loaded = { model, version, ids, vecs };
  userCache.set(userId, loaded);
  while (userCache.size > Math.max(1, env.EMBED_CACHE_USERS)) userCache.delete(userCache.keys().next().value!);
  return loaded;
}

/** The question's vector, cached briefly per user + model. Null when embedding it failed. */
export async function queryVector(
  db: Kysely<DB>,
  userId: string,
  embedder: Embedder,
  query: string,
): Promise<Float32Array | null> {
  const k = `${userId}|${embedder.id}|${query}`;
  const hit = queryCache.get(k);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return hit.vec;
  try {
    const { vectors, tokens, costUsd } = await embedder.embed([query], 'query');
    if (embedder.metered && tokens > 0) {
      await recordTokenUsage(db, { userId, source: 'embedding', ref: 'query', model: embedder.id, promptTokens: tokens, completionTokens: 0, costUsd }).catch(
        () => undefined,
      );
    }
    queryCache.set(k, { vec: vectors[0], at: Date.now() });
    if (queryCache.size > 500) queryCache.delete(queryCache.keys().next().value!);
    return vectors[0];
  } catch (err) {
    // Meaning search is an extra: when it fails, keyword results still answer.
    logger.warn('search query embedding failed', { userId, err: (err as Error).message });
    return null;
  }
}

export interface SemanticHit {
  id: string;
  similarity: number;
}

/**
 * The user's threads closest in meaning to `query`, best first. `among`
 * restricts the comparison (a person or date filter already applied); null
 * compares every thread the user has a vector for. Empty when the user has no
 * embedder (keyword search only) or embedding the question failed.
 */
export async function semanticThreadMatches(
  db: Kysely<DB>,
  userId: string,
  query: string,
  opts: { among?: string[] | null; limit: number },
): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q) return [];
  const embedder = await getEmbedderForUser(db, userId);
  if (!embedder) return [];
  const [stored, qv] = await Promise.all([loadThreadVectors(db, userId, embedder.id), queryVector(db, userId, embedder, q)]);
  if (!qv || stored.ids.length === 0) return [];
  const among = opts.among ? new Set(opts.among) : null;
  const hits: SemanticHit[] = [];
  for (let i = 0; i < stored.ids.length; i++) {
    if (among && !among.has(stored.ids[i])) continue;
    const similarity = cosine(qv, stored.vecs[i]);
    if (similarity >= env.SEARCH_SEMANTIC_MIN_SIM) hits.push({ id: stored.ids[i], similarity });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, opts.limit);
}

/**
 * How close in meaning each of `among` is to `query`, for the files that have
 * a vector of the user's current model. A file missing from the map has no
 * such vector (not embedded yet, or its key is gone). Null when the user has
 * no embedder or embedding the question failed.
 */
export async function fileSimilarities(
  db: Kysely<DB>,
  userId: string,
  query: string,
  among: string[],
): Promise<Map<string, number> | null> {
  const q = query.trim();
  if (!q || among.length === 0) return null;
  const embedder = await getEmbedderForUser(db, userId);
  if (!embedder) return null;
  const qv = await queryVector(db, userId, embedder, q);
  if (!qv) return null;
  const rows = await db
    .selectFrom('attachment_embeddings')
    .select(['attachment_id', 'vec'])
    .where('model', '=', embedder.id)
    .where('attachment_id', 'in', among)
    .execute();
  const out = new Map<string, number>();
  for (const r of rows) {
    try {
      out.set(r.attachment_id, cosine(qv, unpackVector(await openBytes(r.vec))));
    } catch {
      // An unopenable vector (destroyed key) simply does not match.
    }
  }
  return out;
}

/** Files closest in meaning, among the ones the caller may see. */
export async function semanticFileMatches(
  db: Kysely<DB>,
  userId: string,
  query: string,
  opts: { among: string[]; limit: number },
): Promise<SemanticHit[]> {
  const scores = await fileSimilarities(db, userId, query, opts.among);
  if (!scores) return [];
  const hits: SemanticHit[] = [];
  for (const [id, similarity] of scores) {
    if (similarity >= env.SEARCH_SEMANTIC_MIN_SIM) hits.push({ id, similarity });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, opts.limit);
}

/**
 * Reciprocal rank fusion (k = 60): each list votes 1/(60 + rank) for its
 * items. A thread high on both lists wins; one that only one list found still
 * places, by how high that list put it. No score from either side has to be
 * comparable with the other's, which is the point.
 */
export function fuseRanks(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
