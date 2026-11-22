/**
 * An invitation is answered with its own Yes / Maybe / No card (ADR 0104),
 * and nothing else. Prod 2026-11-10: Mark Clark invited the user to a
 * Thursday 10:30 call; the user's own "Accepted:" reply was read as ordinary
 * mail, the model staged "Introductory Meeting with Mark Clark" with Mark
 * as guest, and confirming it put a second event on the calendar and sent
 * Mark an invitation to his own meeting.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runReadTimeEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
const COMPACT = DAY.replace(/-/g, '');
const MARK = 'mark.clark@postoakgroup.example';
const ME = 'john@neuralads.example';

function ics(method: string): string {
  return [
    'BEGIN:VCALENDAR',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:uid-mark-intro',
    'SUMMARY:John Doe: Introductory Meeting',
    `DTSTART:${COMPACT}T153000Z`,
    `DTEND:${COMPACT}T160000Z`,
    `ORGANIZER:mailto:${MARK}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/** What the model did in prod: the meeting, with the other side invited. */
const meetingGuess: EmailExtractor = {
  async extract() {
    return [
      {
        kind: 'event',
        title: 'Introductory Meeting with Mark Clark',
        startsAt: `${DAY}T10:30:00-05:00`,
        endsAt: `${DAY}T11:00:00-05:00`,
        invite: 'sender',
      },
      { kind: 'task', title: 'Accept the meeting invite from Mark' },
    ];
  },
};

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'invite-thread');
  await ensurePersonalGroup(db, userId);
  await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
});
afterEach(async () => {
  await closeTestDb(db);
});

type Msg = { from: string; to: string; body: string; ics: string; labels: string[]; minutesAgo: number };

async function seedThread(messages: Msg[]): Promise<string> {
  const now = Date.now();
  const gid = `gt-${newId('x')}`;
  const threadId = newId('emt');
  const newest = messages[messages.length - 1]!;
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      account_id: null,
      gmail_thread_id: gid,
      subject: 'Accepted: John Doe: Introductory Meeting',
      snippet: newest.body.slice(0, 80),
      from_email: newest.from,
      from_name: null,
      last_message_at: new Date(now - newest.minutesAgo * 60_000).toISOString(),
      is_unread: 0,
      is_archived: 0,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .execute();
  for (const [i, m] of messages.entries()) {
    const at = new Date(now - m.minutesAgo * 60_000).toISOString();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        account_id: null,
        thread_id: threadId,
        gmail_message_id: `${gid}-m${i}`,
        gmail_thread_id: gid,
        from_name: null,
        from_email: m.from,
        to_emails: JSON.stringify([m.to]),
        cc_emails: JSON.stringify([]),
        subject: 'John Doe: Introductory Meeting',
        snippet: m.body.slice(0, 80),
        body_text: m.body,
        body_html: null,
        internal_date: at,
        is_unread: 0,
        gmail_label_ids: JSON.stringify(m.labels),
        rfc822_message_id: null,
        headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
        ics_text: m.ics,
        created_at: at,
      })
      .execute();
  }
  return threadId;
}

async function cards() {
  const rows = await db.selectFrom('proposals').select(['tool_name', 'args_json']).execute();
  return rows.map((r) => ({ tool: r.tool_name, args: JSON.parse(r.args_json) as Record<string, unknown> }));
}

describe('an invitation is the only card its thread gets', () => {
  it("the user's own Accepted reply stages nothing", async () => {
    const threadId = await seedThread([
      {
        from: ME,
        to: MARK,
        body: 'John Doe has accepted this invitation. Thursday 10:30am - 11am (Eastern Time)',
        ics: ics('REPLY'),
        labels: ['SENT'],
        minutesAgo: 5,
      },
    ]);

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: meetingGuess });

    expect(await cards()).toEqual([]);
  });

  it('a plain follow-up under an invitation gets no model event and no invitations', async () => {
    const threadId = await seedThread([
      {
        from: MARK,
        to: ME,
        body: 'Mark Clark has invited you to Introductory Meeting, Thursday 10:30am.',
        ics: ics('REQUEST'),
        labels: ['INBOX'],
        minutesAgo: 60,
      },
      {
        from: MARK,
        to: ME,
        body: 'Looking forward to Thursday - agenda attached.',
        ics: '',
        labels: ['INBOX'],
        minutesAgo: 5,
      },
    ]);

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: meetingGuess });

    const staged = await cards();
    expect(staged.filter((c) => c.tool === 'create_event' && !c.args.externalUid)).toEqual([]);
    expect(staged.some((c) => Array.isArray(c.args.invitees))).toBe(false);
    expect(staged.filter((c) => c.tool === 'create_task')).toEqual([]);
  });
});
