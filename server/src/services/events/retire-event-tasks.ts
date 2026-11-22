/**
 * ADR 0192 — a to-do dies with the event it was for.
 *
 * One email routinely yields BOTH a calendar event and a to-do ("Building water
 * shut off 10 AM-2 PM" + "Prepare for the water shut off — set aside water").
 * Both carry the same `gmail:<threadId>` provenance. Deleting the event — or
 * Google/the device reporting it gone — used to leave the to-do open, still
 * due on the day the event no longer occupies, so the morning briefing kept
 * telling the user to prepare for something they had already taken off the
 * calendar. ADR 0143 retires to-dos when the SOURCE EMAIL is deleted; this is
 * the same rule for the source EVENT.
 *
 * Narrow on purpose. Only email-derived rows (`gmail:`), only the owner's own
 * open to-dos from the same thread, and only ones that were FOR the event: an
 * undated one, or one due no later than the event's end plus same-day slack. A
 * follow-up due well after it survives. If the event was merely one of two
 * copies of the same thing (a twin cleaned up by hand), a live copy from the
 * same thread within the slack window means the event was not really removed,
 * so nothing is retired.
 */
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { sseHub } from '../sse.hub.js';
import { retireTasksByProvenance } from '../tasks.service.js';

/** A to-do due the evening of the day the event ended was still for it. */
export const SAME_DAY_SLACK_MS = 12 * 60 * 60 * 1000;

/** The columns of an `events` row this needs, read BEFORE the row is deleted. */
export interface RemovedEventRow {
  owner_user_id: string | null;
  source_raw_context: string | null;
  starts_at: string;
  ends_at: string | null;
}

/**
 * Retire the open to-dos a just-removed event's email produced. Best-effort:
 * a failure is logged and swallowed, since every caller is a delete path that
 * must finish regardless.
 */
export async function retireTasksForRemovedEvents(
  db: Kysely<DB>,
  removed: RemovedEventRow[],
): Promise<void> {
  for (const ev of removed) {
    try {
      const provenance = ev.source_raw_context;
      if (!ev.owner_user_id || !provenance?.startsWith('gmail:')) continue;
      const startMs = Date.parse(ev.starts_at);
      if (!Number.isFinite(startMs)) continue;
      const endMs = ev.ends_at ? Date.parse(ev.ends_at) : NaN;
      const lastMs = Number.isFinite(endMs) ? Math.max(startMs, endMs) : startMs;
      const cutoff = new Date(lastMs + SAME_DAY_SLACK_MS).toISOString();

      if (await liveCopyRemains(db, ev.owner_user_id, provenance, startMs)) continue;

      const retired = await retireTasksByProvenance(db, ev.owner_user_id, [provenance], {
        dueOnOrBefore: cutoff,
      });
      for (const task of retired) {
        logger.info('task.retired-with-event', {
          taskId: task.id,
          groupId: task.groupId,
          provenance,
        });
        sseHub.broadcast(task.groupId, SSE.taskUpdated, task);
      }
    } catch (err) {
      logger.warn('retireTasksForRemovedEvents failed', { err: String(err) });
    }
  }
}

/**
 * Is there still a live event for this owner from the same email starting
 * within the slack window of the removed one? Called AFTER the removed row is
 * gone (or tombstoned), so any hit is a different row — the twin that stays.
 */
async function liveCopyRemains(
  db: Kysely<DB>,
  ownerUserId: string,
  provenance: string,
  startMs: number,
): Promise<boolean> {
  const rows = await db
    .selectFrom('events')
    .select('starts_at')
    .where('owner_user_id', '=', ownerUserId)
    .where('source_raw_context', '=', provenance)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .execute();
  return rows.some((r) => {
    const t = Date.parse(r.starts_at);
    return Number.isFinite(t) && Math.abs(t - startMs) <= SAME_DAY_SLACK_MS;
  });
}
