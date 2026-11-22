import { Queue, QueueEvents, Worker } from 'bullmq';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { rowToMessage } from '../messages.service.js';
import { logQueueErrors, makeQueueConnection } from '../queue/redis.js';
import { runBotTurn, type BotTurnSourceBinding } from './bot.service.js';

const QUEUE_NAME = 'bot-turn';

interface BotTurnJobData {
  groupId: string;
  groupKind: 'group' | 'personal';
  messageId: string;
  tz: string | null;
  sourceBinding: BotTurnSourceBinding;
  chordVisible: number;
}

export interface BotTurnQueueHandle {
  enqueue: typeof runBotTurn;
  stop: () => Promise<void>;
}

/**
 * ADR 0178 — BullMQ-backed replacement for calling `runBotTurn` directly out
 * of `reactToMessage`'s per-group tail (ADR 0155). Unlike the proactive-scan and
 * mail-sync queues, this one is started from `roles/web.ts`, not
 * `roles/worker.ts` — a deliberate deviation from the original phased plan,
 * discovered while implementing (same shape as ADR 0172's own deviation for
 * the connector registry's two onBroadcast consumers): a silent-bridge reply
 * (`chordVisible: 0`, an IM connector turn) delivers via
 * `connectorRegistry.getForBinding(...).send(...)` inside `runBotTurn`, and
 * the connector registry is constructed only in the web role (inbound
 * webhooks need an HTTP endpoint only that role serves). Running the worker
 * anywhere else would break every silent WhatsApp/Slack/Discord/Telegram
 * reply. Splitting the registry out so bot-turn processing could move to a
 * separately-scalable tier is real future work, not done here.
 *
 * What this phase actually buys, given the worker stays co-located with the
 * enqueue call: a real process-wide concurrency cap on simultaneous LLM
 * streams (`BOT_TURN_QUEUE_CONCURRENCY` — today's fallback has none; a burst
 * across N groups launches N concurrent streams), and a queue seam that a
 * future connector-registry split can relocate with no change to
 * `bot.service.ts`. Per-group ordering (ADR 0155) is unchanged and still
 * exactly correct: `reactToMessage`'s tail promise doesn't advance until
 * `enqueue` below resolves, which doesn't happen until the queued turn
 * actually finishes — so this queue never runs two turns for the same group
 * concurrently, the same guarantee the direct call provided before.
 *
 * Deliberately at-most-once, not at-least-once: `attempts: 1` and
 * `maxStalledCount: 0` (verified against the real bullmq@6 Worker options,
 * not assumed — the default `maxStalledCount` is 1, meaning a crashed
 * worker's job is normally redelivered once automatically) turn OFF BullMQ's
 * default stalled-job redelivery. A bot turn's tool calls run in ADR 0009
 * propose mode with no idempotency key of their own; redelivering a turn
 * that crashed after inserting some proposals but before finishing would
 * rebuild context from scratch (now including those very proposals) and can
 * duplicate them. Today's direct-call fallback already has this same
 * at-most-once behavior (a mid-turn crash just silently loses that reply,
 * never retried) — this queue preserves that semantics rather than silently
 * upgrading it to something that needs its own idempotency design.
 * `lockDuration` (`BOT_TURN_QUEUE_LOCK_MS`) still has to stay comfortably
 * longer than the slowest real turn, since with stall-redelivery off a
 * falsely-detected stall would fail the turn outright instead of retrying it.
 */
export async function startBotTurnQueue(
  db: Kysely<DB>,
  redisUrl: string,
): Promise<BotTurnQueueHandle> {
  const connection = makeQueueConnection(redisUrl);
  const queue = new Queue<BotTurnJobData>(QUEUE_NAME, { connection });
  // QueueEvents does its own blocking stream reads — kept off the
  // Queue/Worker connection per the shared queue/redis.ts convention.
  const eventsConnection = makeQueueConnection(redisUrl);
  const queueEvents = new QueueEvents(QUEUE_NAME, { connection: eventsConnection });
  await queueEvents.waitUntilReady();

  const worker = new Worker<BotTurnJobData>(
    QUEUE_NAME,
    async (job) => {
      const { groupId, groupKind, messageId, tz, sourceBinding, chordVisible } = job.data;
      const row = await db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', messageId)
        .executeTakeFirst();
      if (!row) {
        // The triggering message was deleted between enqueue and processing
        // (or, in a test, the DB was already torn down). Nothing to react to.
        logger.warn('bot turn queue: trigger message no longer exists, skipping', {
          messageId,
        });
        return;
      }
      await runBotTurn(
        db,
        rowToMessage(row),
        { id: groupId, kind: groupKind },
        tz ?? undefined,
        sourceBinding,
        chordVisible,
      );
    },
    {
      connection,
      concurrency: env.BOT_TURN_QUEUE_CONCURRENCY,
      lockDuration: env.BOT_TURN_QUEUE_LOCK_MS,
      maxStalledCount: 0,
    },
  );
  logQueueErrors('bot turn queue', { queue, events: queueEvents, worker }, (m, meta) =>
    logger.error(m, meta),
  );

  return {
    enqueue: async (_db, triggerMsg, group, tz, sourceBinding, chordVisible = 1) => {
      const job = await queue.add(
        'turn',
        {
          groupId: group.id,
          groupKind: group.kind,
          messageId: triggerMsg.id,
          tz: tz ?? null,
          sourceBinding: sourceBinding ?? null,
          chordVisible,
        },
        { attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
      // Await completion so `reactToMessage`'s per-group tail (ADR 0155)
      // still serializes correctly — the tail doesn't advance until this
      // resolves, exactly like awaiting `runBotTurn` directly did.
      await job.waitUntilFinished(queueEvents);
    },
    stop: async () => {
      await worker.close();
      await queueEvents.close();
      await queue.close();
      connection.disconnect();
      eventsConnection.disconnect();
    },
  };
}
