/**
 * Keeping a user's search vectors current (ADR 0276).
 *
 * Bounded per run and newest first, so new mail is searchable by meaning soon
 * after it arrives and old mail fills in over the following ticks. A thread is
 * embedded again only when its text changed (content hash) or the user's
 * embedding model did; unchanged text is never paid for twice. Runs below the
 * ADR 0079 entitlement gate: it is an AI call, on someone's key.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { sealBytes } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { listAttachmentsForUser } from '../attachments.service.js';
import { searchablePredicate } from '../email/folders.js';
import { getEmbedderForUser, type Embedder } from '../llm/embeddings.js';
import { getEntitlement } from '../billing.service.js';
import { hasAiConsent } from '../ai-consent.service.js';
import { recordTokenUsage } from '../tokens.service.js';
import { attachmentEmbeddingText, factLines, messageBody, threadEmbeddingText } from './embed-text.js';
import { contentHash, packVector } from './vectors.js';

const BATCH = 64;

export interface EmbedPassResult {
  threads: number;
  files: number;
}

export async function runEmbedPass(
  db: Kysely<DB>,
  userId: string,
  opts: { budget?: number; embedder?: Embedder | null } = {},
): Promise<EmbedPassResult> {
  const embedder = opts.embedder === undefined ? await getEmbedderForUser(db, userId) : opts.embedder;
  if (!embedder) return { threads: 0, files: 0 };
  const budget = opts.budget ?? env.EMBED_PASS_MAX_PER_TICK;
  const threads = await embedThreads(db, userId, embedder, budget);
  const files = await embedFiles(db, userId, embedder, Math.max(0, budget - threads));
  return { threads, files };
}

/** Threads with no vector of this model, or whose thread changed since it was made. */
export async function staleThreadIds(db: Kysely<DB>, userId: string, model: string, limit: number): Promise<string[]> {
  const rows = await db
    .selectFrom('email_threads as e')
    .leftJoin('email_thread_embeddings as v', 'v.thread_id', 'e.id')
    .select('e.id')
    .where('e.user_id', '=', userId)
    .where(searchablePredicate('e.'))
    .where((eb) =>
      eb.or([
        eb('v.thread_id', 'is', null),
        eb('v.model', '<>', model),
        sql<boolean>`(${textInstant('v.embedded_at')} < ${textInstant('e.updated_at')})`,
      ]),
    )
    .orderBy('e.last_message_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

async function embedThreads(db: Kysely<DB>, userId: string, embedder: Embedder, budget: number): Promise<number> {
  if (budget <= 0) return 0;
  const ids = await staleThreadIds(db, userId, embedder.id, budget);
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const texts = await threadTexts(db, userId, batch);
    const existing = new Map(
      (
        await db
          .selectFrom('email_thread_embeddings')
          .select(['thread_id', 'model', 'content_hash'])
          .where('thread_id', 'in', batch)
          .execute()
      ).map((r) => [r.thread_id, r]),
    );
    const now = new Date().toISOString();
    const todo: Array<{ id: string; text: string; hash: string }> = [];
    for (const id of batch) {
      const text = texts.get(id);
      if (!text) continue;
      const hash = contentHash(embedder.id, text);
      const prior = existing.get(id);
      if (prior && prior.model === embedder.id && prior.content_hash === hash) {
        // The thread changed (a label, a read flag) but not its text.
        await db.updateTable('email_thread_embeddings').set({ embedded_at: now }).where('thread_id', '=', id).execute();
        continue;
      }
      todo.push({ id, text, hash });
    }
    if (todo.length === 0) continue;
    const { vectors, tokens, costUsd } = await embedder.embed(
      todo.map((t) => t.text),
      'document',
    );
    for (let k = 0; k < todo.length; k++) {
      const vec = await sealBytes(userId, packVector(vectors[k]));
      await db
        .insertInto('email_thread_embeddings')
        .values({ thread_id: todo[k].id, user_id: userId, model: embedder.id, content_hash: todo[k].hash, vec, embedded_at: now })
        .onConflict((oc) => oc.column('thread_id').doUpdateSet({ model: embedder.id, content_hash: todo[k].hash, vec, embedded_at: now }))
        .execute();
    }
    done += todo.length;
    await meter(db, userId, embedder, tokens, `email:${todo.length}`, costUsd);
  }
  return done;
}

async function threadTexts(db: Kysely<DB>, userId: string, ids: string[]): Promise<Map<string, string>> {
  const threads = await db
    .selectFrom('email_threads as e')
    .leftJoin('email_categories as c', 'c.id', 'e.category_id')
    .leftJoin('email_categories as p', 'p.id', 'c.parent_id')
    .select([
      'e.id',
      'e.subject',
      'e.from_name as fromName',
      'e.from_email as fromEmail',
      'e.receipt_json as receipt',
      'e.delivery_json as delivery',
      'e.flight_json as flight',
      'c.title as category',
      'p.title as parentCategory',
    ])
    .where('e.user_id', '=', userId)
    .where('e.id', 'in', ids)
    .execute();
  const messages = await db
    .selectFrom('email_messages')
    .select(['thread_id', 'body_html as html', 'body_text as text', 'body_excerpt as excerpt', 'to_emails', 'internal_date'])
    .where('user_id', '=', userId)
    .where('thread_id', 'in', ids)
    .orderBy('internal_date', 'asc')
    .execute();
  const byThread = new Map<string, typeof messages>();
  for (const m of messages) byThread.set(m.thread_id, [...(byThread.get(m.thread_id) ?? []), m]);

  const out = new Map<string, string>();
  for (const t of threads) {
    const ms = byThread.get(t.id) ?? [];
    const first = ms[0];
    const last = ms[ms.length - 1];
    out.set(
      t.id,
      threadEmbeddingText({
        subject: t.subject,
        fromName: t.fromName,
        fromEmail: t.fromEmail,
        toEmails: first?.to_emails ?? [],
        category: [t.parentCategory, t.category].filter(Boolean).join(' > ') || null,
        facts: factLines({ receipt: t.receipt, delivery: t.delivery, flight: t.flight }),
        firstBody: first ? messageBody(first) : '',
        latestBody: last ? messageBody(last) : '',
      }),
    );
  }
  return out;
}

async function embedFiles(db: Kysely<DB>, userId: string, embedder: Embedder, budget: number): Promise<number> {
  if (budget <= 0) return 0;
  const visible = (await listAttachmentsForUser(db, userId)).filter((a) => !a.blobMissing);
  if (visible.length === 0) return 0;
  const have = new Map(
    (
      await db
        .selectFrom('attachment_embeddings')
        .select(['attachment_id', 'model', 'content_hash'])
        .where(
          'attachment_id',
          'in',
          visible.map((a) => a.id),
        )
        .execute()
    ).map((r) => [r.attachment_id, r]),
  );
  const missing = visible.filter((a) => have.get(a.id)?.model !== embedder.id).slice(0, budget);
  if (missing.length === 0) return 0;
  const texts = new Map(
    (
      await db
        .selectFrom('attachments')
        .select(['id', 'filename', 'summary', 'extracted_text', 'scope_id'])
        .where(
          'id',
          'in',
          missing.map((a) => a.id),
        )
        .execute()
    ).map((r) => [r.id, r]),
  );
  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH).flatMap((a) => {
      const row = texts.get(a.id);
      if (!row) return [];
      const text = attachmentEmbeddingText({ filename: row.filename, summary: row.summary, text: row.extracted_text });
      return [{ id: a.id, owner: row.scope_id, text, hash: contentHash(embedder.id, text) }];
    });
    if (batch.length === 0) continue;
    const { vectors, tokens, costUsd } = await embedder.embed(
      batch.map((b) => b.text),
      'document',
    );
    const now = new Date().toISOString();
    for (let k = 0; k < batch.length; k++) {
      const vec = await sealBytes(batch[k].owner, packVector(vectors[k]));
      await db
        .insertInto('attachment_embeddings')
        .values({ attachment_id: batch[k].id, owner: batch[k].owner, model: embedder.id, content_hash: batch[k].hash, vec, embedded_at: now })
        .onConflict((oc) => oc.column('attachment_id').doUpdateSet({ model: embedder.id, content_hash: batch[k].hash, vec, embedded_at: now }))
        .execute();
    }
    done += batch.length;
    await meter(db, userId, embedder, tokens, `file:${batch.length}`, costUsd);
  }
  return done;
}

/** Chord's key spent on a user without their own key counts against their allowance (ADR 0196). */
async function meter(
  db: Kysely<DB>,
  userId: string,
  embedder: Embedder,
  tokens: number,
  ref: string,
  costUsd?: number,
): Promise<void> {
  if (!embedder.metered || tokens <= 0) return;
  try {
    await recordTokenUsage(db, { userId, source: 'embedding', ref, model: embedder.id, promptTokens: tokens, completionTokens: 0, costUsd });
  } catch (err) {
    logger.warn('embedding token usage not recorded', { userId, err: (err as Error).message });
  }
}

const sweeping = new Set<string>();
/** A user whose pass made no progress (no consent, no entitlement, no
 *  embedder for their key, or a failure) waits this long before the sweep
 *  picks them again, so they cannot hold a batch slot every tick. */
const NO_PROGRESS_PAUSE_MS = 30 * 60_000;
/** With nothing left to embed anywhere, the candidate query (an anti-join
 *  over every thread) is not re-run for this long. */
const IDLE_RECHECK_MS = 5 * 60_000;
/** How many users with unembedded mail the candidate query looks at. */
const CANDIDATE_POOL = 500;
const pausedUntil = new Map<string, number>();
const lastSwept = new Map<string, number>();
let idleUntil = 0;

/** Test seam: forget the sweep's in-memory pacing. */
export function __resetEmbedSweepForTests(): void {
  pausedUntil.clear();
  lastSwept.clear();
  idleUntil = 0;
}

/**
 * The background half (ADR 0276): users with mail that has no vector yet get
 * one bounded pass per tick, so meaning search works without the user opening
 * the Email tab, and an old mailbox fills in over a few hours. Entitlement
 * gated like every AI pass (ADR 0079).
 *
 * Fair: among users with mail to embed, the one swept longest ago goes first
 * (newest mail breaks ties), and a user whose pass did nothing is paused, so
 * one user who can never be embedded does not take the batch every tick.
 */
export async function sweepEmbeddings(db: Kysely<DB>): Promise<number> {
  if (!env.EMBEDDINGS_ENABLED) return 0;
  const now = Date.now();
  if (now < idleUntil) return 0;
  const pool = await db
    .selectFrom('email_threads as e')
    .leftJoin('email_thread_embeddings as v', 'v.thread_id', 'e.id')
    .select('e.user_id')
    .where('v.thread_id', 'is', null)
    .where(searchablePredicate('e.'))
    .groupBy('e.user_id')
    .orderBy(sql`max(e.last_message_at)`, 'desc')
    .limit(CANDIDATE_POOL)
    .execute();
  if (pool.length === 0) {
    idleUntil = now + IDLE_RECHECK_MS;
    return 0;
  }
  for (const [userId, until] of pausedUntil) if (until <= now) pausedUntil.delete(userId);
  const users = pool
    .map((r, rank) => ({ userId: r.user_id, rank }))
    .filter((u) => !pausedUntil.has(u.userId) && !sweeping.has(u.userId))
    .sort((a, b) => (lastSwept.get(a.userId) ?? 0) - (lastSwept.get(b.userId) ?? 0) || a.rank - b.rank)
    .slice(0, Math.max(1, env.EMBED_SWEEP_BATCH));
  let n = 0;
  for (const { userId } of users) {
    sweeping.add(userId);
    lastSwept.set(userId, Date.now());
    let progressed = false;
    try {
      if (!(await hasAiConsent(db, userId))) continue;
      if (env.BILLING_ENABLED && !(await getEntitlement(db, userId)).entitled) continue;
      const r = await runEmbedPass(db, userId);
      progressed = r.threads + r.files > 0;
      if (progressed) n++;
    } catch (err) {
      logger.warn('embedding sweep failed for a user', { userId, err: (err as Error).message });
    } finally {
      sweeping.delete(userId);
      if (!progressed) pausedUntil.set(userId, Date.now() + NO_PROGRESS_PAUSE_MS);
    }
  }
  return n;
}
