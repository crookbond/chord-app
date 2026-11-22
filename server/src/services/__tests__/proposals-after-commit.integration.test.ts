/**
 * Work the executor starts behind a write (ADR 0163's meeting summary) must
 * run after `confirmProposal`'s transaction commits, on its own handle. It
 * was started on the transaction handle, finished after the commit, failed
 * on the closed handle ("Transaction is already committed"), and the
 * confirmed event never got its summary.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/events/guests.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The calendar takes the guest; what is under test is what happens after.
  changeEventGuests: vi.fn(async (_db: unknown, args: { add?: string[] }) => ({
    ok: true,
    added: args.add ?? [],
    removed: [],
    alreadyInvited: [],
    notInvited: [],
  })),
}));
// A real model answers in seconds, after the confirm's transaction has
// committed; hold the summary job until the confirm returns to say the same.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open: () => open(), opened };
});
vi.mock('@/services/events/meeting-context.js', async (original) => {
  const real = await original<typeof import('@/services/events/meeting-context.js')>();
  return {
    ...real,
    buildAndStoreMeetingContext: async (
      db: Parameters<typeof real.buildAndStoreMeetingContext>[0],
      userId: string,
      eventId: string,
      emails: string[],
    ) => {
      await gate.opened;
      return real.buildAndStoreMeetingContext(db, userId, eventId, emails, async () => 'budget, timeline, and staffing');
    },
  };
});

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

const inDays = (n: number, time = '15:00:00'): string =>
  `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  // Just synced, so the confirm's calendar sync stays out of the way.
  await db
    .updateTable('users')
    .set({ email: 'john@example.com', google_calendar_synced_at: new Date().toISOString() })
    .where('id', '=', userId)
    .execute();
  groupId = (await createGroup(db, { name: 'Me', kind: 'group', createdBy: userId })).id;

  const iso = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const threadId = newId('et');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: threadId,
      subject: 'Q3 budget review',
      snippet: 'Can we go over the budget, timeline, and staffing plan?',
      from_email: 'bill@acme.com',
      last_message_at: iso,
      created_at: iso,
      updated_at: iso,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('em'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: newId('gm'),
      gmail_thread_id: threadId,
      from_email: 'bill@acme.com',
      to_emails: JSON.stringify(['john@example.com']),
      cc_emails: JSON.stringify([]),
      subject: 'Q3 budget review',
      snippet: 'Can we go over the budget, timeline, and staffing plan?',
      body_text: 'Can we go over the budget, timeline, and staffing plan Thursday?',
      internal_date: iso,
      created_at: iso,
    })
    .execute();
});

afterEach(async () => {
  await settleBackgroundWork();
  await closeTestDb(db);
});

describe('confirming an event with a guest', () => {
  it('saves the meeting summary once the confirm has committed', async () => {
    const id = newId('p');
    await db
      .insertInto('proposals')
      .values({
        id,
        group_id: groupId,
        proposed_by_user_id: userId,
        proposed_by_message_id: null,
        tool_name: 'create_event',
        args_json: JSON.stringify({
          title: 'Meeting with Bill',
          startsAt: inDays(4),
          endsAt: inDays(4, '16:00:00'),
          invitees: ['bill@acme.com'],
        }),
        provenance: null,
        target_group_id: null,
        status: 'pending',
        resolved_by_user_id: null,
        resolved_by_message_id: null,
        resolved_at: null,
        bundle_id: null,
        expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();

    const result = await confirmProposal(db, { id, resolvedByUserId: userId });
    expect(result.ok).toBe(true);
    gate.open();
    await settleBackgroundWork();
    await waitFor(async () =>
      !!(await db.selectFrom('events').select('meeting_context').where('owner_user_id', '=', userId).executeTakeFirst())
        ?.meeting_context,
    );

    const events = await db
      .selectFrom('events')
      .select(['title', 'meeting_context'])
      .where('owner_user_id', '=', userId)
      .execute();
    expect(events).toEqual([{ title: 'Meeting with Bill', meeting_context: 'budget, timeline, and staffing' }]);
  });
});
