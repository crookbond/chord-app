/**
 * ADR 0248 — an email can change something the user already has.
 *
 * Built on the real email that prompted it: New York Athletic Club, "You have
 * successfully cancelled out of a reservation ... Court: Singles 3 / Squash
 * Singles ... 05:30 PM to 06:15 PM". Dates are relative (two days out) so the
 * tests cannot rot into a past slot, which is deliberately ignored.
 *
 * The extractor is a stub that does what the model is asked to do: read the
 * labelled block it was given and name a label. So these tests run through
 * the real labelling, and a label the block did not show cannot be named.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { applyEmailChanges } from '@/services/email/email-changes.service.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  formatLabelledWorld,
  loadThreadEvents,
  loadWorldContext,
  type ChangeTarget,
} from '@/services/email/magics-context.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import {
  capSuggestions,
  parseSuggestions,
  pendingSuggestionsForThreads,
  runEmailMagics,
  type ChangeSuggestion,
  type EmailExtractor,
  type EmailSuggestion,
  type MagicThreadInput,
} from '@/services/email/magics.service.js';
import { withEmailStagingLocks } from '@/services/event-convergence.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal, rejectProposal } from '@/services/proposals.service.js';
import { createTask } from '@/services/tasks.service.js';
import { instantMs } from '@/db/text-instant.js';
import { offsetForLocalDatetime } from '@/utils/tz.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb, urlForDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

const TZ = 'America/New_York';
const NYAC = 'reservations@nyac.org';
const CANCEL_BODY = `Hello John Doe,

You have successfully cancelled out of a reservation made via the New York Athletic Club reservation system.

Reservation details:
Court: Singles 3 / Squash Singles
Date: Friday, October 16th 2026
Time: 05:30 PM to 06:15 PM

This is an automatically generated email, please do not reply to it.`;

/** A local New York wall time `days` from now, with that date's offset. */
function nyAt(days: number, hhmm: string): string {
  const ymd = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const local = `${ymd}T${hhmm}:00`;
  return `${local}${offsetForLocalDatetime(TZ, local)}`;
}
const SLOT_START = nyAt(2, '17:30');
const SLOT_END = nyAt(2, '18:15');

let db: Kysely<DB>;
let userId: string;
let personalId: string;
let priorGmailProvider: string;

beforeEach(async () => {
  // The pass checks the mailbox for a calendar invite before reading a
  // message; the mock mailbox answers that the way Gmail does.
  __resetGmailMock();
  priorGmailProvider = env.GMAIL_PROVIDER;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
});
afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorGmailProvider;
  await closeTestDb(db);
});

async function seedEmail(gid: string, subject: string, fromEmail: string, body: string, fromName = 'New York Athletic Club') {
  const id = newId('emt');
  const messageId = newId('gm');
  const now = new Date().toISOString();
  __addGmailMockMessage(userId, {
    id: messageId,
    threadId: gid,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: subject,
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: fromEmail },
        { name: 'Subject', value: subject },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  });
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject,
      snippet: subject,
      from_email: fromEmail,
      from_name: fromName,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_thread_id: gid,
      gmail_message_id: messageId,
      subject,
      snippet: subject,
      from_email: fromEmail,
      from_name: fromName,
      body_excerpt: body,
      // '' = checked at sync, no invite attached (ADR 0080). Null would mean
      // "never checked" and send the pass to the mailbox for it.
      ics_text: '',
      to_emails: JSON.stringify(['john@example.com']),
      cc_emails: JSON.stringify([]),
      internal_date: now,
      created_at: now,
    })
    .execute();
  return id;
}

async function classify(gids: string[]) {
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: 'clubs', parentId: null, title: 'Sports & clubs', depth: 0 }],
    assignments: gids.map((g) => ({ gmailThreadId: g, categoryId: 'clubs' })),
  });
}

/** The label the block gave a line matching `line`, as the model would read it. */
function labelOf(input: MagicThreadInput, line: RegExp): string | null {
  for (const l of (input.worldContext ?? '').split('\n')) {
    const m = /^- ([etp]\d+) (.*)$/.exec(l);
    if (m && line.test(m[2])) return m[1];
  }
  return null;
}

/** A stub that answers the email whose subject matches, by finding its line. */
function changingStub(
  subject: RegExp,
  line: RegExp,
  change: Omit<ChangeSuggestion, 'kind' | 'target'>,
  extra: EmailSuggestion[] = [],
): EmailExtractor & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async extract(input) {
      if (!subject.test(input.subject)) return null;
      seen.push(input.worldContext ?? '');
      const target = labelOf(input, line);
      return target ? [{ kind: 'change', target, ...change }, ...extra] : extra;
    },
  };
}

const proposalsOf = (tool: string) =>
  db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'status', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', tool)
    .orderBy('created_at', 'asc')
    .execute();

const notices = () =>
  db.selectFrom('proactive_messages').select(['payload']).where('kind', '=', 'email_change_notice').execute();

async function bookedSquash(gid = 'g-book', title = 'Squash Singles 3') {
  await seedEmail(gid, 'Reservation confirmed', NYAC, 'Your squash court is booked.');
  return createEvent(db, {
    groupId: personalId,
    title,
    startsAt: SLOT_START,
    endsAt: SLOT_END,
    createdBy: userId,
    sourceRawContext: `gmail:${gid}`,
  });
}

async function runOn(gid: string, subject: string, body: string, extractor: EmailExtractor, from = NYAC) {
  const threadId = await seedEmail(gid, subject, from, body);
  await classify([gid]);
  await runEmailMagics(db, userId, { extractor });
  return threadId;
}

describe('the model reply', () => {
  it('parses a change by label, drops a made-up shape, and keeps changes beside the capped adds', () => {
    const reply = JSON.stringify({
      items: [
        { kind: 'change', target: 'e2', action: 'remove', why: 'reservation cancelled' },
        { kind: 'change', target: 'squash', action: 'remove' },
        { kind: 'change', target: 'e3', action: 'explode' },
        { kind: 'list', listName: 'Squash', items: ['towel'] },
      ],
    });
    expect(parseSuggestions(reply)).toEqual([
      { kind: 'change', target: 'e2', action: 'remove', why: 'reservation cancelled' },
      { kind: 'list', listName: 'Squash', item: 'towel' },
    ]);
    const capped = capSuggestions(
      [
        { kind: 'task', title: 'A' },
        { kind: 'task', title: 'B' },
        { kind: 'change', target: 't1', action: 'done' },
        { kind: 'change', target: 't1', action: 'drop' },
      ],
      1,
    );
    expect(capped.map((s) => s.kind)).toEqual(['change', 'task']);
    // A message that looks like a scam changes nothing.
    expect(
      capSuggestions([
        { kind: 'change', target: 'e1', action: 'remove' },
        { kind: 'advisory', note: 'Looks like phishing' },
      ]).map((s) => s.kind),
    ).toEqual(['advisory']);
  });
});

describe('an email that changes something you have (ADR 0248)', () => {
  it('cancel: a removal card for the booked event, nothing new, no chat note; confirming removes it and its to-do', async () => {
    const ev = await bookedSquash();
    await createTask(db, { groupId: personalId, title: 'Bring squash racquet', createdBy: userId, sourceRawContext: 'gmail:g-book' });
    const stub = changingStub(/cancel/i, /^calendar: Squash Singles 3/, { action: 'remove', why: 'reservation cancelled' });
    const cancelThreadId = await runOn('g-cancel', 'Reservation cancelled', CANCEL_BODY, stub);

    expect(stub.seen[0]).toMatch(/^- e1 calendar: Squash Singles 3 - /m);
    expect(await proposalsOf('create_event')).toHaveLength(0);
    const cards = await proposalsOf('delete_event');
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0].args_json)).toMatchObject({ eventId: ev.id, eventTitle: 'Squash Singles 3' });
    expect(cards[0].provenance).toBe('gmail:g-cancel');

    // The card is the whole answer: no chat line repeating it (prod, Luma).
    expect(await notices()).toHaveLength(0);

    const dock = await pendingSuggestionsForThreads(db, userId, [cancelThreadId]);
    expect(dock.get(cancelThreadId)?.map((s) => [s.kind, s.title, s.changeNote])).toEqual([
      ['change', 'Remove from calendar: Squash Singles 3', 'reservation cancelled'],
    ]);

    expect((await confirmProposal(db, { id: cards[0].id, resolvedByUserId: userId })).ok).toBe(true);
    const left = await db.selectFrom('events').select('id').where('id', '=', ev.id).where('deleted_at', 'is', null).execute();
    expect(left).toHaveLength(0);
    const todo = await db.selectFrom('tasks').select('status').where('title', '=', 'Bring squash racquet').executeTakeFirstOrThrow();
    expect(todo.status).toBe('archived');
  });

  it('reschedule: a move card at the new time keeping the length; confirming moves the event; the list beside it still stages', async () => {
    const ev = await bookedSquash();
    const newStart = nyAt(3, '09:00');
    const stub = changingStub(/moved/i, /^calendar: Squash Singles 3/, { action: 'move', startsAt: newStart, why: 'moved to Saturday' }, [
      { kind: 'list', listName: 'Squash', item: 'towel' },
    ]);
    await runOn('g-move', 'Your reservation was moved', 'Your court moved to Saturday 9:00 AM. Please bring a towel.', stub);

    const [card] = await proposalsOf('update_event');
    const args = JSON.parse(card.args_json) as { eventId: string; startsAt: string; endsAt: string };
    expect(args.eventId).toBe(ev.id);
    expect(instantMs(args.startsAt)).toBe(instantMs(newStart));
    expect(instantMs(args.endsAt) - instantMs(args.startsAt)).toBe(45 * 60_000);
    expect(await proposalsOf('add_list_item')).toHaveLength(1);

    expect((await confirmProposal(db, { id: card.id, resolvedByUserId: userId })).ok).toBe(true);
    const row = await db.selectFrom('events').select('starts_at').where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(instantMs(row.starts_at)).toBe(instantMs(newStart));
  });

  it('payment received: a mark-done card for the bill to-do; confirming completes it', async () => {
    const task = await createTask(db, { groupId: personalId, title: 'Pay Con Ed bill', createdBy: userId });
    const stub = changingStub(/payment/i, /^to-do: Pay Con Ed bill/, { action: 'done', why: 'payment received' });
    await runOn('g-paid', 'We received your payment', 'Thank you, your payment of $84.20 was received.', stub, 'billing@coned.com');

    const [card] = await proposalsOf('complete_task');
    expect(JSON.parse(card.args_json)).toMatchObject({ taskId: task.id, taskTitle: 'Pay Con Ed bill' });
    expect((await confirmProposal(db, { id: card.id, resolvedByUserId: userId })).ok).toBe(true);
    const row = await db.selectFrom('tasks').select('status').where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('done');
  });

  it('a suggestion not yet accepted: cancelled is withdrawn; moved is offered again at the new time under its own email', async () => {
    await seedEmail('g-book', 'Reservation confirmed', NYAC, 'Your squash court is booked.');
    await createProposal(db, {
      groupId: personalId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Squash Singles', startsAt: SLOT_START, endsAt: SLOT_END },
      provenance: 'gmail:g-book',
    });
    const newStart = nyAt(3, '09:00');
    const stub = changingStub(/moved/i, /^suggested event .*Squash Singles/, { action: 'move', startsAt: newStart });
    await runOn('g-move', 'Your reservation was moved', 'Moved to Saturday 9:00 AM.', stub);

    const adds = await proposalsOf('create_event');
    expect(adds.map((p) => p.status)).toEqual(['expired', 'pending']);
    expect(adds[1].provenance).toBe('gmail:g-book');
    const moved = JSON.parse(adds[1].args_json) as { startsAt: string; endsAt: string };
    expect(instantMs(moved.startsAt)).toBe(instantMs(newStart));
    expect(instantMs(moved.endsAt) - instantMs(moved.startsAt)).toBe(45 * 60_000);

    // And a cancellation of the moved one takes it back.
    const cancel = changingStub(/cancel/i, /^suggested event .*Squash Singles/, { action: 'remove' });
    await runOn('g-cancel', 'Reservation cancelled', CANCEL_BODY, cancel);
    expect((await proposalsOf('create_event')).map((p) => p.status)).toEqual(['expired', 'expired']);
  });

  it('stages nothing for a made-up label, an action that does not fit, or a new time already past', async () => {
    const ev = await bookedSquash();
    const targets = formatLabelledWorld(await loadWorldContext(db, userId, { tz: TZ }), TZ).targets;
    const base = {
      userId,
      personalGroupId: personalId,
      userTz: TZ,
      provenance: 'gmail:g-x',
      targets,
    };
    const out = await applyEmailChanges(db, {
      ...base,
      changes: [
        { kind: 'change', target: 'e9', action: 'remove' },
        { kind: 'change', target: 'e1', action: 'done' },
        { kind: 'change', target: 'e1', action: 'move', startsAt: nyAt(-1, '09:00') },
      ],
    });
    expect(out.skipped.map((s) => s.reason)).toEqual(['unknown_label', 'wrong_action', 'past']);
    expect(out.staged).toBe(0);
    expect(await proposalsOf('delete_event')).toHaveLength(0);
    expect(await proposalsOf('update_event')).toHaveLength(0);
    expect(await notices()).toHaveLength(0);

    // The event itself already over (ended yesterday): nothing either. One
    // that started earlier but has not ended is still on and can change.
    await db
      .updateTable('events')
      .set({ starts_at: nyAt(-1, '17:30'), ends_at: nyAt(-1, '18:15') })
      .where('id', '=', ev.id)
      .execute();
    const late = await applyEmailChanges(db, { ...base, changes: [{ kind: 'change', target: 'e1', action: 'remove' }] });
    expect(late.skipped.map((s) => s.reason)).toEqual(['past']);
  });

  it('removes only the cancelled occurrence of a weekly booking', async () => {
    await seedEmail('g-book', 'Weekly squash', NYAC, 'Your weekly court');
    await createEvent(db, {
      groupId: personalId,
      title: 'Squash Singles 3',
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      createdBy: userId,
      sourceRawContext: 'gmail:g-book',
      repeat: { rrule: 'FREQ=WEEKLY', tz: TZ },
    });
    const stub = changingStub(/cancel/i, /^calendar: Squash Singles 3/, { action: 'remove' });
    await runOn('g-cancel', 'Reservation cancelled', CANCEL_BODY, stub);
    const cards = await proposalsOf('delete_event');
    expect(cards).toHaveLength(1);
    const args = JSON.parse(cards[0].args_json) as { eventId: string; scope?: string };
    expect(args.scope).toBe('this');

    expect((await confirmProposal(db, { id: cards[0].id, resolvedByUserId: userId })).ok).toBe(true);
    const live = await db
      .selectFrom('events')
      .select('id')
      .where('owner_user_id', '=', userId)
      .where('title', '=', 'Squash Singles 3')
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`series_id is not null`)
      .execute();
    expect(live.length).toBeGreaterThan(0);
    expect(live.some((r) => r.id === args.eventId)).toBe(false);
  });

  it('acts once per item: a second read stages no second card, and a dismissed card is not offered again', async () => {
    await bookedSquash();
    const targets = formatLabelledWorld(await loadWorldContext(db, userId, { tz: TZ }), TZ).targets;
    const args = {
      userId,
      personalGroupId: personalId,
      userTz: TZ,
      provenance: 'gmail:g-cancel',
      changes: [{ kind: 'change' as const, target: 'e1', action: 'remove' as const }],
      targets,
    };
    await applyEmailChanges(db, args);
    const again = await applyEmailChanges(db, args);
    expect(again.skipped.map((s) => s.reason)).toEqual(['card_exists']);
    expect(await proposalsOf('delete_event')).toHaveLength(1);

    const [card] = await proposalsOf('delete_event');
    await rejectProposal(db, { id: card.id, resolvedByUserId: userId });
    const third = await applyEmailChanges(db, args);
    expect(third.skipped.map((s) => s.reason)).toEqual(['card_exists']);
  });

  it('two emails cancelling the same booking at once stage one card (ADR 0244 addendum)', async () => {
    // The club's cancellation and its follow-up arrive together; the passes
    // reading them each held only their own thread's lock, so both read "no
    // card for this event yet" and both staged a removal card.
    await bookedSquash();
    const targets = formatLabelledWorld(await loadWorldContext(db, userId, { tz: TZ }), TZ).targets;
    const base = {
      userId,
      personalGroupId: personalId,
      userTz: TZ,
      changes: [{ kind: 'change' as const, target: 'e1', action: 'remove' as const }],
      targets,
    };
    // A second connection: the test pool has one, which would serialize the
    // two passes and hide the race.
    const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
    const pool = new Pool({ connectionString: urlForDb(name), max: 2 });
    pool.on('error', () => {});
    const other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    try {
      // The first pass holds its transaction open (card written, not yet
      // committed) until the second has either finished or is seen waiting
      // on a lock: the moment two processes overlap in prod.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let wrote = false;
      const first = withEmailStagingLocks(db, userId, 'gmail:g-cancel', async (trx) => {
        const out = await applyEmailChanges(trx, { ...base, provenance: 'gmail:g-cancel' });
        wrote = true;
        await held;
        return out;
      });
      await waitFor(() => wrote);
      let secondDone = false;
      const second = withEmailStagingLocks(other, userId, 'gmail:g-cancel-followup', (trx) =>
        applyEmailChanges(trx, { ...base, provenance: 'gmail:g-cancel-followup' }),
      ).finally(() => (secondDone = true));
      await waitFor(async () => {
        if (secondDone) return true;
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (
            SELECT oid FROM pg_database WHERE datname = current_database())`.execute(other);
        return r.rows[0]!.n > 0;
      });
      release();
      await Promise.all([first, second]);
    } finally {
      await other.destroy();
    }
    expect(await proposalsOf('delete_event')).toHaveLength(1);
  });
});

describe('a change that changes nothing (prod, 2026-10-23)', () => {
  // Sean Mitra's email about the Hillcrest/Lakeside Gr 7 trivia night
  // produced "moved to Fri, Oct 23 at 4:00 PM" three times, with three Apply
  // cards. Every copy was already at 4:00 PM, and two of the three were the
  // school's subscribed feed (once via Google, once via the phone), which
  // cannot be edited here.
  const TRIVIA_AT = nyAt(2, '16:00');
  const TRIVIA_END = nyAt(2, '18:00');
  const IMPORT_CAL = '85hdsmattb1vjvo8et17gspnkhr30ujk@import.calendar.google.com';
  const PHONE_FEED = '64EF5A14-4F41-4CFF-952F-9D22439B4AE8';

  async function triviaCopies() {
    await upsertCalendarSource(db, userId, {
      provider: 'google',
      googleCalendarId: IMPORT_CAL,
      summary: 'School',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await upsertCalendarSource(db, userId, {
      provider: 'device',
      googleCalendarId: PHONE_FEED,
      summary: 'Untitled Calendar',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    const chordMade = await createEvent(db, {
      groupId: personalId,
      title: 'Hillcrest/Lakeside Grade 7 MSA Trivia Night',
      startsAt: TRIVIA_AT,
      endsAt: TRIVIA_END,
      createdBy: userId,
      sourceRawContext: 'gmail:1a0f8f1d17214282',
    });
    const pulled = async (extra: Record<string, string | null>) => {
      const id = newId('e');
      const now = new Date().toISOString();
      await db
        .insertInto('events')
        .values({
          id,
          group_id: personalId,
          group_ids: '[]',
          owner_user_id: userId,
          organizer_user_id: userId,
          role: 'attendee',
          title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night',
          // The shapes prod stored: "…Z" from Google, "….000Z" from the phone.
          starts_at: new Date(instantMs(TRIVIA_AT)).toISOString(),
          ends_at: new Date(instantMs(TRIVIA_END)).toISOString(),
          created_by: userId,
          created_at: now,
          updated_at: now,
          ical_uid: newId('u'),
          gcal_sync_status: 'skipped',
          ...extra,
        })
        .execute();
      return id;
    };
    const viaGoogle = await pulled({ google_calendar_id: IMPORT_CAL, gcal_event_id: '_c8qmcc3660om6bb' });
    const viaPhone = await pulled({ external_uid: `device:${PHONE_FEED}:F0A9F5C8-C7F3-454D-89BC-D3E7388C0007` });
    const targets = new Map<string, ChangeTarget>([
      ['e1', { kind: 'event', id: viaGoogle, seriesId: null, title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night', at: TRIVIA_AT }],
      ['e2', { kind: 'event', id: viaPhone, seriesId: null, title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night', at: TRIVIA_AT }],
      ['e3', { kind: 'event', id: chordMade.id, seriesId: null, title: chordMade.title, at: TRIVIA_AT }],
    ]);
    return { targets, chordMade };
  }

  const base = (targets: Map<string, ChangeTarget>) => ({
    userId,
    personalGroupId: personalId,
    userTz: TZ,
    provenance: 'gmail:ema_0Qie2eIiBwCf:1a16a280abf697b9',
    targets,
  });

  it('stages nothing and says nothing when every copy is already at that time', async () => {
    const { targets } = await triviaCopies();
    const out = await applyEmailChanges(db, {
      ...base(targets),
      changes: ['e1', 'e2', 'e3'].map((target) => ({
        kind: 'change' as const,
        target,
        action: 'move' as const,
        startsAt: TRIVIA_AT,
      })),
    });
    expect(out.staged).toBe(0);
    expect(out.skipped.map((s) => s.reason)).toEqual(['read_only', 'read_only', 'unchanged']);
    expect(await proposalsOf('update_event')).toHaveLength(0);
    expect(await notices()).toHaveLength(0);
  });

  it('a real move cards only the copy that can be edited', async () => {
    const { targets, chordMade } = await triviaCopies();
    const later = nyAt(2, '18:30');
    await applyEmailChanges(db, {
      ...base(targets),
      changes: ['e1', 'e2', 'e3'].map((target) => ({
        kind: 'change' as const,
        target,
        action: 'move' as const,
        startsAt: later,
      })),
    });
    const cards = await proposalsOf('update_event');
    expect(cards.map((c) => JSON.parse(c.args_json).eventId)).toEqual([chordMade.id]);
  });

  it('a to-do moved to the due date it already has is left alone', async () => {
    const due = nyAt(4, '17:00');
    const task = await createTask(db, { groupId: personalId, title: 'Return trivia RSVP', dueAt: due, createdBy: userId });
    const out = await applyEmailChanges(db, {
      ...base(new Map([['t1', { kind: 'task', id: task.id, title: task.title, dueAt: due }]])),
      changes: [{ kind: 'change', target: 't1', action: 'move', dueAt: due }],
    });
    expect(out.skipped.map((s) => s.reason)).toEqual(['unchanged']);
    expect(await notices()).toHaveLength(0);
  });
});

describe('what the model is shown', () => {
  it('labels real rows, hides this email’s own suggestion, and adds an event on a day the email names that the batch list cut', async () => {
    const far = nyAt(70, '10:00');
    const dentist = await createEvent(db, { groupId: personalId, title: 'Dentist', startsAt: far, createdBy: userId });
    await createTask(db, { groupId: personalId, title: 'Pay Con Ed bill', createdBy: userId });
    await createProposal(db, {
      groupId: personalId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Own suggestion', startsAt: SLOT_START },
      provenance: 'gmail:g-self',
    });
    const world = await loadWorldContext(db, userId, { tz: TZ });
    expect(world.events.map((e) => e.title)).not.toContain('Dentist');

    const farDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' }).format(
      new Date(instantMs(far)),
    );
    const extra = await loadThreadEvents(db, userId, {
      text: `Your appointment on ${farDay} has been cancelled.`,
      fromEmail: 'office@dentist.com',
      tz: TZ,
      exclude: new Set(),
    });
    expect(extra.map((e) => e.title)).toEqual(['Dentist']);

    const { block, targets } = formatLabelledWorld(world, TZ, { extraEvents: extra, excludeProvenance: 'gmail:g-self' });
    expect(block).toMatch(/^- e1 calendar: Dentist - /m);
    expect(block).toMatch(/^- t1 to-do: Pay Con Ed bill$/m);
    expect(block).not.toMatch(/Own suggestion/);
    expect(targets.get('e1')).toMatchObject({ kind: 'event', id: dentist.id, title: 'Dentist' });
    for (const t of targets.values()) expect(block).not.toContain(t.id);
  });
});
