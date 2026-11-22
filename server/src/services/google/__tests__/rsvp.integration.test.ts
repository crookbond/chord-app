/**
 * Answering an invitation (ADR 0104).
 *
 * The whole reason this has two routes: the Calendar API's only RSVP is a
 * patch of your own `attendees` entry, and the invitation Google is holding
 * back — the case that prompted the feature — is not on the calendar to be
 * patched. So the patch is tried, and an iTIP REPLY carries the answer when it
 * cannot be.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { buildItipReplyRaw } from '@/services/google/gmail-sync.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { suggestionFromProposal } from '@/services/email/magics.service.js';
import { respondToInvite } from '@/services/google/rsvp.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const UID = '760peqpjqopqhsl0mm34au3kf6@google.com';

function json(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('respondToInvite', () => {
  let db: Kysely<DB>;
  let userId: string;
  let calls: { method: string; url: string; body?: unknown }[];

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'rsvp-user');
    await db
      .updateTable('users')
      .set({ email: 'ownertest@gmail.com', display_name: 'John Doe' })
      .where('id', '=', userId)
      .execute();
    calls = [];
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  /** `onList` decides whether the invitation is visible on the calendar. */
  const stub = (onList: () => unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          url: u,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (u.includes('/calendar/v3/') && method === 'GET') return json(onList());
        if (u.includes('/calendar/v3/') && method === 'PATCH') return json({ id: 'GG1' });
        if (u.includes('gmail')) return json({ id: 'sent1', threadId: 't1' });
        return json({});
      }),
    );

  const onCalendar = () => ({
    items: [
      {
        id: 'GG1',
        iCalUID: UID,
        summary: 'John / Shail Coffee',
        organizer: { email: 'sharon@founder.example' },
        attendees: [
          { email: 'sharon@founder.example', organizer: true, responseStatus: 'accepted' },
          { email: 'ownertest@gmail.com', self: true, responseStatus: 'needsAction' },
        ],
      },
    ],
  });

  it('patches the attendee entry when the invitation is on the calendar', async () => {
    stub(onCalendar);

    const r = await respondToInvite(db, userId, { icalUid: UID, response: 'accepted' });

    expect(r).toMatchObject({ ok: true, via: 'calendar' });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    // sendUpdates is what makes this reach the organizer rather than being a
    // private note to ourselves.
    expect(patch!.url).toContain('sendUpdates=all');
    const attendees = (patch!.body as { attendees: { email: string; responseStatus: string }[] })
      .attendees;
    // The whole array goes back: a patch REPLACES attendees, so dropping the
    // others would un-invite them.
    expect(attendees).toHaveLength(2);
    expect(attendees.find((a) => a.email === 'ownertest@gmail.com')!.responseStatus).toBe('accepted');
    expect(attendees.find((a) => a.email === 'sharon@founder.example')!.responseStatus).toBe(
      'accepted',
    );
    expect(calls.some((c) => c.url.includes('gmail'))).toBe(false);
  });

  it('sends an iTIP reply when Google is still holding the invitation', async () => {
    stub(() => ({ items: [] }));

    const r = await respondToInvite(db, userId, {
      icalUid: UID,
      response: 'accepted',
      organizerEmail: 'sharon@founder.example',
      title: 'John / Shail Coffee',
    });

    expect(r).toMatchObject({ ok: true, via: 'email' });
    const sent = calls.find((c) => c.url.includes('gmail'));
    expect(sent).toBeTruthy();
    const mime = decodeRaw((sent!.body as { raw: string }).raw);
    expect(mime).toContain('METHOD:REPLY');
    expect(mime).toContain(`UID:${UID}`);
    expect(mime).toContain('PARTSTAT=ACCEPTED');
    expect(mime).toContain('To: sharon@founder.example');
    expect(mime).toContain('method=REPLY');
  });

  it('cannot answer without an organizer, and says so rather than half-succeeding', async () => {
    stub(() => ({ items: [] }));

    const r = await respondToInvite(db, userId, { icalUid: UID, response: 'accepted' });

    expect(r).toMatchObject({ ok: false, via: null, reason: 'no_organizer' });
    expect(calls.some((c) => c.url.includes('gmail'))).toBe(false);
  });

  it('falls back to email when the patch itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          url: u,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (u.includes('/calendar/v3/') && method === 'GET') return json(onCalendar());
        if (u.includes('/calendar/v3/') && method === 'PATCH') return json({}, false);
        return json({ id: 'sent1', threadId: 't1' });
      }),
    );

    const r = await respondToInvite(db, userId, { icalUid: UID, response: 'tentative' });

    // The organizer learns the answer either way — a failed patch is not a
    // reason to leave them uninformed.
    expect(r).toMatchObject({ ok: true, via: 'email' });
    const sent = calls.find((c) => c.url.includes('gmail'));
    expect(decodeRaw((sent!.body as { raw: string }).raw)).toContain('PARTSTAT=TENTATIVE');
  });

  it('declines through the same path', async () => {
    stub(onCalendar);
    const r = await respondToInvite(db, userId, { icalUid: UID, response: 'declined' });

    expect(r).toMatchObject({ ok: true, via: 'calendar' });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    const attendees = (patch.body as { attendees: { self?: boolean; responseStatus: string }[] })
      .attendees;
    expect(attendees.find((a) => a.self)!.responseStatus).toBe('declined');
  });
});

/**
 * An answer given in one place is an answer everywhere. Chord → Google is the
 * RSVP itself; this is the other direction — answering in Gmail or the Calendar
 * app has to clear the Chord suggestion, or the same meeting sits on the
 * calendar AND in Action Items still asking whether to add it.
 */
describe('an invitation answered in Google clears the Chord suggestion', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  const start = new Date(Date.now() + 3 * 86_400_000).toISOString();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sync-back-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stageInvite = () =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: {
        title: 'John / Shail Coffee',
        startsAt: start,
        externalUid: UID,
        alreadyInGoogle: true,
        organizerEmail: 'sharon@founder.example',
      },
      provenance: 'gmail:t_invite',
    });

  const pullWith = (responseStatus: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events')
          ? json({
              items: [
                {
                  id: 'GG1',
                  status: 'confirmed',
                  summary: 'John / Shail Coffee',
                  iCalUID: UID,
                  start: { dateTime: start },
                  end: { dateTime: new Date(Date.parse(start) + 2_700_000).toISOString() },
                  updated: new Date().toISOString(),
                  sequence: 0,
                  organizer: { email: 'sharon@founder.example' },
                  attendees: [
                    { email: 'sharon@founder.example', organizer: true, responseStatus: 'accepted' },
                    { email: 'ownertest@gmail.com', self: true, responseStatus },
                  ],
                },
              ],
              nextSyncToken: 'tok1',
            })
          : json({}),
      ),
    );
    return pullCalendarChanges(db, userId, 'primary', 'fake-token');
  };

  const statusOf = async (id: string) =>
    (
      await db
        .selectFrom('proposals')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  it('an accept made in Gmail retracts the pending suggestion', async () => {
    const p = await stageInvite();
    await pullWith('accepted');
    expect(await statusOf(p.id)).toBe('expired');
  });

  it('a tentative answer counts too', async () => {
    const p = await stageInvite();
    await pullWith('tentative');
    expect(await statusOf(p.id)).toBe('expired');
  });

  it('an UNANSWERED invitation keeps its suggestion — that card is how you answer', async () => {
    const p = await stageInvite();
    await pullWith('needsAction');
    expect(await statusOf(p.id)).toBe('pending');
  });
});

describe('buildItipReplyRaw', () => {
  it('escapes a summary that would otherwise split the property', () => {
    const mime = Buffer.from(
      buildItipReplyRaw({
        fromEmail: 'me@example.com',
        fromName: 'Me; Myself, and I',
        organizerEmail: 'them@example.com',
        icalUid: 'u1',
        partstat: 'ACCEPTED',
        summary: 'Lunch; then a walk, maybe',
        sequence: 3,
      }),
      'base64url',
    ).toString('utf8');

    expect(mime).toContain('SUMMARY:Lunch\\; then a walk\\, maybe');
    // A parameter value is quoted, not backslash-escaped: escaped, the comma
    // ended the parameter and the organizer's calendar read the name as "Me\".
    expect(mime).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN="Me; Myself, and I":mailto:me@example.com');
    // And in the From header a bare comma would split one sender into two.
    expect(mime).toContain('From: "Me; Myself, and I" <me@example.com>');
    expect(mime).toContain('SEQUENCE:3');
  });

  it('carries exactly one ATTENDEE — the responder', () => {
    const mime = Buffer.from(
      buildItipReplyRaw({
        fromEmail: 'me@example.com',
        fromName: null,
        organizerEmail: 'them@example.com',
        icalUid: 'u1',
        partstat: 'DECLINED',
        summary: 'Standup',
        sequence: 0,
      }),
      'base64url',
    ).toString('utf8');

    expect(mime.match(/^ATTENDEE/gm) ?? []).toHaveLength(1);
    // No DTSTART: a REPLY that restates the time is how a reply ends up
    // "correcting" a meeting nobody asked us to change.
    expect(mime).not.toContain('DTSTART');
  });
});

/**
 * ADR 0104 follow-up: confirming an invitation from ANY surface (the docked
 * email card's old "Add to calendar", the feeds, a chat "yes", a Telegram tap)
 * answers the organizer. Before, only the Yes/Maybe/No route did, so the same
 * meeting was added to Chord while the organizer still saw "no response".
 */
describe('confirming an invitation answers the organizer', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let sent: { url: string; body?: { raw?: string } }[];

  const start = new Date(Date.now() + 3 * 86_400_000).toISOString();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'confirm-invite-user');
    await db
      .updateTable('users')
      .set({ email: 'ownertest@gmail.com', display_name: 'John Doe' })
      .where('id', '=', userId)
      .execute();
    groupId = (await ensurePersonalGroup(db, userId)).id;
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/calendar/v3/') && (init?.method ?? 'GET') === 'GET') {
          return json({ items: [] });
        }
        sent.push({ url: u, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return json({ id: 'sent1', threadId: 't1' });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stage = (organizerEmail?: string) =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: {
        title: 'John / Shail Coffee',
        startsAt: start,
        externalUid: UID,
        alreadyInGoogle: true,
        ...(organizerEmail ? { organizerEmail } : {}),
      },
      provenance: 'gmail:t_invite',
    });

  const rowOf = (id: string) =>
    db.selectFrom('proposals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('a plain confirm sends an accepted reply, then records the event', async () => {
    const p = await stage('sharon@founder.example');

    const r = await confirmProposal(db, { id: p.id, resolvedByUserId: userId });

    expect(r.ok).toBe(true);
    const mail = sent.find((c) => c.url.includes('gmail'));
    expect(mail).toBeTruthy();
    const mime = decodeRaw(mail!.body!.raw!);
    expect(mime).toContain('METHOD:REPLY');
    expect(mime).toContain('PARTSTAT=ACCEPTED');
    expect(mime).toContain('To: sharon@founder.example');
    expect((await rowOf(p.id)).status).toBe('confirmed');
  });

  it('leaves the invitation pending when the organizer cannot be told', async () => {
    const p = await stage(); // no organizer on record, not on the calendar

    const r = await confirmProposal(db, { id: p.id, resolvedByUserId: userId });

    expect(r).toMatchObject({ ok: false, reason: 'exec_failed', message: 'no_organizer' });
    expect((await rowOf(p.id)).status).toBe('pending');
    expect(sent).toHaveLength(0);
  });

  it('does not reply twice when the RSVP route already answered', async () => {
    const p = await stage('sharon@founder.example');

    const r = await confirmProposal(db, {
      id: p.id,
      resolvedByUserId: userId,
      inviteAnswered: true,
    });

    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('marks an invitation so the email card asks Yes / Maybe / No', async () => {
    const p = await stage('sharon@founder.example');
    expect(suggestionFromProposal(await rowOf(p.id))).toMatchObject({
      kind: 'event',
      isInvite: true,
    });

    const plain = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Dentist', startsAt: start },
      provenance: 'gmail:t_plain',
    });
    expect(suggestionFromProposal(await rowOf(plain.id))?.isInvite).toBeUndefined();
  });
});
