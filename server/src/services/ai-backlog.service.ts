/**
 * AI work held back because the user had not agreed to AI (ADR 0283) or had no
 * allowance left (ADR 0079/0325). Most model work runs once, when something
 * happens: a file is uploaded, a chat is imported, an email card is confirmed,
 * a message is posted. Refused then, it was simply lost. Such work is queued
 * here instead and re-run once that user has both again; nothing is read
 * before then.
 *
 * The email passes do not use this: they leave a skipped email unmarked, and
 * the next pass picks it up.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { logger } from '../config/logging.js';
import type { AiBacklogTable, DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { canUseAi, isAiRefusal } from './llm/refusal.js';

export type AiBacklogKind = AiBacklogTable['kind'];

/** Held-back work older than this is dropped, not caught up on. */
export const AI_BACKLOG_MAX_AGE_DAYS = 30;
/** At most this much per user; the oldest goes first. */
export const AI_BACKLOG_MAX_PER_USER = 200;
const USERS_PER_DRAIN = 20;
const ITEMS_PER_USER_PER_DRAIN = 5;

/** Queue one piece of work. The same work queued twice is kept once (the
 *  newer payload wins, so a resumed import starts from where it stopped). */
export async function queueAiWork(
  db: Kysely<DB>,
  work: { userId: string; kind: AiBacklogKind; ref: string; payload?: unknown },
): Promise<void> {
  const payload = work.payload === undefined ? null : JSON.stringify(work.payload);
  try {
    await db
      .insertInto('ai_backlog')
      .values({
        id: newId('aib'),
        user_id: work.userId,
        kind: work.kind,
        ref: work.ref,
        payload,
        checked_at: null,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(['user_id', 'kind', 'ref']).doUpdateSet({ payload }))
      .execute();
  } catch (err) {
    logger.warn('ai backlog: could not queue work', { kind: work.kind, err: (err as Error).message });
  }
}

export type AiBacklogRunner = (
  db: Kysely<DB>,
  item: { userId: string; ref: string; payload: unknown },
) => Promise<void>;

/**
 * One catch-up pass: for users whose work is waiting and who now have consent
 * and an allowance, run a few of their items, newest first. A user who still
 * cannot is checked again later (round-robin by `checked_at`). An item is
 * removed before it runs, so two passes never run it twice; a refusal mid-run
 * puts it back.
 */
export async function drainAiBacklog(
  db: Kysely<DB>,
  runners: Record<AiBacklogKind, AiBacklogRunner>,
): Promise<number> {
  const cutoff = new Date(Date.now() - AI_BACKLOG_MAX_AGE_DAYS * 86_400_000).toISOString();
  await db.deleteFrom('ai_backlog').where('created_at', '<', cutoff).execute();
  await sql`DELETE FROM ai_backlog WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS n FROM ai_backlog
      ) ranked WHERE n > ${AI_BACKLOG_MAX_PER_USER}
    )`.execute(db);

  const users = await db
    .selectFrom('ai_backlog')
    .select(['user_id'])
    .groupBy('user_id')
    .orderBy(sql`max(coalesce(checked_at, ''))`)
    .limit(USERS_PER_DRAIN)
    .execute();

  let ran = 0;
  for (const { user_id: userId } of users) {
    if (!(await canUseAi(db, userId))) {
      await db
        .updateTable('ai_backlog')
        .set({ checked_at: new Date().toISOString() })
        .where('user_id', '=', userId)
        .execute();
      continue;
    }
    const items = await db
      .selectFrom('ai_backlog')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(ITEMS_PER_USER_PER_DRAIN)
      .execute();
    for (const item of items) {
      const claimed = await db.deleteFrom('ai_backlog').where('id', '=', item.id).returning('id').executeTakeFirst();
      if (!claimed) continue;
      const payload = item.payload ? (JSON.parse(item.payload) as unknown) : null;
      try {
        await runners[item.kind](db, { userId, ref: item.ref, payload });
        ran += 1;
      } catch (err) {
        if (isAiRefusal(err)) {
          // Spent the last of the allowance on the way: put it back and stop.
          await queueAiWork(db, { userId, kind: item.kind, ref: item.ref, payload: payload ?? undefined });
          break;
        }
        logger.warn('ai backlog item failed', { kind: item.kind, ref: item.ref, err: (err as Error).message });
      }
    }
  }
  return ran;
}
