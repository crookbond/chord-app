/**
 * Two answers to one card at the same moment — a double tap, or the app and a
 * WhatsApp "yes" — must run the card's tool once.
 *
 * The bug: confirmProposal checked `status !== 'pending'` before its
 * transaction and commitRow flipped the status with no status guard, so both
 * confirms passed the check and both ran the tool (two tasks, two emails).
 *
 * The confirms run on a handle with a real pool: the default test handle has
 * one connection, so its calls take turns and could never overlap.
 */
import { Kysely, type KyselyPlugin } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  confirmProposal,
  createProposal,
  listProposalsForGroup,
  listProposalsForUser,
  rejectProposal,
} from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import {
  closeParallelHandle,
  closeTestDb,
  createUser,
  openParallelHandle,
  openTestDb,
} from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let par: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  par = openParallelHandle(db);
  userId = await createUser(db, 'john', 'John Doe');
  groupId = (await ensurePersonalGroup(db, userId)).id;
});

afterEach(async () => {
  await settleBackgroundWork();
  await closeParallelHandle(par);
  await closeTestDb(db);
});

async function stageTask(title: string, bundleId?: string) {
  return createProposal(db, {
    groupId,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_task',
    args: { title },
    provenance: null,
    ...(bundleId ? { bundleId } : {}),
  });
}

async function taskTitles(): Promise<string[]> {
  const rows = await db.selectFrom('tasks').select('title').where('group_id', '=', groupId).execute();
  return rows.map((r) => r.title).sort();
}

describe('confirming one card twice at the same moment', () => {
  it('runs the tool once and tells the second caller it was already answered', async () => {
    const p = await stageTask('Sign the permission slip');

    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        confirmProposal(par, { id: p.id, resolvedByUserId: userId }),
        confirmProposal(par, { id: p.id, resolvedByUserId: userId }),
      ]);
      if (round === 0) {
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason)).toEqual([
          'already_resolved',
        ]);
      } else {
        expect(results.every((r) => !r.ok)).toBe(true);
      }
    }
    expect(await taskTitles()).toEqual(['Sign the permission slip']);
  });

  it('a bundle confirmed twice at once is created once', async () => {
    const a = await stageTask('Sign the slip', 'bundle_slip');
    const b = await stageTask('Pay the $12 fee', 'bundle_slip');

    const results = await Promise.all([
      confirmProposal(par, { id: a.id, resolvedByUserId: userId }),
      confirmProposal(par, { id: b.id, resolvedByUserId: userId }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await taskTitles()).toEqual(['Pay the $12 fee', 'Sign the slip']);
  });

  // CI, PR 273: the second confirm read its own card while it was still
  // pending, the first confirm then committed the whole bundle, and the
  // second found no pending cards left, claimed an empty list, wrote nothing
  // and still said ok. The plugin pins that order: after the second confirm
  // reads its card, it waits until the first has committed.
  it('a bundle card whose bundle was confirmed after it was read says already_resolved, not ok', async () => {
    const a = await stageTask('Sign the slip', 'bundle_order');
    const b = await stageTask('Pay the $12 fee', 'bundle_order');
    let first: Promise<unknown> | null = null;
    const afterRead: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        const rows = args.result.rows as Array<{ id?: string; status?: string }>;
        if (!first && rows.length === 1 && rows[0].id === b.id && rows[0].status === 'pending') {
          first = confirmProposal(db, { id: a.id, resolvedByUserId: userId });
          await first;
        }
        return args.result;
      },
    };
    const second = await confirmProposal(par.withPlugin(afterRead), { id: b.id, resolvedByUserId: userId });
    expect(await first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'already_resolved' });
    expect(await taskTitles()).toEqual(['Pay the $12 fee', 'Sign the slip']);
  });

  it('a confirm and a reject at once leave status and data agreeing', async () => {
    for (let i = 0; i < 3; i++) {
      const p = await stageTask(`Call the plumber ${i}`);
      await Promise.all([
        confirmProposal(par, { id: p.id, resolvedByUserId: userId }),
        rejectProposal(par, { id: p.id, resolvedByUserId: userId }),
      ]);
      const row = await db.selectFrom('proposals').select('status').where('id', '=', p.id).executeTakeFirstOrThrow();
      const made = (await taskTitles()).includes(`Call the plumber ${i}`);
      expect(row.status === 'confirmed').toBe(made);
    }
  });
});

describe('listing a user\'s proposals', () => {
  it('never drops a pending card behind decided ones', async () => {
    const old = await stageTask('Renew the passport');
    // Make it the oldest row, then pile up more decided ones than the cap.
    await db
      .updateTable('proposals')
      .set({ created_at: new Date(Date.now() - 86_400_000).toISOString() })
      .where('id', '=', old.id)
      .execute();
    const now = new Date().toISOString();
    const decided = Array.from({ length: 205 }, (_, i) => ({
      id: `p_done_${i}`,
      group_id: groupId,
      proposed_by_user_id: userId,
      proposed_by_message_id: null,
      tool_name: 'create_task',
      args_json: JSON.stringify({ title: `done ${i}` }),
      provenance: null,
      target_group_id: null,
      status: 'rejected' as const,
      resolved_by_user_id: userId,
      resolved_by_message_id: null,
      resolved_at: now,
      bundle_id: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: now,
    }));
    await db.insertInto('proposals').values(decided).execute();

    const all = await listProposalsForUser(db, userId);
    expect(all.map((p) => p.id)).toContain(old.id);
    // The group listing (the chat's pending pills) follows the same rule.
    const inGroup = await listProposalsForGroup(db, groupId);
    expect(inGroup.map((p) => p.id)).toContain(old.id);
  });
});
