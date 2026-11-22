/**
 * Mail that arrived before we started keeping the message (ADR 0110).
 *
 * Sync now stores a bounded `body_excerpt`, but only for messages it fetches
 * from here on. Prod's existing mirror is 2,700-odd messages with 47 bodies
 * between them, and reclassifying those on the snippet alone re-runs the pass
 * on the same too-little text that produced the wrong answer the first time.
 *
 * So this drains the backlog a few per sync, and re-queues each thread for
 * classification as its input improves — which is what sequences the two
 * without a second queue to keep in step.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { sealMessageContent } from './content-seal.js';
import type { DB } from '../../db/schema.js';
import { BODY_EXCERPT_CHARS } from '../../utils/email-text.js';
import { fetchFullBodyText } from '../email-accounts/message-text.js';

export interface BodyBackfillResult {
  /** Messages fetched (and settled) this pass. */
  processed: number;
  /** Messages that actually yielded text. */
  filled: number;
}

/** Failed fetches per message, so one that always fails cannot hold its
 *  place at the head of the queue for ever. In memory: a restart only means
 *  a few more tries. */
const failedFetches = new Map<string, number>();
const MAX_FETCH_ATTEMPTS = 5;

export async function backfillBodyExcerpts(
  db: Kysely<DB>,
  userId: string,
  opts: { limit?: number } = {},
): Promise<BodyBackfillResult> {
  const limit = Math.min(Math.max(opts.limit ?? env.EMAIL_BODY_BACKFILL_PER_TICK, 0), 100);
  if (limit === 0) return { processed: 0, filled: 0 };

  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'gmail_thread_id'])
    .where('user_id', '=', userId)
    .where('body_text', 'is', null)
    .where('body_excerpt', 'is', null)
    // Newest first: recent mail is the mail still worth acting on, and a
    // backlog that never finishes should have done the useful end of it.
    .orderBy('internal_date', 'desc')
    .limit(limit)
    .execute();
  if (rows.length === 0) return { processed: 0, filled: 0 };

  let filled = 0;
  for (const row of rows) {
    let text: string | null = null;
    try {
      text = await fetchFullBodyText(db, userId, row.id);
      failedFetches.delete(row.id);
    } catch (err) {
      logger.warn('body excerpt backfill failed', { userId, id: row.id, err: (err as Error).message });
      // A failed fetch says nothing about the message (quota, network, a
      // provider outage), so it is not marked as having no text. It is asked
      // again on later passes, and settled only once it keeps failing.
      const attempts = (failedFetches.get(row.id) ?? 0) + 1;
      if (attempts < MAX_FETCH_ATTEMPTS) {
        if (failedFetches.size >= 10_000) failedFetches.clear();
        failedFetches.set(row.id, attempts);
        continue;
      }
      failedFetches.delete(row.id);
    }
    // '' rather than null when the fetch worked and the message simply has no
    // text: null means "never looked", and a message with nothing in it would
    // otherwise sit at the head of this queue forever.
    await db
      .updateTable('email_messages')
      .set(
        await sealMessageContent(
          userId,
          { body_excerpt: text ? text.slice(0, BODY_EXCERPT_CHARS) : '' },
          { index: 'excerpt-until-full' },
        ),
      )
      .where('id', '=', row.id)
      .execute();
    if (!text) continue;
    filled += 1;
    // The thread now has something worth re-reading, so put it back in the
    // classifier's queue. Version 0 is behind any current version by
    // construction, so this needs no knowledge of what that version is.
    await db
      .updateTable('email_threads')
      .set({ classifier_version: 0 })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', row.gmail_thread_id)
      .execute();
  }

  if (filled > 0) {
    logger.info(`email body backfill user=${userId} filled=${filled} scanned=${rows.length}`);
  }
  return { processed: rows.length, filled };
}
