/**
 * A non-invite (ADR 0175: PUBLISH/no-METHOD) `.ics` attached to a plain email
 * grounds the GENERAL magics extractor too (ADR 0177 generalized beyond the
 * trip classifier) — passed as deterministic context in the prompt, and used
 * as a year-anchor backstop against the extractor's own date guess.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import type { GmailRawMessage } from '@/services/google/gmail-sync.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  runEmailMagics,
  type EmailExtractor,
  type MagicThreadInput,
} from '@/services/email/magics.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// Same-day-next-year so the fixture never straddles a real year boundary in
// a way that would make `icsYear - 1` land on a date already past "today".
const future = new Date(Date.now() + 45 * 86_400_000);
const ICS_YEAR = future.getFullYear();
const MONTH_DAY = `${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
const at = (year: number): string => `${year}${MONTH_DAY.replace('-', '')}T180000`;

const ICS_UID = 'publish-ics-context-test@example.com';

const PUBLISH_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:PUBLISH',
  'BEGIN:VEVENT',
  `UID:${ICS_UID}`,
  'SUMMARY:Riverside Cabin Reservation',
  'LOCATION:Riverside Cabin, Big Bear',
  `DTSTART;TZID=America/New_York:${at(ICS_YEAR)}`,
  `DTEND;TZID=America/New_York:${at(ICS_YEAR)}`,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function publishIcsMessage(): GmailRawMessage {
  return {
    id: 'm_publish1',
    threadId: 't_publish1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Your cabin reservation is confirmed',
    internalDate: String(Date.now() - 3 * 86_400_000),
    historyId: '2',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Cabins Co <reservations@example.com>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: 'Your cabin reservation is confirmed' },
        { name: 'Message-ID', value: '<publish1@example.com>' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: {
            data: Buffer.from(
              `Thanks for booking! Your stay at the Riverside Cabin runs ${MONTH_DAY} — see the attached calendar file.`,
            ).toString('base64url'),
          },
        },
        {
          mimeType: 'text/calendar',
          body: { data: Buffer.from(PUBLISH_ICS, 'utf8').toString('base64url') },
        },
      ],
    },
  };
}

describe('non-invite .ics context grounds the general extractor (ADR 0177)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let capturedInput: MagicThreadInput | undefined;

  const wrongYearStubExtractor: EmailExtractor = {
    extract: async (input) => {
      capturedInput = input;
      // Same month/day as the .ics, one year EARLIER — a plausible
      // year-less-prose guess that lands in the past without correction.
      return {
        kind: 'event',
        title: 'Riverside Cabin stay',
        startsAt: `${ICS_YEAR - 1}-${MONTH_DAY}T18:00:00-04:00`,
      };
    },
  };

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    db = await openTestDb();
    userId = await createUser(db, 'cabin-user');
    await ensurePersonalGroup(db, userId);
    __addGmailMockMessage(userId, publishIcsMessage());
    await backfillGmail(db, userId);
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: 'cat_gen',
        user_id: userId,
        parent_id: null,
        title: 'Personal',
        depth: 0,
        sort_order: 0,
        updated_at: now,
      })
      .execute();
    await db
      .updateTable('email_threads')
      .set({ category_id: 'cat_gen', classified_at: now })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_publish1')
      .execute();
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  it('passes the parsed .ics as deterministic prompt context', async () => {
    await runEmailMagics(db, userId, { extractor: wrongYearStubExtractor });
    expect(capturedInput?.icsContext).toContain('Riverside Cabin Reservation');
    expect(capturedInput?.icsContext).toContain('Big Bear');
  });

  it("corrects the extractor's own wrong-year guess against the .ics anchor", async () => {
    const res = await runEmailMagics(db, userId, { extractor: wrongYearStubExtractor });
    expect(res.events).toBe(1);

    const p = await db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('provenance', '=', 'gmail:t_publish1')
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();
    const args = JSON.parse(p.args_json) as { startsAt: string };
    expect(args.startsAt.slice(0, 10)).toBe(`${ICS_YEAR}-${MONTH_DAY}`);
  });
});
