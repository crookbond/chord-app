/**
 * ADR 0099 — "send me my briefing" must run the real briefing.
 *
 * The incident: a user asked three times, in three different phrasings, and got
 * three improvised summaries instead. The registry had `set_nudge_time`, which
 * only *schedules* a briefing, and nothing that runs one — so the model did its
 * best from context, and a made-up briefing reads exactly like a real one.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { __testing as enumTesting } from '@/services/bot/enumeration.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('send_briefing', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    enumTesting.reset();
    userId = await createUser(db, 'asker');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  function ask(groupId: string, turnId: string | null) {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      call: { name: 'send_briefing', args: {} },
    });
  }

  async function briefingsIn(groupId: string) {
    return db
      .selectFrom('messages')
      .select(['id', 'body'])
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .where('is_proactive', '=', 1)
      .execute();
  }

  it('posts a real briefing into the personal group', async () => {
    const result = await ask(personalId, 'turn-1');

    expect((result.data as { ran: boolean }).ran).toBe(true);
    expect(await briefingsIn(personalId)).toHaveLength(1);
  });

  /**
   * The tool posts the briefing itself; handing the text back would invite the
   * model to paraphrase a deterministic artifact.
   */
  it('does not return the briefing text for the model to restate', async () => {
    const result = await ask(personalId, 'turn-1');

    expect(JSON.stringify(result.data ?? {})).not.toContain('Morning');
    expect(result.summary.length).toBeLessThan(120);
  });

  it('refuses in a shared group and writes nothing there', async () => {
    const shared = await createGroup(db, {
      name: 'Fam',
      kind: 'group',
      createdBy: userId,
    });

    const result = await ask(shared.id, 'turn-1');

    expect((result.data as { reason: string }).reason).toBe('not_personal');
    expect(await briefingsIn(shared.id)).toHaveLength(0);
  });

  /** Belt and braces: the turn loop also filters it out before the model sees it. */
  it('is registered personal-only so a shared turn is never offered it', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('send_briefing')).toBe(true);
  });

  /**
   * The ADR 0005 loop re-streams up to 20 times and each briefing costs an LLM
   * scan plus a mailbox sync, so one sentence must not buy twenty.
   */
  it('runs at most once per turn', async () => {
    const first = await ask(personalId, 'turn-1');
    const second = await ask(personalId, 'turn-1');

    expect((first.data as { ran: boolean }).ran).toBe(true);
    expect((second.data as { reason: string }).reason).toBe('already_sent_this_turn');
    expect(await briefingsIn(personalId)).toHaveLength(1);
  });

  it('gives the next turn its own allowance', async () => {
    await ask(personalId, 'turn-1');
    const next = await ask(personalId, 'turn-2');

    expect((next.data as { ran: boolean }).ran).toBe(true);
    expect(await briefingsIn(personalId)).toHaveLength(2);
  });
});
