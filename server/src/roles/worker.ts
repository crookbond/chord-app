import type { Kysely } from 'kysely';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { claimDuty, runWhileLeader, startLeadership } from '../services/cluster/leadership.js';
import { getAccount } from '../services/email-accounts/account-utils.js';
import { syncAccount } from '../services/email-accounts/accounts.service.js';
import { startImapIdle } from '../services/email-accounts/imap-idle.js';
import { startMailSyncQueue } from '../services/email/mail-sync.queue.js';
import { registerMailPushProviders } from '../services/email/mail-push-providers.js';
import { setMailboxSyncRunner } from '../services/email/mail-push.js';
import { startSubscriptionRenewal } from '../services/email/mail-subscriptions.js';
import { startOutboxScheduler } from '../services/email/outbox.service.js';
import { startProviderDraftSync } from '../services/email/provider-drafts.service.js';
import { setMailSyncEnqueuer } from '../services/email/mirror-sweep.js';
import { syncGmailIncremental } from '../services/google/gmail.service.js';
import { startProactiveQueue } from '../services/proactive.queue.js';
import { startProactiveScheduler } from '../services/proactive.service.js';
import { startPushPublisher } from '../services/push/push-publisher.js';
import { startProposalCardStatus } from '../services/proposal-card-status.js';
import { startTodosMirror } from '../services/todos-mirror.js';

export interface WorkerRoleHandle {
  stop: () => Promise<void>;
}

/**
 * The worker role (ADR 0172): the proactive scheduler, mail sync (sweep +
 * push-webhook renewal + IMAP IDLE), the outbox scheduler, and the two
 * onBroadcast consumers with no connector-registry coupling (push-publisher,
 * todos-mirror — see `roles/web.ts` for why the other two stay there).
 * Safe to run as several copies (ADR 0280): the duties only one copy may
 * perform (IMAP IDLE sockets, push-subscription renewal, the push sender,
 * the To Do's mirror) follow the `worker` leadership lock.
 *
 * The proactive scheduler and the mail-sync sweep each run on their own
 * BullMQ queue when `REDIS_URL` is set (`proactive.queue.ts`,
 * `mail-sync.queue.ts`), falling back to their original setInterval/
 * sequential-loop behavior otherwise — dev/CI/`npm run sim` need no Redis,
 * matching every other REDIS_URL-gated fallback introduced alongside this.
 */
export async function startWorkerRole(db: Kysely<DB>): Promise<WorkerRoleHandle> {
  startLeadership(env.DATABASE_URL);
  const proactiveQueue = env.REDIS_URL
    ? await startProactiveQueue(db, env.REDIS_URL)
    : undefined;
  const scheduler = proactiveQueue ? undefined : startProactiveScheduler(db);

  const mailSyncQueue = env.REDIS_URL ? await startMailSyncQueue(db, env.REDIS_URL) : undefined;
  if (mailSyncQueue) setMailSyncEnqueuer(mailSyncQueue.enqueue);

  const stopOutbox = startOutboxScheduler(db);
  const stopProviderDrafts = startProviderDraftSync(db);

  // ADR 0118 — the sync runner is injected rather than imported by the push
  // modules, so they stay below the provider services in the dependency
  // order instead of closing a cycle with them.
  setMailboxSyncRunner(async (database, userId, accountId) => {
    if (!accountId) {
      await syncGmailIncremental(database, userId);
      return;
    }
    const account = await getAccount(database, userId, accountId);
    if (account) await syncAccount(database, account);
  });
  registerMailPushProviders();
  // ADR 0280 — with several worker copies, one of them renews push
  // subscriptions, holds IMAP IDLE sockets, sends pushes and mirrors To Do's.
  const stopRenewal = runWhileLeader('worker', () => startSubscriptionRenewal(db).stop);
  const stopIdle = runWhileLeader('worker', () => startImapIdle(db).stop);
  const releaseWorkerDuty = claimDuty('worker');
  const stopPush = startPushPublisher(db);
  const stopTodosMirror = startTodosMirror(db);
  const stopProposalCards = startProposalCardStatus(db);

  return {
    stop: async () => {
      scheduler?.stop();
      await proactiveQueue?.stop();
      setMailSyncEnqueuer(null);
      await mailSyncQueue?.stop();
      stopOutbox.stop();
      stopProviderDrafts.stop();
      await stopRenewal();
      await stopIdle();
      stopPush();
      stopTodosMirror();
      stopProposalCards();
      await releaseWorkerDuty();
    },
  };
}
