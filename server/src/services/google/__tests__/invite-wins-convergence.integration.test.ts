/**
 * "Invite wins" (ADR 0074 addendum), as narrowed by ADR 0344: a meeting
 * agreed in plain email becomes a Chord event; when the REAL calendar invite
 * later arrives for that slot — via a Google-side accept (pull) or via the
 * invite email's confirm — a still-pending email proposal for the slot is
 * retracted, the invite is added as its own event, and Chord ASKS in the
 * personal chat whether to remove the email-made one. Nothing is taken over
 * or removed without a tap.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const base = Date.now() + 3 * 86_400_000;
const slotIso = new Date(base).toISOString();
const slotPlus15 = new Date(base + 15 * 60_000).toISOString();
const slotEnd = new Date(base + 45 * 60_000).toISOString();
const farIso = new Date(base + 5 * 3_600_000).toISOString();
const SAM = 'sam@example.com';

describe('invite-wins convergence', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'invite-wins-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    // The emails the coffee was agreed in, and the invite email.
    for (const gid of ['t_agree', 't_agree2', 't_invite']) {
      await seedSyncedMail(db, userId, { gmailThreadId: gid, subject: 'Coffee?', fromEmail: SAM });
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const seedEmailEvent = () =>
    createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Coffee with John',
      startsAt: slotIso,
      sourceRawContext: 'gmail:t_agree',
    });

  const seedPendingEmailProposal = () =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Coffee with John', startsAt: slotIso },
      provenance: 'gmail:t_agree2',
    });

  const ownerEvents = () =>
    db
      .selectFrom('events')
      .select(['id', 'title', 'gcal_event_id', 'ical_uid', 'external_uid'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();

  const questionsAbout = async (eventId: string) => {
    const rows = await db
      .selectFrom('proposals')
      .select('args_json')
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'delete_event')
      .where('status', '=', 'pending')
      .execute();
    return rows.filter((r) => (JSON.parse(r.args_json) as { eventId?: string }).eventId === eventId);
  };

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/events')) return gjson({ items, nextSyncToken: 'tok1' });
        return gjson({});
      }),
    );

  const samsInvite = {
    id: 'GG1',
    status: 'confirmed',
    summary: 'Coffee: John / Sam',
    iCalUID: 'uid-real-invite@google.com',
    start: { dateTime: slotPlus15 },
    end: { dateTime: slotEnd },
    updated: new Date().toISOString(),
    sequence: 0,
    organizer: { email: SAM },
  };

  it('Google-side accept adds the invite beside the email event, asks, and retracts the pending proposal', async () => {
    const emailEvent = await seedEmailEvent();
    const proposal = await seedPendingEmailProposal();
    stubPull([samsInvite]);

    const result = await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(result.inserted).toBe(1);

    const rows = await ownerEvents();
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.id === emailEvent.id);
    expect(kept?.title).toBe('Coffee with John');
    expect(kept?.gcal_event_id).toBeNull();
    expect(rows.find((r) => r.gcal_event_id === 'GG1')?.title).toBe('Coffee: John / Sam');
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);

    const p = await db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', proposal.id)
      .executeTakeFirstOrThrow();
    expect(p.status).toBe('expired');
  });

  it('an unrelated remote event at a different time still inserts', async () => {
    await seedEmailEvent();
    stubPull([
      {
        id: 'GG2',
        status: 'confirmed',
        summary: 'Dentist',
        iCalUID: 'uid-dentist@google.com',
        start: { dateTime: farIso },
        end: { dateTime: new Date(Date.parse(farIso) + 30 * 60_000).toISOString() },
        updated: new Date().toISOString(),
        sequence: 0,
      },
    ]);

    const result = await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(result.inserted).toBe(1);
    expect(await ownerEvents()).toHaveLength(2);
  });

  it('an invite near the slot with nobody in common and another title is just added, no question', async () => {
    const emailEvent = await seedEmailEvent();
    const proposal = await seedPendingEmailProposal();
    stubPull([
      {
        ...samsInvite,
        summary: 'Quarterly review',
        organizer: { email: 'boss@work.example' },
        attendees: [{ email: 'boss@work.example' }, { email: 'peer@work.example' }],
      },
    ]);

    const result = await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(result.inserted).toBe(1);
    expect(await ownerEvents()).toHaveLength(2);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(0);
    const p = await db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', proposal.id)
      .executeTakeFirstOrThrow();
    expect(p.status).toBe('pending');
  });

  it('a Google-side DECLINE never inserts, clears the cards, and asks about the email event', async () => {
    const emailEvent = await seedEmailEvent();
    const keyless = await seedPendingEmailProposal();
    // The invite email also staged its UID-keyed card.
    const uidProposal = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: {
        title: 'Coffee with John',
        startsAt: slotPlus15,
        externalUid: 'uid-real-invite@google.com',
      },
      provenance: 'gmail:t_invite',
    });

    stubPull([
      {
        id: 'GG1',
        status: 'confirmed', // Google keeps declined events 'confirmed'
        summary: 'Coffee with John',
        iCalUID: 'uid-real-invite@google.com',
        start: { dateTime: slotPlus15 },
        end: { dateTime: slotEnd },
        updated: new Date().toISOString(),
        sequence: 0,
        attendees: [
          { email: 'organizer@example.com', responseStatus: 'accepted' },
          { self: true, responseStatus: 'declined' },
        ],
      },
    ]);

    const result = await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(result.inserted).toBe(0);
    expect(result.deleted).toBe(0);
    const rows = await ownerEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(emailEvent.id);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);

    const statuses = await db
      .selectFrom('proposals')
      .select(['id', 'status'])
      .where('id', 'in', [keyless.id, uidProposal.id])
      .execute();
    expect(statuses.every((p) => p.status === 'expired')).toBe(true);
  });

  it('a later re-accept inserts the event normally', async () => {
    const declined = {
      id: 'GG1',
      status: 'confirmed',
      summary: 'Coffee with John',
      iCalUID: 'uid-real-invite@google.com',
      start: { dateTime: slotPlus15 },
      end: { dateTime: slotEnd },
      updated: new Date().toISOString(),
      sequence: 0,
      attendees: [{ self: true, responseStatus: 'declined' }],
    };
    stubPull([declined]);
    await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(await ownerEvents()).toHaveLength(0);

    vi.unstubAllGlobals();
    stubPull([
      { ...declined, attendees: [{ self: true, responseStatus: 'accepted' }] },
    ]);
    const result = await pullCalendarChanges(db, userId, 'cal1', 'fake-token');
    expect(result.inserted).toBe(1);
    expect(await ownerEvents()).toHaveLength(1);
  });

  it('confirming the invite email adds the invite and asks, instead of taking over the email event', async () => {
    const emailEvent = await seedEmailEvent();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: 'gmail:t_invite',
      call: {
        name: 'create_event',
        args: {
          title: 'Coffee (invite)',
          startsAt: slotPlus15,
          endsAt: slotEnd,
          externalUid: 'uid-real-invite@google.com',
        },
      },
    });

    const rows = await ownerEvents();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === emailEvent.id)?.title).toBe('Coffee with John');
    const invite = rows.find((r) => r.id !== emailEvent.id);
    expect(invite?.external_uid).toBe('uid-real-invite@google.com');
    expect(invite?.title).toBe('Coffee (invite)');
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);
  });
});
