/**
 * "Expired, still owed" — bug 9's third path (owner decision 2026-08-24).
 *
 * A timed-out proposal legitimately drops the tile badge: nobody decided, so
 * nothing may claim to be handled. Letting the thread go silent WITH it is the
 * failure decision counts replaced unread to prevent, so the coverage footer
 * reports it instead.
 *
 * The discriminator is read state, which works only because every other path
 * that clears a proposal now settles the thread too — so this also pins that
 * convergence retractions and source-deletion retractions stay OUT.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listEmailDecisions } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal, expireStale } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('coverage.stillOwed', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'owed');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    return async () => closeTestDb(db);
  });

  const seedThread = async (
    gid: string,
    opts: { unread?: boolean; archived?: boolean } = {},
  ): Promise<string> => {
    const now = new Date().toISOString();
    const id = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Permission slip',
        snippet: 'snip',
        from_email: 'office@school.org',
        last_message_at: now,
        is_unread: opts.unread === false ? 0 : 1,
        is_archived: opts.archived ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  };

  /** Stage a proposal that is ALREADY past its TTL, then sweep it. */
  const stageAndTimeOut = async (gid: string): Promise<void> => {
    const p = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Return the slip'] },
      provenance: `gmail:${gid}`,
    });
    await db
      .updateTable('proposals')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', p.id)
      .execute();
    await expireStale(db);
  };

  const owed = async (): Promise<number> =>
    (await listEmailDecisions(db, userId)).coverage.stillOwed;

  it('counts a timed-out suggestion whose mail is still unread', async () => {
    await seedThread('t1');
    await stageAndTimeOut('t1');
    expect(await owed()).toBe(1);
  });

  it('hands back the thread behind the count, so it is somewhere to go', async () => {
    // ADR 0134 - a count with no destination was the bug: two of the three
    // footer counts led nowhere at all.
    const rowId = await seedThread('t9');
    await stageAndTimeOut('t9');
    const { coverage } = await listEmailDecisions(db, userId);
    expect(coverage.stillOwed).toBe(1);
    expect(coverage.owedThreadIds).toEqual([rowId]);
  });

  it('does not count one the user read — they saw it and chose not to act', async () => {
    await seedThread('t2', { unread: false });
    await stageAndTimeOut('t2');
    expect(await owed()).toBe(0);
  });

  it('lists a HANDLED thread even once archived, unlike every other listing', async () => {
    // ADR 0134's one exception to ADR 0073. Deciding never archives (it only
    // clears UNREAD); the user does, afterwards, as tidy-up. But `handledToday`
    // counts what they DID, so hiding an archived thread here makes the footer
    // claim 3 over a list of 2. Contrast the owed case below, which DOES drop
    // archived: archiving cancels an obligation, it does not undo an action.
    const rowId = await seedThread('t_handled', { archived: true, unread: false });
    const p = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Pay it'] },
      provenance: 'gmail:t_handled',
    });
    await db
      .updateTable('proposals')
      .set({ status: 'confirmed', resolved_at: new Date().toISOString() })
      .where('id', '=', p.id)
      .execute();

    const { coverage } = await listEmailDecisions(db, userId);
    expect(coverage.handledToday).toBe(1);
    expect(coverage.handledThreadIds).toEqual([rowId]);

    // ...and the list route can actually return it.
    const { listThreads } = await import('@/services/google/gmail.service.js');
    const rows = await listThreads(db, userId, { mode: 'traditional', ids: [rowId] });
    expect(rows.map((r) => r.id)).toEqual([rowId]);
    // The same thread stays hidden from ordinary browsing.
    const browsing = await listThreads(db, userId, { mode: 'traditional' });
    expect(browsing.map((r) => r.id)).not.toContain(rowId);
  });
  it('does not count an archived source — ADR 0073 says nothing is left to owe', async () => {
    await seedThread('t3', { archived: true });
    await stageAndTimeOut('t3');
    expect(await owed()).toBe(0);
  });

  it('does not count a thread that still has a LIVE decision — that is badged', async () => {
    await seedThread('t4');
    await stageAndTimeOut('t4');
    await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Return the slip'] },
      provenance: 'gmail:t4',
    });
    expect(await owed()).toBe(0);
  });

  it('counts a thread once however many of its suggestions timed out', async () => {
    await seedThread('t5');
    await stageAndTimeOut('t5');
    await stageAndTimeOut('t5');
    expect(await owed()).toBe(1);
  });

  it('is zero when nothing expired', async () => {
    await seedThread('t6');
    await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Return the slip'] },
      provenance: 'gmail:t6',
    });
    expect(await owed()).toBe(0);
  });

  it('another user’s expired suggestion is not owed by this one', async () => {
    const other = await createUser(db, 'owed-other');
    const otherGroup = await ensurePersonalGroup(db, other);
    await seedThread('t7');
    const p = await createProposal(db, {
      groupId: otherGroup.id,
      proposedByUserId: other,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Theirs'] },
      provenance: 'gmail:t7',
    });
    await db
      .updateTable('proposals')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', p.id)
      .execute();
    await expireStale(db);
    expect(await owed()).toBe(0);
  });
});
