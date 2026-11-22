/**
 * ADR 0157 — inviting someone to an event.
 *
 * `create_event` / `update_event` take `invitees` (email OR name). Emails and
 * names that resolve (the asker's saved people, then their Chord contacts)
 * are added to the event on the user's calendar, which sends the invitation
 * (ADR 0295: guests live there, not in Chord).
 * A name with no email on file does NOT block the write — it comes back in
 * `unresolvedInvitees` with a "pick from Contacts" card.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import { SSE, type DeviceContactLookupRequest, type DeviceContactLookupResponse } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { answerDeviceContactLookup } from '@/services/bot/device-contact-lookup.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createPerson } from '@/services/people.service.js';
import {
  listPendingInvitees,
} from '@/services/bot/pending-invites.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('create_event / update_event invitees (ADR 0157)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let google: FakeGoogleCalendar;
  /** Stands in for the asker's phone (ADR 0212); null = no app listening. */
  let phone: ((req: DeviceContactLookupRequest) => DeviceContactLookupResponse) | null;
  let lookups: Array<{ channel: string; req: DeviceContactLookupRequest }>;
  const timeouts = env as { CONTACT_LOOKUP_TIMEOUT_MS: number };
  const savedTimeout = env.CONTACT_LOOKUP_TIMEOUT_MS;

  const emit = (channel: string, event: string, data: unknown) => {
    if (event !== SSE.contactLookup) return;
    const req = data as DeviceContactLookupRequest;
    lookups.push({ channel, req });
    const answer = phone;
    if (answer) setTimeout(() => answerDeviceContactLookup(userId, req.requestId, answer(req)), 5);
  };

  const soon = (): string => {
    const d = new Date(Date.now() + 5 * 86400000);
    return `${d.toISOString().slice(0, 10)}T19:00:00+00:00`;
  };

  const create = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      tzOffset: '+00:00',
      emit,
      call: { name: 'create_event', args },
    });

  const update = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-2',
      tzOffset: '+00:00',
      emit,
      call: { name: 'update_event', args },
    });

  const attendeesOf = async (title: string): Promise<string[]> => {
    await settleBackgroundWork();
    const ev = await db
      .selectFrom('events')
      .select('gcal_event_id')
      .where('group_id', '=', groupId)
      .where('title', '=', title)
      .executeTakeFirstOrThrow();
    return ev.gcal_event_id ? google.guests(ev.gcal_event_id) : [];
  };

  beforeEach(async () => {
    phone = null;
    lookups = [];
    timeouts.CONTACT_LOOKUP_TIMEOUT_MS = 300;
    db = await openTestDb();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'ro',
        display_name: 'Ro',
        created_at: now,
        shadow: 0,
        refresh_token_scopes: 'https://www.googleapis.com/auth/calendar',
      })
      .execute();
    google = installFakeGoogleCalendar();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Fam',
        kind: 'group',
        invite_code: 'XINV1',
        ingest_email: 'fam-inv@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    timeouts.CONTACT_LOOKUP_TIMEOUT_MS = savedTimeout;
    await closeTestDb(db);
  });

  describe("names the server can't place are looked up on the asker's phone (ADR 0157 addendum)", () => {
    // Reported: Contacts allowed, "invite Karl Dale" still answered
    // "still need an email for Karl Dale" — resolveInvitees never asked the phone.
    it('invites the one phone contact that matches, in a shared chat, asking only that user', async () => {
      phone = (req) =>
        req.query === 'Karl Dale'
          ? { status: 'found', matches: [{ name: 'Karl Dale', emails: ['karl@media.example'], phones: [] }] }
          : { status: 'not_found', matches: [] };
      const res = await create({ title: 'Dinner', startsAt: soon(), invitees: ['Karl Dale'] });

      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.channel).toBe(groupId);
      expect(lookups[0]!.req.forUserId).toBe(userId);
      expect(res.data).toMatchObject({ invited: ['karl@media.example'], unresolvedInvitees: [] });
      expect(res.cards).toBeUndefined();
      expect(res.summary).toContain("Karl Dale <karl@media.example> (from the phone's contacts)");
      expect(await attendeesOf('Dinner')).toEqual(['karl@media.example']);
    });

    it('asks which one when several phone contacts fit, and invites nobody', async () => {
      phone = () => ({
        status: 'found',
        matches: [
          { name: 'Karl Dale', emails: ['k@a.test'], phones: [] },
          { name: 'Karl Mehta', emails: ['k@b.test'], phones: [] },
        ],
      });
      const res = await create({ title: 'Brunch', startsAt: soon(), invitees: ['Karl'] });
      expect(res.data).toMatchObject({ invited: [], unresolvedInvitees: ['Karl'] });
      expect(res.summary).toMatch(/several phone contacts match "Karl".*ask which one/);
      expect(await attendeesOf('Brunch')).toEqual([]);
    });

    it('update_event resolves an added name the same way', async () => {
      await create({ title: 'Squash', startsAt: soon() });
      phone = () => ({ status: 'found', matches: [{ name: 'Milo Rao', emails: ['milo@x.test'], phones: [] }] });
      const res = await update({ titleContains: 'Squash', invitees: ['Milo'] });
      expect(res.data).toMatchObject({ updated: true, invited: ['milo@x.test'] });
      expect(await attendeesOf('Squash')).toEqual(['milo@x.test']);
    });

    it('a saved person is used without asking the phone', async () => {
      await createPerson(db, { ownerUserId: userId, displayName: 'Priya', email: 'priya@fam.test' });
      await create({ title: 'Tea', startsAt: soon(), invitees: ['Priya'] });
      expect(lookups).toEqual([]);
    });

    it('does not ask a phone for a turn from WhatsApp', async () => {
      const res = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        turnId: 'turn-wa',
        tzOffset: '+00:00',
        emit,
        sourceBinding: { platform: 'whatsapp' } as never,
        call: { name: 'create_event', args: { title: 'Call', startsAt: soon(), invitees: ['Karl'] } },
      });
      expect(lookups).toEqual([]);
      expect(res.data).toMatchObject({ unresolvedInvitees: ['Karl'] });
    });
  });

  it('records an explicit email as a guest and reports it invited', async () => {
    const res = await create({
      title: 'Meeting with Kevin',
      startsAt: soon(),
      invitees: ['Guest.teSt@gmail.com'],
    });
    expect(res.data).toMatchObject({ invited: ['guest.test@gmail.com'], unresolvedInvitees: [] });
    expect(res.cards ?? []).toHaveLength(0);
    expect(await attendeesOf('Meeting with Kevin')).toEqual(['guest.test@gmail.com']);
  });

  it('resolves a name against the asker’s saved people', async () => {
    await createPerson(db, { ownerUserId: userId, displayName: 'Priya', email: 'priya@fam.test' });
    const res = await create({ title: 'Lunch', startsAt: soon(), invitees: ['priya'] });
    expect(res.data).toMatchObject({ invited: ['priya@fam.test'], unresolvedInvitees: [] });
    expect(await attendeesOf('Lunch')).toEqual(['priya@fam.test']);
  });

  it('still creates the event for an unknown name, with a contact card', async () => {
    const res = await create({
      title: 'Coffee',
      startsAt: soon(),
      invitees: ['Someone Unknown'],
    });
    // Event exists.
    expect(await attendeesOf('Coffee')).toEqual([]);
    expect(res.data).toMatchObject({ invited: [], unresolvedInvitees: ['Someone Unknown'] });
    expect(res.cards).toEqual([
      expect.objectContaining({ kind: 'contact', contactName: 'Someone Unknown' }),
    ]);
    // The summary must not read as if the person was invited.
    expect(res.summary).toMatch(/still need an email/i);
  });

  it('handles a mix of resolved and unresolved invitees', async () => {
    const res = await create({
      title: 'Standup',
      startsAt: soon(),
      invitees: ['ok@x.test', 'Mystery Person'],
    });
    expect(res.data).toMatchObject({
      invited: ['ok@x.test'],
      unresolvedInvitees: ['Mystery Person'],
    });
    expect(res.cards).toHaveLength(1);
    expect(await attendeesOf('Standup')).toEqual(['ok@x.test']);
  });

  it('update_event adds a guest to an existing event (invitees-only call is valid)', async () => {
    await create({ title: 'Review', startsAt: soon() });
    const res = await update({ titleContains: 'Review', invitees: ['late@x.test'] });
    expect(res.data).toMatchObject({ updated: true, invited: ['late@x.test'] });
    expect(await attendeesOf('Review')).toEqual(['late@x.test']);
  });

  // ADR 0317 — "add google meet" puts a Meet link on the Google event.
  it('update_event videoCall adds a Google Meet link and reports it', async () => {
    await create({ title: 'Call with Karl', startsAt: soon(), invitees: ['karl@media.example'] });
    const res = await update({ titleContains: 'Call with Karl', videoCall: true });
    expect(res.data).toMatchObject({ updated: true });
    expect(res.summary).toMatch(/added a Google Meet link: https:\/\/meet\.google\.com\//);
    const patch = google.patches().find((p) => p.body?.conferenceData);
    expect(patch?.url).toContain('conferenceDataVersion=1');
    expect(patch?.url).toContain('sendUpdates=all');
  });

  it('create_event videoCall adds the link in the same call', async () => {
    const res = await create({ title: 'Sync', startsAt: soon(), videoCall: true });
    expect(res.summary).toMatch(/added a Google Meet link/);
    const again = await update({ titleContains: 'Sync', videoCall: true });
    expect(again.summary).toMatch(/already has a Google Meet link/);
  });

  it('does not claim a link when the event is on no connected calendar', async () => {
    await db.updateTable('users').set({ refresh_token_scopes: null }).where('id', '=', userId).execute();
    const res = await create({ title: 'Offline chat', startsAt: soon(), videoCall: true });
    // ADR 0323 reworded this: the refusal no longer names Google, since which
    // kind was wanted is the calendar's to say and there is no calendar here.
    expect(res.summary).toMatch(/NO video call link was added/);
    expect(res.summary).toMatch(/not on a connected calendar/);
  });

  it('does not double-add the same email', async () => {
    await create({ title: 'Kickoff', startsAt: soon(), invitees: ['dup@x.test'] });
    const res = await update({ titleContains: 'Kickoff', invitees: ['DUP@x.test'] });
    expect(res.data).toMatchObject({ invited: [] });
    expect(await attendeesOf('Kickoff')).toEqual(['dup@x.test']);
  });

  // ADR 0166 — a create_event/update_event whose invitees include an
  // unresolved name leaves a structural reminder (not just chat prose) that
  // survives to a later turn, so a plain "their email is x@y.com" reply can
  // still resolve it even when the model doesn't recall its own sentence.
  describe('pending-invite memory (ADR 0166)', () => {
    it('records an unresolved invitee and clears it once update_event resolves it', async () => {
      await create({
        title: 'Meet Karl',
        startsAt: soon(),
        invitees: ['Karl Dale'],
      });
      expect(await listPendingInvitees(db, groupId, userId)).toEqual([
        expect.objectContaining({ name: 'Karl Dale', eventTitle: 'Meet Karl' }),
      ]);

      const updateRes = await update({
        titleContains: 'Meet Karl',
        invitees: ['karl@media.example'],
      });
      expect(updateRes.data).toMatchObject({ invited: ['karl@media.example'] });
      expect(await listPendingInvitees(db, groupId, userId)).toEqual([]);
      expect(await attendeesOf('Meet Karl')).toEqual(['karl@media.example']);
    });

    it('leaves other groups and users untouched', async () => {
      await create({ title: 'Solo Event', startsAt: soon(), invitees: ['Nobody Known'] });
      expect(await listPendingInvitees(db, newId('g'), userId)).toEqual([]);
      expect(await listPendingInvitees(db, groupId, newId('u'))).toEqual([]);
      expect(await listPendingInvitees(db, groupId, userId)).toHaveLength(1);
    });

    it('does not record anything when the call has no invitees at all', async () => {
      await create({ title: 'Plain Event', startsAt: soon() });
      expect(await listPendingInvitees(db, groupId, userId)).toEqual([]);
    });
  });
});
