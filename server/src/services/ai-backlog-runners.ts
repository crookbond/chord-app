/**
 * What each kind of held-back AI work runs (`ai-backlog.service.ts`). Kept
 * apart from the queue so the modules that queue work never import each
 * other through it.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { drainAiBacklog, type AiBacklogKind, type AiBacklogRunner } from './ai-backlog.service.js';
import { rerunHeldBackExtraction } from './attachments.service.js';
import { rerunHeldBackMemory } from './bot/bot.service.js';
import { buildAndStoreMeetingContext } from './events/meeting-context.js';
import { rerunHeldBackImportExtraction } from './ingest/whatsapp/pipeline.js';

export const AI_BACKLOG_RUNNERS: Record<AiBacklogKind, AiBacklogRunner> = {
  attachment: (db, { ref }) => rerunHeldBackExtraction(db, ref),
  whatsapp_import: async (db, { userId, ref, payload }) => {
    const from = (payload as { fromWindow?: number } | null)?.fromWindow ?? 0;
    await rerunHeldBackImportExtraction(db, userId, ref, from);
  },
  meeting_context: async (db, { userId, ref, payload }) => {
    const emails = (payload as { attendeeEmails?: string[] } | null)?.attendeeEmails ?? [];
    if (emails.length > 0) await buildAndStoreMeetingContext(db, userId, ref, emails);
  },
  memory_message: (db, { userId, ref }) => rerunHeldBackMemory(db, userId, ref),
};

const MIN_GAP_MS = 60_000;
let lastRun = 0;

/** Proactive-tick entry: at most once a minute. */
export async function maybeDrainAiBacklog(db: Kysely<DB>, now = Date.now()): Promise<number> {
  if (now - lastRun < MIN_GAP_MS) return 0;
  lastRun = now;
  return drainAiBacklog(db, AI_BACKLOG_RUNNERS);
}
