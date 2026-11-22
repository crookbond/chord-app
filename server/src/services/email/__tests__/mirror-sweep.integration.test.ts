/**
 * The background mirror sweep (ADR 0144), deepened to `full` by ADR 0159.
 *
 * Mail synced only when the Email tab was focused, plus once a day in the
 * briefing — so read state, deletes and new arrivals converged on exactly one
 * screen, and every other surface showed whatever was true when that screen
 * was last open.
 *
 * ADR 0144 ran the sweep at `mirror` depth, reasoning a background AI pass
 * would multiply LLM spend by sweep frequency. It doesn't: every AI pass is
 * gated on new/unmarked rows and makes zero calls when there is nothing to
 * do, so `sweepMailboxes` now runs `full` depth — the trip/task/person
 * pipeline runs as mail is processed, not only when the app is opened or the
 * briefing fires. `runLlmClassifier` stands in for that layer and
 * `notifyNewMail` for the tier above the ADR 0079 entitlement gate, so the
 * two spies still pin where entitlement stops the pipeline.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: `vi.mock` factories run above the imports and cannot close over a
// module-level binding.
const { runLlmClassifier, notifyNewMail } = vi.hoisted(() => ({
  runLlmClassifier: vi.fn(async () => {}),
  notifyNewMail: vi.fn(async () => {}),
}));
// `full` depth now reaches person extraction (ADR 0159), which imports
// `deterministicPathFor` from this same module — stub it too, or every
// deterministic-path lookup throws into a caught-and-logged warning.
vi.mock('@/services/email/llm-classifier.js', () => ({
  runLlmClassifier,
  deterministicPathFor: () => null,
}));
vi.mock('@/services/email/new-mail-notify.js', () => ({ notifyNewMail }));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { setMailSyncEnqueuer, sweepMailboxes } from '@/services/email/mirror-sweep.js';
import { connectGmailAccount } from '@/services/email-accounts/accounts.service.js';
import { afterSync, withMailSyncRound } from '@/services/google/gmail.service.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  __resetGmailMock();
  runLlmClassifier.mockClear();
  notifyNewMail.mockClear();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { MAIL_SWEEP_ENABLED: boolean }).MAIL_SWEEP_ENABLED = true;
  db = await openTestDb();
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  setMailSyncEnqueuer(null);
  await closeTestDb(db);
});

/** A user the sweep should consider: has a mailbox, and a stale mirror. */
async function userWithStaleMailbox(name: string): Promise<string> {
  const userId = await createUser(db, name);
  await connectGmailAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  await db
    .updateTable('users')
    .set({ gmail_synced_at: new Date(Date.now() - 60 * 60_000).toISOString() })
    .where('id', '=', userId)
    .execute();
  // Connecting starts a first sync in the background. Let it finish before
  // the spies are cleared, or on a slow machine it lands inside the test
  // and counts as a second sweep.
  await settleBackgroundWork();
  runLlmClassifier.mockClear();
  notifyNewMail.mockClear();
  return userId;
}

describe('mirror depth', () => {
  it('runs the mirror passes and stops before the AI layer', async () => {
    const userId = await createUser(db, 'depth-mirror');

    await withMailSyncRound(db, userId, async () => afterSync(db, userId), 'mirror');

    expect(notifyNewMail).toHaveBeenCalledTimes(1);
    expect(runLlmClassifier).not.toHaveBeenCalled();
  });

  it('full depth still runs everything', async () => {
    const userId = await createUser(db, 'depth-full');

    await withMailSyncRound(db, userId, async () => afterSync(db, userId), 'full');

    expect(notifyNewMail).toHaveBeenCalledTimes(1);
    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('a real request inside a sweep deepens the round rather than being downgraded', async () => {
    // The sweep must never cost a user the passes they actually asked for.
    const userId = await createUser(db, 'depth-nested');

    await withMailSyncRound(
      db,
      userId,
      async () => {
        await withMailSyncRound(db, userId, async () => afterSync(db, userId), 'full');
      },
      'mirror',
    );

    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('a sweep nested inside a real sync does not shallow it', async () => {
    const userId = await createUser(db, 'depth-nested-2');

    await withMailSyncRound(
      db,
      userId,
      async () => {
        await withMailSyncRound(db, userId, async () => afterSync(db, userId), 'mirror');
      },
      'full',
    );

    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });
});

describe('sweepMailboxes', () => {
  it('refreshes a user whose mirror has gone stale', async () => {
    await userWithStaleMailbox('sweep-stale');

    expect(await sweepMailboxes(db)).toBe(1);
  });

  it('runs the AI passes too (ADR 0159) — the pipeline does not wait for focus', async () => {
    await userWithStaleMailbox('sweep-with-ai');

    await sweepMailboxes(db);

    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('leaves a user whose mirror is already fresh', async () => {
    const userId = await userWithStaleMailbox('sweep-fresh');
    await db
      .updateTable('users')
      .set({ gmail_synced_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();

    expect(await sweepMailboxes(db)).toBe(0);
  });

  it('ignores a user with no mailbox at all', async () => {
    await createUser(db, 'sweep-no-mailbox');

    expect(await sweepMailboxes(db)).toBe(0);
  });

  it('ignores a shadow user', async () => {
    // ADR 0098 — a shadow never opens a client, so there is nobody for a
    // freshened mirror to be fresh for.
    const userId = await userWithStaleMailbox('sweep-shadow');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', userId).execute();

    expect(await sweepMailboxes(db)).toBe(0);
  });

  it('is off when the flag is off', async () => {
    await userWithStaleMailbox('sweep-flag-off');
    (env as { MAIL_SWEEP_ENABLED: boolean }).MAIL_SWEEP_ENABLED = false;

    expect(await sweepMailboxes(db)).toBe(0);
  });

  it('bounds the batch, stalest first', async () => {
    await userWithStaleMailbox('sweep-batch-a');
    await userWithStaleMailbox('sweep-batch-b');
    const original = env.MAIL_SWEEP_BATCH;
    (env as { MAIL_SWEEP_BATCH: number }).MAIL_SWEEP_BATCH = 1;
    try {
      expect(await sweepMailboxes(db)).toBe(1);
    } finally {
      (env as { MAIL_SWEEP_BATCH: number }).MAIL_SWEEP_BATCH = original;
    }
  });
});

describe('users whose Gmail never syncs', () => {
  it('do not keep a Gmail user out of the sweep', async () => {
    // A Google calendar-only user has a refresh token and no Gmail, so
    // gmail_synced_at stays null. Ordered by that column, a batch's worth of
    // them came first on every tick and nobody else was ever swept.
    const original = env.MAIL_SWEEP_BATCH;
    (env as { MAIL_SWEEP_BATCH: number }).MAIL_SWEEP_BATCH = 3;
    try {
      for (let i = 0; i < 4; i++) {
        const id = await createUser(db, `calendar-only-${i}`);
        await db.updateTable('users').set({ refresh_token_ciphertext: Buffer.from('x') }).where('id', '=', id).execute();
      }
      const gmailUser = await userWithStaleMailbox('sweep-starved');
      const seen: string[] = [];
      setMailSyncEnqueuer(async (userId) => {
        seen.push(userId);
      });
      await sweepMailboxes(db);
      await sweepMailboxes(db);
      expect(seen).toContain(gmailUser);
    } finally {
      (env as { MAIL_SWEEP_BATCH: number }).MAIL_SWEEP_BATCH = original;
    }
  });
});

describe('mailSyncEnqueuer (REDIS_URL set — mail-sync.queue.ts registers this)', () => {
  it('hands each candidate to the enqueuer instead of syncing inline', async () => {
    const userId = await userWithStaleMailbox('sweep-enqueued');
    const enqueuer = vi.fn(async () => {});
    setMailSyncEnqueuer(enqueuer);

    const swept = await sweepMailboxes(db);

    expect(swept).toBe(1);
    expect(enqueuer).toHaveBeenCalledTimes(1);
    expect(enqueuer).toHaveBeenCalledWith(userId);
    // The enqueuer only hands the job off — it never runs the sync itself,
    // so nothing here should have reached the AI layer.
    expect(runLlmClassifier).not.toHaveBeenCalled();
  });

  it('falls back to the inline sync once the enqueuer is cleared', async () => {
    const enqueuer = vi.fn(async () => {});
    setMailSyncEnqueuer(enqueuer);
    setMailSyncEnqueuer(null);
    await userWithStaleMailbox('sweep-cleared');

    const swept = await sweepMailboxes(db);

    expect(swept).toBe(1);
    expect(enqueuer).not.toHaveBeenCalled();
    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('one candidate throwing on enqueue does not stop the rest of the batch', async () => {
    const userA = await userWithStaleMailbox('sweep-enqueue-fail-a');
    const userB = await userWithStaleMailbox('sweep-enqueue-fail-b');
    const enqueuer = vi.fn(async (userId: string) => {
      if (userId === userA) throw new Error('queue unavailable');
    });
    setMailSyncEnqueuer(enqueuer);

    const swept = await sweepMailboxes(db);

    expect(swept).toBe(1); // only userB counted as handled
    expect(enqueuer).toHaveBeenCalledWith(userA);
    expect(enqueuer).toHaveBeenCalledWith(userB);
  });
});
