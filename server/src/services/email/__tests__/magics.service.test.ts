/**
 * ADR 0063 — email magics: LLM-extracted calendar/list suggestions staged as
 * proposals. Uses an injected stub extractor (no LLM) to test the plumbing:
 * proposal shape, provenance dedup, and the once-per-thread marker.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification, storageCategoryId as sid } from '@/services/email/classification.service.js';
import { createEvent } from '@/services/events.service.js';
import { createTask } from '@/services/tasks.service.js';
import { createTrip } from '@/services/trips.service.js';
import { __setOutlookMockMeeting, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { __addImapMockMessage, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import {
  parseSuggestions,
  pendingSuggestionsForThreads,
  listEmailDecisions,
  runEmailMagics,
  type EmailExtractor,
  type MagicThreadInput,
} from '@/services/email/magics.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal, rejectProposal } from '@/services/proposals.service.js';
import { stripFillerTail } from '@/services/event-convergence.service.js';
import { newId } from '@/utils/ids.js';

const parseSuggestion = (raw: string) => parseSuggestions(raw)[0] ?? null;
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * Fixture dates are relative (the ADR 0100 precedent, load-bearing again for
 * ADR 0137). A hardcoded future date silently becomes a PAST one, and a past
 * `startsAt` no longer stages a proposal at all - so the test would go green
 * having exercised nothing.
 */
const day = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const D_FLIGHT = day(20);
const D_MEETING = day(25);
const D_BAKE = day(27);
const D_RECITAL = day(30);
const D_ARCHIVED = day(33);
const D_RACE = day(40);
const D_SLIP = day(35);
/** `YYYY-MM-DD` + `HHMMSS` as an RFC 5545 UTC stamp. */
const icsStamp = (isoDay: string, hms: string): string => `${isoDay.replace(/-/g, '')}T${hms}Z`;

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(userId: string, gid: string, subject: string): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject,
      snippet: subject,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

// Deterministic stand-in for the LLM: routes by subject keyword.
const stub: EmailExtractor = {
  async extract(input) {
    if (/flight/i.test(input.subject)) {
      return { kind: 'event', title: 'Flight to SFO', startsAt: `${D_FLIGHT}T09:00:00-04:00` };
    }
    if (/grocery|buy/i.test(input.subject)) {
      return { kind: 'list', listName: 'Shopping', item: 'milk' };
    }
    return null;
  },
};

describe('parseSuggestion', () => {
  it('extracts JSON embedded in prose and narrows by kind', () => {
    expect(parseSuggestion('sure: {"kind":"list","listName":"Shopping","item":"eggs"} done')).toEqual({
      kind: 'list',
      listName: 'Shopping',
      item: 'eggs',
    });
    expect(parseSuggestion('{"kind":"none"}')).toBeNull();
    expect(parseSuggestion('not json')).toBeNull();
  });

  it('strips the filler tail so one to-do written twice is one item', () => {
    const bare = 'Decide whether to sell or use US Open tickets for Sun, Aug 30, 12:00 PM';
    const padded = `${bare} and take action accordingly`;
    expect(
      parseSuggestion(JSON.stringify({ kind: 'list', listName: 'To-dos', item: padded })),
    ).toEqual({ kind: 'list', listName: 'To-dos', item: bare });
  });
});

describe('stripFillerTail', () => {
  it('removes padding that says nothing the action does not', () => {
    for (const tail of [
      'and take action accordingly',
      'and act accordingly',
      'and respond accordingly.',
      'and follow up as appropriate',
      ', and reply accordingly',
    ]) {
      expect(stripFillerTail(`Renew the passport ${tail}`)).toBe('Renew the passport');
    }
  });

  it('leaves real content alone — a trailing clause with an object is not filler', () => {
    for (const item of [
      'buy milk and eggs',
      'Reply to Sarah and copy the coach',
      'Pay the deposit and book the room',
      'Sort the invoices accordingly', // no conjunction — not the pattern
    ]) {
      expect(stripFillerTail(item)).toBe(item);
    }
  });

  it('never empties an item', () => {
    expect(stripFillerTail('and act accordingly')).toBe('and act accordingly');
  });
});

describe('runEmailMagics — attached accounts (ADR 0080)', () => {
  beforeEach(() => {
    __resetOutlookMock();
    __resetImapMock();
    __resetGmailMock();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  });
  afterEach(() => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  });

  async function seedAccountThread(
    userId: string,
    opts: { bodyText: string; provider?: 'gmail' | 'outlook' | 'imap'; nativeMessageId?: string },
  ): Promise<{ accountId: string; gid: string }> {
    const now = new Date().toISOString();
    const accountId = newId('ema');
    await db
      .insertInto('email_accounts')
      .values({
        id: accountId,
        user_id: userId,
        provider: opts.provider ?? 'outlook',
        email_address: 'me@outlook.example',
        display_name: null,
        preset_key: null,
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        backfill_done: 1,
        status: 'ok',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const gid = `${accountId}:conv1`;
    const threadId = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        account_id: accountId,
        gmail_thread_id: gid,
        subject: 'Your flight itinerary',
        snippet: 'Flight details inside',
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
        account_id: accountId,
        thread_id: threadId,
        gmail_message_id: `${accountId}:${opts.nativeMessageId ?? 'm1'}`,
        gmail_thread_id: gid,
        from_name: null,
        from_email: 'airline@example.com',
        to_emails: JSON.stringify(['me@outlook.example']),
        cc_emails: JSON.stringify([]),
        subject: 'Your flight itinerary',
        snippet: 'Flight details inside',
        body_text: opts.bodyText,
        body_html: null,
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        rfc822_message_id: null,
        headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'travel', parentId: null, title: 'Travel', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'travel' }],
    });
    return { accountId, gid };
  }

  it('skips the gmail invite probe but still extracts (the 400-defer bug)', async () => {
    const userId = await createUser(db, 'magic-acct-user');
    const { gid } = await seedAccountThread(userId, { bodyText: 'Flight UA 512 departs Friday.' });

    // Pre-fix this deferred forever: the probe hit the GMAIL api with the
    // account-prefixed id and 400'd. Now it must extract like normal mail.
    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.events).toBe(1);

    const prop = await db
      .selectFrom('proposals')
      .select(['provenance', 'status'])
      .executeTakeFirstOrThrow();
    expect(prop.provenance).toBe(`gmail:${gid}`);
    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'magic')
      .executeTakeFirst();
    expect(mark?.gmail_thread_id).toBe(gid);
  });

  it('outlook meetingRequest stages a DETERMINISTIC proposal keyed on iCalUId', async () => {
    const userId = await createUser(db, 'magic-acct-meet');
    const { accountId, gid } = await seedAccountThread(userId, {
      bodyText: 'You are invited to Dentist.',
    });
    __setOutlookMockMeeting(accountId, 'm1', {
      meetingMessageType: 'meetingRequest',
      event: {
        iCalUId: 'uid-dentist-1',
        subject: 'Dentist',
        start: { dateTime: `${D_MEETING}T17:00:00.0000000`, timeZone: 'UTC' },
        end: { dateTime: `${D_MEETING}T18:00:00.0000000`, timeZone: 'UTC' },
        location: { displayName: 'Smile Dental' },
        isAllDay: false,
      },
    });

    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.events).toBe(1);
    const prop = await db
      .selectFrom('proposals')
      .select(['tool_name', 'args_json'])
      .executeTakeFirstOrThrow();
    expect(prop.tool_name).toBe('create_event');
    const args = JSON.parse(prop.args_json) as Record<string, unknown>;
    // Deterministic Graph facts, not the LLM stub's guess.
    expect(args.externalUid).toBe('uid-dentist-1');
    expect(args.title).toBe('Dentist');
    expect(String(args.startsAt)).toContain(`${D_MEETING}T17:00:00`);
    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'magic')
      .executeTakeFirst();
    expect(mark?.gmail_thread_id).toBe(gid);
  });

  it('outlook meetingRequest keeps the organizer, so the card can be answered by email', async () => {
    const userId = await createUser(db, 'magic-acct-organizer');
    const { accountId } = await seedAccountThread(userId, { bodyText: 'Neelabh has invited you to Call.' });
    __setOutlookMockMeeting(accountId, 'm1', {
      meetingMessageType: 'meetingRequest',
      event: {
        iCalUId: '040000008200E00074C5B7101A82E008-call',
        subject: 'Call',
        start: { dateTime: `${D_MEETING}T17:00:00.0000000`, timeZone: 'UTC' },
        end: { dateTime: `${D_MEETING}T17:30:00.0000000`, timeZone: 'UTC' },
        organizer: { emailAddress: { address: 'Neelabh@Partner.example', name: 'Neelabh' } },
      },
    });

    await runEmailMagics(db, userId, { extractor: stub });
    const prop = await db.selectFrom('proposals').select('args_json').executeTakeFirstOrThrow();
    const args = JSON.parse(prop.args_json) as Record<string, unknown>;
    expect(args.alreadyInGoogle).toBe(true);
    expect(args.organizerEmail).toBe('neelabh@partner.example');
  });

  it('outlook meetingCancelled marks handled and stages nothing', async () => {
    const userId = await createUser(db, 'magic-acct-cancel');
    const { accountId, gid } = await seedAccountThread(userId, {
      bodyText: 'Canceled: Dentist',
    });
    __setOutlookMockMeeting(accountId, 'm1', {
      meetingMessageType: 'meetingCancelled',
      event: { iCalUId: 'uid-dentist-1' },
    });

    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.events).toBe(0);
    expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(0);
    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'magic')
      .executeTakeFirst();
    expect(mark?.gmail_thread_id).toBe(gid);
  });

  it('imap: the .ics MIME part is parsed deterministically', async () => {
    const userId = await createUser(db, 'magic-acct-imap');
    const { accountId } = await seedAccountThread(userId, {
      bodyText: 'Lunch invitation attached',
      provider: 'imap',
      nativeMessageId: 'u200',
    });
    __addImapMockMessage(accountId, {
      uid: 200,
      flags: [],
      messageId: '<inv-200@cafe.example>',
      inReplyTo: null,
      references: null,
      subject: 'Your flight itinerary',
      fromName: null,
      fromEmail: 'cafe@example.com',
      toEmails: ['family@yahoo.example'],
      ccEmails: [],
      date: new Date().toISOString(),
      snippet: 'Lunch invitation attached',
      bodyText: 'Lunch invitation attached',
      bodyHtml: null,
      icsText: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:imap-lunch-1',
        `DTSTAMP:${icsStamp(D_MEETING, '000000')}`,
        `DTSTART:${icsStamp(D_MEETING, '190000')}`,
        `DTEND:${icsStamp(D_MEETING, '200000')}`,
        'SUMMARY:Team lunch',
        'LOCATION:Cafe',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    });

    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.events).toBe(1);
    const args = JSON.parse(
      (await db.selectFrom('proposals').select('args_json').executeTakeFirstOrThrow()).args_json,
    ) as Record<string, unknown>;
    expect(args.externalUid).toBe('imap-lunch-1');
    expect(args.title).toBe('Team lunch');
  });

  it('secondary gmail: probes through its own mailbox (text/calendar part)', async () => {
    const userId = await createUser(db, 'magic-acct-gm2');
    const { accountId } = await seedAccountThread(userId, {
      bodyText: 'Invitation: Piano recital',
      provider: 'gmail',
      nativeMessageId: 'm_inv1',
    });
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:gm2-recital-1',
      `DTSTAMP:${icsStamp(D_RECITAL, '000000')}`,
      `DTSTART:${icsStamp(D_RECITAL, '010000')}`,
      'SUMMARY:Piano recital',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    __addGmailMockMessage(accountId, {
      id: 'm_inv1',
      threadId: 'conv1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Invitation: Piano recital',
      internalDate: String(Date.now()),
      historyId: '5',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'school@example.com' },
          { name: 'Subject', value: 'Invitation: Piano recital' },
          { name: 'Message-ID', value: '<inv1@school.example>' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('see attached').toString('base64url') } },
          {
            mimeType: 'text/calendar',
            body: { data: Buffer.from(ics, 'utf8').toString('base64url') },
          },
        ],
      },
    });

    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.events).toBe(1);
    const args = JSON.parse(
      (await db.selectFrom('proposals').select('args_json').executeTakeFirstOrThrow()).args_json,
    ) as Record<string, unknown>;
    expect(args.externalUid).toBe('gm2-recital-1');
    expect(args.title).toBe('Piano recital');
  });
});

describe('runEmailMagics', () => {
  async function seedClassified(userId: string) {
    await seedThread(userId, 'g-flight', 'Your flight itinerary');
    await seedThread(userId, 'g-grocery', 'Time to buy groceries');
    await seedThread(userId, 'g-junk', 'Weekly newsletter');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [
        { id: 'travel', parentId: null, title: 'Travel', depth: 0 },
        { id: 'shop', parentId: null, title: 'Deliveries', depth: 0 },
        { id: 'news', parentId: null, title: 'Newsletters', depth: 0 },
      ],
      assignments: [
        { gmailThreadId: 'g-flight', categoryId: 'travel' },
        { gmailThreadId: 'g-grocery', categoryId: 'shop' },
        { gmailThreadId: 'g-junk', categoryId: 'news' },
      ],
    });
  }

  it('injects upcoming calendar / tasks / trips into the extractor (ADR 0088)', async () => {
    const userId = await createUser(db, 'magic-ctx-user');
    const personal = await ensurePersonalGroup(db, userId);
    await createEvent(db, {
      groupId: personal.id,
      title: 'October half marathon',
      startsAt: `${D_RACE}T14:00:00-07:00`,
      createdBy: userId,
    });
    await createEvent(db, {
      groupId: personal.id,
      title: 'Ancient concert',
      startsAt: '2020-01-01T15:00:00Z',
      createdBy: userId,
    });
    await createTask(db, {
      groupId: personal.id,
      title: 'Pack permission slip',
      createdBy: userId,
      dueAt: `${D_SLIP}T12:00:00-07:00`,
    });
    await createTrip(db, {
      groupId: personal.id,
      createdBy: userId,
      name: 'Boston',
      destination: 'Logan',
      startDate: day(20),
      endDate: day(23),
      participantIds: [userId],
    });
    await seedThread(userId, 'g-news', 'Race weekend tips');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      // Not Newsletters — ADR 0179 keeps a discretionary-broadcast thread out
      // of the pass entirely, so the extractor would never see the context.
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-news', categoryId: 'ff' }],
    });

    let seen: MagicThreadInput | undefined;
    await runEmailMagics(db, userId, {
      extractor: {
        async extract(input) {
          seen = input;
          return null;
        },
      },
    });
    expect(seen?.worldContext).toContain('October half marathon');
    expect(seen?.worldContext).toContain('Pack permission slip');
    expect(seen?.worldContext).toContain('Boston');
    expect(seen?.worldContext).not.toContain('Ancient concert');
    expect(seen?.worldContext).not.toContain(personal.id);
  });

  it('feeds KB-imported attachment text to the extractor (dates live in PDFs)', async () => {
    const userId = await createUser(db, 'magic-att-user');
    const threadId = await seedThread(userId, 'g-news', 'October newsletter');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'school', parentId: null, title: 'School notes', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-news', categoryId: 'school' }],
    });
    // The ADR 0071 knowledge-base copy, linked back to its source thread.
    await db
      .insertInto('attachments')
      .values({
        id: newId('att'),
        scope_kind: 'group',
        scope_id: 'g_personal_x',
        uploaded_by: userId,
        filename: 'newsletter.pdf',
        mime_type: 'application/pdf',
        size: 120,
        path: 'test/newsletter.pdf',
        summary: null,
        extracted_text: 'Picture day is October 12 at 9am in the gym.',
        image_meta: null,
        pinned: 0,
        indexed_at: null,
        origin_email_thread_id: threadId,
        created_at: new Date().toISOString(),
      })
      .execute();

    let seen: MagicThreadInput | undefined;
    const capture: EmailExtractor = {
      async extract(input) {
        seen = input;
        return null;
      },
    };
    await runEmailMagics(db, userId, { extractor: capture });
    expect(seen?.attachmentText).toContain('newsletter.pdf');
    expect(seen?.attachmentText).toContain('Picture day is October 12');
  });

  it('stages an event and a list proposal; a Newsletters thread never enters the pass', async () => {
    const userId = await createUser(db, 'magic-user');
    await seedClassified(userId);

    // ADR 0179 — g-junk is under Newsletters, so it is filtered out of the
    // query rather than run through the extractor and dropped as `none`.
    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res).toEqual({ events: 1, lists: 1, tasks: 0, trips: 0, cancellations: 0, routed: 0, processed: 2 });

    const props = await db
      .selectFrom('proposals')
      .select(['tool_name', 'args_json', 'provenance', 'status'])
      .orderBy('tool_name')
      .execute();
    expect(props).toHaveLength(2);

    const event = props.find((p) => p.tool_name === 'create_event')!;
    expect(event.status).toBe('pending');
    expect(event.provenance).toBe('gmail:g-flight');
    expect(JSON.parse(event.args_json)).toMatchObject({
      title: 'Flight to SFO',
      startsAt: `${D_FLIGHT}T09:00:00-04:00`,
    });

    const list = props.find((p) => p.tool_name === 'add_list_item')!;
    expect(list.provenance).toBe('gmail:g-grocery');
    expect(JSON.parse(list.args_json)).toEqual({ listName: 'Shopping', items: ['milk'] });

    // Every thread the pass PROCESSED carries a durable 'magic' mark (survives
    // mirror wipes). The Newsletters thread is deliberately left unmarked
    // (ADR 0143 / ADR 0179 — a policy change must be able to revisit it).
    const marks = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'magic')
      .execute();
    expect(marks.map((m) => m.gmail_thread_id).sort()).toEqual(['g-flight', 'g-grocery']);
  });

  it('is idempotent: a second pass processes nothing and adds no proposals', async () => {
    const userId = await createUser(db, 'magic-idem');
    await seedClassified(userId);
    await runEmailMagics(db, userId, { extractor: stub });

    const again = await runEmailMagics(db, userId, { extractor: stub });
    expect(again).toEqual({ events: 0, lists: 0, tasks: 0, trips: 0, cancellations: 0, routed: 0, processed: 0 });

    const count = await db
      .selectFrom('proposals')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(count!.n)).toBe(2);
  });

  it('only processes classified threads', async () => {
    const userId = await createUser(db, 'magic-unclassified');
    await seedThread(userId, 'g-x', 'Your flight itinerary'); // never classified
    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.processed).toBe(0);
  });

  /**
   * One Amex email, two bullets. `afterSync` fired once per connected mailbox,
   * so two passes mined the same thread 2.3s apart, and the model phrased one
   * obligation two ways — "Confirm income information WITH American Express"
   * and "…FOR American Express credit card". Exact normalized-title dedup
   * (ADR 0132) cannot catch a rephrase, and loosening it far enough to would
   * start merging genuinely different to-dos.
   *
   * A thread is staged from once (ADR 0243), so a proposal from a second pass
   * over the same thread is a duplicate by construction.
   */
  it('a thread mined twice with a reworded answer yields ONE proposal', async () => {
    const userId = await createUser(db, 'magic-reword');
    await seedThread(userId, 'g-amex', 'Confirm your income');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'fin', parentId: null, title: 'Finance', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-amex', categoryId: 'fin' }],
    });

    let call = 0;
    const rephrasing: EmailExtractor = {
      async extract() {
        call += 1;
        return {
          kind: 'task',
          title:
            call === 1
              ? 'Confirm income information with American Express'
              : 'Confirm income information for American Express credit card',
        };
      },
    };

    await runEmailMagics(db, userId, { extractor: rephrasing });
    // The extraction mark normally stops a re-mine; clear it to reproduce two
    // passes racing past each other's mark, which is what prod did.
    await db.deleteFrom('email_extraction_marks').where('user_id', '=', userId).execute();
    await runEmailMagics(db, userId, { extractor: rephrasing });

    const props = await db
      .selectFrom('proposals')
      .select(['args_json', 'provenance'])
      .where('tool_name', '=', 'create_task')
      .where('status', '=', 'pending')
      .execute();
    expect(props).toHaveLength(1);
    expect(props[0].provenance).toBe('gmail:g-amex');
    expect(JSON.parse(props[0].args_json)).toMatchObject({
      title: 'Confirm income information with American Express',
    });
  });

  /** A school bulletin: a form to return, a picture day, and things to bring. */
  const bulletin = (reworded = false): EmailExtractor => ({
    async extract() {
      return [
        {
          kind: 'task',
          title: reworded ? 'Return the signed permission slip' : 'Sign and return the permission slip',
          dueAt: `${D_SLIP}T17:00:00-04:00`,
        },
        { kind: 'event', title: 'Picture day', startsAt: `${D_BAKE}T09:00:00-04:00` },
        {
          kind: 'task',
          title: reworded ? 'Pay the yearbook fee online' : 'Pay the yearbook fee',
        },
        { kind: 'list', listName: 'Bake sale', item: 'cupcakes' },
        { kind: 'list', listName: 'Bake sale', item: 'napkins' },
      ];
    },
  });

  async function seedBulletin(username: string): Promise<string> {
    const userId = await createUser(db, username);
    await seedThread(userId, 'g-bulletin', 'Week 6 bulletin');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'school', parentId: null, title: 'School', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-bulletin', categoryId: 'school' }],
    });
    return userId;
  }

  const pendingFrom = (provenance: string) =>
    db
      .selectFrom('proposals')
      .select(['tool_name', 'args_json'])
      .where('provenance', '=', provenance)
      .where('status', '=', 'pending')
      .orderBy('created_at')
      .execute();

  it('stages every separate item an email holds, one list card per list (ADR 0243)', async () => {
    const userId = await seedBulletin('magic-multi');
    const res = await runEmailMagics(db, userId, { extractor: bulletin() });
    expect(res).toMatchObject({ tasks: 2, events: 1, lists: 1, processed: 1 });

    const props = await pendingFrom('gmail:g-bulletin');
    expect(props.map((p) => p.tool_name).sort()).toEqual([
      'add_list_item',
      'create_event',
      'create_task',
      'create_task',
    ]);
    const list = props.find((p) => p.tool_name === 'add_list_item')!;
    expect(JSON.parse(list.args_json)).toEqual({
      listName: 'Bake sale',
      items: ['cupcakes', 'napkins'],
    });
  });

  it('a re-mined multi-item thread adds nothing, however it is reworded (ADR 0243)', async () => {
    const userId = await seedBulletin('magic-multi-remine');
    await runEmailMagics(db, userId, { extractor: bulletin() });
    await db.deleteFrom('email_extraction_marks').where('user_id', '=', userId).execute();
    await runEmailMagics(db, userId, { extractor: bulletin(true) });

    const titles = (await pendingFrom('gmail:g-bulletin'))
      .filter((p) => p.tool_name === 'create_task')
      .map((p) => JSON.parse(p.args_json).title);
    expect(titles.sort()).toEqual(['Pay the yearbook fee', 'Sign and return the permission slip']);
  });

  it('keeps the first EMAIL_MAGICS_MAX_ITEMS cards and drops the rest', async () => {
    const userId = await seedBulletin('magic-multi-cap');
    const many: EmailExtractor = {
      async extract() {
        return ['one', 'two', 'three', 'four', 'five', 'six'].map((n) => ({
          kind: 'task' as const,
          title: `Return form ${n}`,
        }));
      },
    };
    const res = await runEmailMagics(db, userId, { extractor: many });
    expect(res.tasks).toBe(env.EMAIL_MAGICS_MAX_ITEMS);
    const titles = (await pendingFrom('gmail:g-bulletin')).map((p) => JSON.parse(p.args_json).title);
    expect(titles).toEqual(['Return form one', 'Return form two', 'Return form three', 'Return form four']);
  });

  it('a scam warning is never staged beside an action', async () => {
    const userId = await seedBulletin('magic-multi-advisory');
    const scam: EmailExtractor = {
      async extract() {
        return [
          { kind: 'task', title: 'Pay the overdue invoice' },
          { kind: 'advisory', note: 'This looks like a phishing attempt.' },
        ];
      },
    };
    await runEmailMagics(db, userId, { extractor: scam });
    expect(await pendingFrom('gmail:g-bulletin')).toHaveLength(0);
  });
});

describe('parseSuggestions (ADR 0243)', () => {
  it('reads every item of the envelope, in order, with list entries split out', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'task', title: 'Return the form', dueAt: '2026-11-06T17:00:00-05:00' },
        { kind: 'event', title: 'Picture day', startsAt: '2026-11-14T09:00:00-05:00' },
        { kind: 'list', listName: 'Bake sale', items: ['cupcakes', 'napkins'] },
      ],
      receipt: { amount: 12 },
    });
    expect(parseSuggestions(raw)).toEqual([
      { kind: 'task', title: 'Return the form', dueAt: '2026-11-06T17:00:00-05:00' },
      {
        kind: 'event',
        title: 'Picture day',
        startsAt: '2026-11-14T09:00:00-05:00',
        endsAt: undefined,
        location: undefined,
      },
      { kind: 'list', listName: 'Bake sale', item: 'cupcakes' },
      { kind: 'list', listName: 'Bake sale', item: 'napkins' },
    ]);
  });

  it('still reads a bare suggestion, and an empty envelope is nothing', () => {
    expect(parseSuggestions('{"kind":"task","title":"Renew the passport"}')).toEqual([
      { kind: 'task', title: 'Renew the passport' },
    ]);
    expect(parseSuggestions('{"kind":"list","listName":"Costco","items":["milk","eggs"]}')).toHaveLength(2);
    expect(parseSuggestions('{"items":[]}')).toEqual([]);
    expect(parseSuggestions('{"items":[{"kind":"none"}]}')).toEqual([]);
  });

  it('counts a list as one card against the cap, and an advisory stands alone', () => {
    const tasks = ['a', 'b', 'c'].map((t) => ({ kind: 'task', title: `Do ${t}` }));
    const capped = parseSuggestions(
      JSON.stringify({
        items: [{ kind: 'list', listName: 'Costco', items: ['milk', 'eggs', 'bread'] }, ...tasks],
      }),
      2,
    );
    expect(capped.map((s) => s.kind)).toEqual(['list', 'list', 'list', 'task']);
    expect(
      parseSuggestions(
        JSON.stringify({ items: [...tasks, { kind: 'advisory', note: 'Looks like phishing.' }] }),
      ),
    ).toEqual([{ kind: 'advisory', note: 'Looks like phishing.' }]);
  });
});

describe('pendingSuggestionsForThreads (ADR 0068)', () => {
  it('maps pending suggestions to thread row ids and drops resolved ones', async () => {
    const userId = await createUser(db, 'magic-lookup');
    await seedThread(userId, 'g-flight', 'Your flight itinerary');
    await seedThread(userId, 'g-grocery', 'Time to buy groceries');
    await seedThread(userId, 'g-junk', 'Weekly newsletter');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'all', parentId: null, title: 'All', depth: 0 }],
      assignments: [
        { gmailThreadId: 'g-flight', categoryId: 'all' },
        { gmailThreadId: 'g-grocery', categoryId: 'all' },
        { gmailThreadId: 'g-junk', categoryId: 'all' },
      ],
    });
    await runEmailMagics(db, userId, { extractor: stub });

    const rows = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .execute();
    const rowId = (gid: string) => rows.find((r) => r.gmail_thread_id === gid)!.id;

    const map = await pendingSuggestionsForThreads(db, userId, rows.map((r) => r.id));
    expect(map.get(rowId('g-flight'))).toEqual([
      expect.objectContaining({
        kind: 'event',
        title: 'Flight to SFO',
        detail: `${D_FLIGHT}T09:00:00-04:00`,
      }),
    ]);
    expect(map.get(rowId('g-grocery'))).toEqual([
      expect.objectContaining({ kind: 'list', title: 'milk', detail: 'Shopping' }),
    ]);
    expect(map.has(rowId('g-junk'))).toBe(false);

    // A rejected proposal stops surfacing.
    const flightMagic = map.get(rowId('g-flight'))![0];
    await rejectProposal(db, { id: flightMagic.proposalId, resolvedByUserId: userId });
    const after = await pendingSuggestionsForThreads(db, userId, rows.map((r) => r.id));
    expect(after.has(rowId('g-flight'))).toBe(false);
    expect(after.has(rowId('g-grocery'))).toBe(true);
  });

  it('ADR 0187: a CONFIRMED proposal keeps surfacing, marked "confirmed"', async () => {
    const userId = await createUser(db, 'magic-confirmed');
    await seedThread(userId, 'g-grocery-2', 'Time to buy groceries');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'all', parentId: null, title: 'All', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-grocery-2', categoryId: 'all' }],
    });
    await runEmailMagics(db, userId, { extractor: stub });

    const row = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 'g-grocery-2')
      .executeTakeFirstOrThrow();

    const before = await pendingSuggestionsForThreads(db, userId, [row.id]);
    const magic = before.get(row.id)![0];
    expect(magic.status).toBe('pending');

    await confirmProposal(db, { id: magic.proposalId, resolvedByUserId: userId });

    // Re-opening the thread still shows it — as already handled, not gone.
    const after = await pendingSuggestionsForThreads(db, userId, [row.id]);
    expect(after.get(row.id)).toEqual([
      expect.objectContaining({ proposalId: magic.proposalId, status: 'confirmed' }),
    ]);
  });
});

describe('group-label routing (owner-confirmed fan-out)', () => {
  it('ADR 0097: an unruled email is NOT routed by the model — it stays personal', async () => {
    const userId = await createUser(db, 'parent');
    // createGroup adds the creator as an owner-member.
    const school = await createGroup(db, { name: 'School', kind: 'group', createdBy: userId });

    await seedThread(userId, 'g-school', 'School bake sale next Friday');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-school', categoryId: 'ff' }],
    });

    const eventStub: EmailExtractor = {
      async extract() {
        return { kind: 'event', title: 'School bake sale', startsAt: `${D_BAKE}T09:00:00-04:00` };
      },
    };
    // A group literally named "School" for an email about a school bake sale is
    // the easiest possible match, and the model still does not get to make it.
    const res = await runEmailMagics(db, userId, { extractor: eventStub });
    expect(res).toMatchObject({ events: 1, routed: 0 });

    const prop = await db
      .selectFrom('proposals')
      .selectAll()
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();
    expect(prop.group_id).not.toBe(school.id);
    expect(prop.target_group_id).toBeNull();

    // A plain confirm keeps it personal — nothing reaches the shared group.
    const confirmed = await confirmProposal(db, { id: prop.id, resolvedByUserId: userId });
    expect(confirmed.ok).toBe(true);
    expect(
      await db
        .selectFrom('events')
        .select('id')
        .where('group_id', '=', school.id)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('ADR 0097: the owner can route it at confirm time, and that DOES fan out', async () => {
    const userId = await createUser(db, 'parent2');
    const school = await createGroup(db, { name: 'School', kind: 'group', createdBy: userId });

    await seedThread(userId, 'g-school2', 'School bake sale next Friday');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-school2', categoryId: 'ff' }],
    });
    await runEmailMagics(db, userId, {
      extractor: {
        async extract() {
          return { kind: 'event', title: 'Bake sale', startsAt: `${D_BAKE}T09:00:00-04:00` };
        },
      },
    });
    const prop = await db
      .selectFrom('proposals')
      .selectAll()
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();

    const confirmed = await confirmProposal(db, {
      id: prop.id,
      resolvedByUserId: userId,
      targetGroupId: school.id,
    });
    expect(confirmed.ok).toBe(true);

    const evt = await db
      .selectFrom('events')
      .select(['title', 'group_id'])
      .where('group_id', '=', school.id)
      .executeTakeFirst();
    expect(evt?.title).toBe('Bake sale');
  });

  it('ADR 0097: confirm-time routing is refused for a group the user is not in', async () => {
    const userId = await createUser(db, 'parent3');
    const stranger = await createUser(db, 'stranger');
    const theirs = await createGroup(db, { name: 'Theirs', kind: 'group', createdBy: stranger });

    await seedThread(userId, 'g-school3', 'Bake sale');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-school3', categoryId: 'ff' }],
    });
    await runEmailMagics(db, userId, {
      extractor: {
        async extract() {
          return { kind: 'event', title: 'Bake sale', startsAt: `${D_BAKE}T09:00:00-04:00` };
        },
      },
    });
    const prop = await db
      .selectFrom('proposals')
      .selectAll()
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();

    const res = await confirmProposal(db, {
      id: prop.id,
      resolvedByUserId: userId,
      targetGroupId: theirs.id,
    });
    expect(res.ok).toBe(false);
  });
});

describe('listEmailDecisions (ADR 0083)', () => {
  it('joins category, marks unclassified/archived as unsorted, parses dueAt, counts coverage', async () => {
    const userId = await createUser(db, 'decisions-user');
    const otherId = await createUser(db, 'decisions-other');
    const personal = await ensurePersonalGroup(db, userId);
    const otherPersonal = await ensurePersonalGroup(db, otherId);

    const classifiedId = await seedThread(userId, 'g-class', 'Recital Friday');
    const unclassifiedId = await seedThread(userId, 'g-unclass', 'Mystery email');
    const archivedId = await seedThread(userId, 'g-arch', 'Old archived ask');
    await db
      .updateTable('email_threads')
      .set({ is_archived: 1 })
      .where('id', '=', archivedId)
      .execute();
    // Unreadable coverage counts live unclassified threads.
    await seedThread(userId, 'g-unreadble', 'Still unclassified');

    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'school', parentId: null, title: 'School', depth: 0 }],
      assignments: [{ gmailThreadId: 'g-class', categoryId: 'school' }],
    });

    const startsAt = `${D_RECITAL}T15:00:00-07:00`;
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Recital', startsAt },
      provenance: 'gmail:g-class',
    });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'To-dos', items: ['Reply to mystery'] },
      provenance: 'gmail:g-unclass',
    });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Archived event', startsAt: `${D_ARCHIVED}T10:00:00-07:00` },
      provenance: 'gmail:g-arch',
    });
    // Another user's proposal must never appear.
    await createProposal(db, {
      groupId: otherPersonal.id,
      proposedByUserId: otherId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Other recital', startsAt },
      provenance: 'gmail:g-class',
    });

    const confirmed = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Already added', startsAt },
      provenance: 'gmail:g-class',
    });
    await confirmProposal(db, { id: confirmed.id, resolvedByUserId: userId });

    const res = await listEmailDecisions(db, userId);
    expect(res.decisions).toHaveLength(3);

    const school = res.decisions.find((d) => d.title === 'Recital')!;
    expect(school).toMatchObject({
      kind: 'event',
      // Stored ids are user-scoped (ADR 0106); the snapshot id stays bare.
      categoryId: sid(userId, 'school'),
      categoryTitle: 'School',
      threadRowId: classifiedId,
      dueAt: startsAt,
      archivedSource: false,
    });

    const unsorted = res.decisions.find((d) => d.title === 'Reply to mystery')!;
    expect(unsorted).toMatchObject({
      kind: 'list',
      categoryId: null,
      categoryTitle: null,
      threadRowId: unclassifiedId,
      dueAt: null,
      archivedSource: false,
    });

    const archived = res.decisions.find((d) => d.title === 'Archived event')!;
    expect(archived).toMatchObject({
      categoryId: null,
      archivedSource: true,
      threadRowId: archivedId,
    });

    expect(res.coverage.handledToday).toBe(1);
    expect(res.coverage.unreadable).toBeGreaterThanOrEqual(2); // g-unclass + g-unreadble
  });
});
