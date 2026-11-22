/**
 * The bulk-mail deny-list (ADR 0127).
 *
 * The rule exists twice — once in TypeScript for the reasoning, once in SQL
 * for the passes — so the last describe block pins them against one table of
 * cases. Two copies of a predicate is how ADR 0085's promise stopped being
 * true once before.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { isMinable, minablePredicate, type BulkGateInputs } from '@/services/email/bulk-gate.js';

/** The stored column's union, so the fixture inserts what the schema allows. */
type StoredAction = 'to_do' | 'reply_needed' | 'informational' | 'other' | null;
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

const BLAST: BulkGateInputs = {
  bulk: true,
  bulkInferred: true,
  action: 'informational',
  senderKnown: false,
};

/** `count` messages from `from` in their own thread; read or not. */
async function priorMail(from: string, count: number, read: boolean): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const at = new Date(Date.now() - (n + 2) * 86_400_000).toISOString();
    const tid = newId('et');
    const gt = newId('gt');
    await db
      .insertInto('email_threads')
      .values({ id: tid, user_id: userId, gmail_thread_id: gt, subject: 'older', from_email: from, last_message_at: at, created_at: at, updated_at: at })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: tid,
        gmail_thread_id: gt,
        gmail_message_id: newId('gm'),
        from_email: from,
        to_emails: JSON.stringify(['alice@example.com']),
        subject: 'older',
        snippet: '',
        is_unread: read ? 0 : 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        internal_date: at,
        created_at: at,
      })
      .execute();
  }
}

async function thread(i: BulkGateInputs, from = 'news@list.example'): Promise<string> {
  if (i.senderIgnored) await priorMail(from, 3, false);
  const now = new Date().toISOString();
  const id = newId('et');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: newId('gt'),
      subject: 'x',
      from_email: from,
      bulk: i.bulk ? 1 : 0,
      bulk_inferred: i.bulkInferred ? 1 : 0,
      action: i.action as StoredAction,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

/** Does the SQL half admit this thread? */
async function sqlMinable(threadId: string): Promise<boolean> {
  const row = await db
    .selectFrom('email_threads')
    .select('id')
    .where('id', '=', threadId)
    .where(minablePredicate(userId, { prefix: 'email_threads.' }))
    .executeTakeFirst();
  return row !== undefined;
}

beforeEach(async () => {
  (env as { EMAIL_BULK_GATE: boolean }).EMAIL_BULK_GATE = true;
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  (env as { EMAIL_BULK_GATE: boolean }).EMAIL_BULK_GATE = true;
  await closeTestDb(db);
});

describe('what the gate skips', () => {
  it('skips a blast both signals agree about', () => {
    expect(isMinable(BLAST)).toBe(false);
  });

  it('mines when only the header says bulk', () => {
    // ADR 0109: the header is a signal, never a verdict, and nothing demotes
    // on it alone. Two independent signals agreeing is not "alone".
    expect(isMinable({ ...BLAST, bulkInferred: false })).toBe(true);
  });

  it('mines when only the classifier says bulk', () => {
    expect(isMinable({ ...BLAST, bulk: false })).toBe(true);
  });

  it('mines ordinary mail', () => {
    expect(isMinable({ bulk: false, bulkInferred: false, action: 'other', senderKnown: false })).toBe(
      true,
    );
  });
});

describe('what outranks the gate', () => {
  it('mines a blast that wants something from you', () => {
    // ADR 0086's axis overrides the gate everywhere — 0109's own rule.
    for (const action of ['to_do', 'reply_needed']) {
      expect(isMinable({ ...BLAST, action })).toBe(true);
    }
  });

  it('mines anything from someone in your people', () => {
    expect(isMinable({ ...BLAST, senderKnown: true })).toBe(true);
  });

  it('mines Events & invites, whatever the headers say', () => {
    // Evite and Eventbrite are bulk by construction and are exactly what
    // ADR 0088 wanted kept.
    expect(isMinable({ ...BLAST, categoryTitle: 'Events & invites' })).toBe(true);
    expect(isMinable({ ...BLAST, categoryTitle: 'events & INVITES' })).toBe(true);
  });

  it('mines everything when the flag is off', () => {
    (env as { EMAIL_BULK_GATE: boolean }).EMAIL_BULK_GATE = false;

    expect(isMinable(BLAST)).toBe(true);
  });
});

describe('the address-book exemption in SQL', () => {
  it('matches a people row on the sender address, case-insensitively', async () => {
    const id = await thread(BLAST, 'Coach@Team.example');
    expect(await sqlMinable(id)).toBe(false);

    await db
      .insertInto('people')
      .values({
        id: newId('pp'),
        owner_user_id: userId,
        display_name: 'Coach',
        email: 'coach@team.example',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    expect(await sqlMinable(id)).toBe(true);
  });

  it('never matches another user’s people row', async () => {
    const other = await createUser(db, 'bob');
    const id = await thread(BLAST, 'coach@team.example');
    await db
      .insertInto('people')
      .values({
        id: newId('pp'),
        owner_user_id: other,
        display_name: 'Coach',
        email: 'coach@team.example',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    expect(await sqlMinable(id)).toBe(false);
  });
});

// Prod, 29 Oct: USPS Informed Delivery and retail lists carried the header
// but the classifier was unsure, so the two-signal rule mined them. A sender
// the user never opens or writes to is the second signal.
describe('a sender the user ignores', () => {
  const INFORMED = 'uspsinformeddelivery@email.informeddelivery.usps.com';
  const HEADER_ONLY: BulkGateInputs = { ...BLAST, bulkInferred: false };

  it('skips its mass mail on one bulk signal', async () => {
    expect(isMinable({ ...HEADER_ONLY, senderIgnored: true })).toBe(false);
    expect(await sqlMinable(await thread({ ...HEADER_ONLY, senderIgnored: true }, INFORMED))).toBe(false);
  });

  it('still mines it when the email asks something of the user', async () => {
    expect(isMinable({ ...HEADER_ONLY, senderIgnored: true, action: 'to_do' })).toBe(true);
    expect(await sqlMinable(await thread({ ...HEADER_ONLY, senderIgnored: true, action: 'to_do' }, INFORMED))).toBe(true);
  });

  it('is not ignored once the user has opened one of its emails', async () => {
    await priorMail(INFORMED, 3, false);
    await priorMail(INFORMED, 1, true);
    expect(await sqlMinable(await thread(HEADER_ONLY, INFORMED))).toBe(true);
  });

  it('is not ignored when the user has written to it', async () => {
    await priorMail('help@shop.example', 3, false);
    const at = new Date().toISOString();
    const tid = newId('et');
    await db
      .insertInto('email_threads')
      .values({ id: tid, user_id: userId, gmail_thread_id: 'sent-1', subject: 're', from_email: 'alice@example.com', last_message_at: at, created_at: at, updated_at: at })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'), user_id: userId, thread_id: tid, gmail_thread_id: 'sent-1', gmail_message_id: newId('gm'),
        from_email: 'alice@example.com', to_emails: JSON.stringify(['Help@Shop.example']), subject: 're', snippet: '',
        is_unread: 0, gmail_label_ids: JSON.stringify(['SENT']), internal_date: at, created_at: at,
      })
      .execute();
    expect(await sqlMinable(await thread(HEADER_ONLY, 'help@shop.example'))).toBe(true);
  });

  it('needs three emails: one or two unopened is a sender not got to yet', async () => {
    await priorMail('new@school.example', 1, false);
    expect(await sqlMinable(await thread(HEADER_ONLY, 'new@school.example'))).toBe(true);
  });

  it('never applies to mail with no bulk signal at all', async () => {
    const plain: BulkGateInputs = { bulk: false, bulkInferred: false, action: 'informational', senderKnown: false, senderIgnored: true };
    expect(isMinable(plain)).toBe(true);
    expect(await sqlMinable(await thread(plain, 'statements@bank.example'))).toBe(true);
  });
});

describe('the two halves agree', () => {
  const CASES: BulkGateInputs[] = [];
  for (const bulk of [true, false]) {
    for (const bulkInferred of [true, false]) {
      const actions: StoredAction[] = ['to_do', 'reply_needed', 'informational', 'other', null];
      for (const action of actions) {
        for (const senderIgnored of [false, true]) {
          CASES.push({ bulk, bulkInferred, action, senderKnown: false, senderIgnored });
        }
      }
    }
  }

  it('returns the same verdict for every combination', async () => {
    let n = 0;
    for (const c of CASES) {
      // Each case its own sender, so one case's earlier mail is not another's.
      const id = await thread(c, `list${(n += 1)}@list.example`);

      expect({ ...c, sql: await sqlMinable(id) }).toEqual({ ...c, sql: isMinable(c) });
    }
  });

  it('both halves open up completely when the flag is off', async () => {
    const id = await thread(BLAST);
    expect(await sqlMinable(id)).toBe(false);

    (env as { EMAIL_BULK_GATE: boolean }).EMAIL_BULK_GATE = false;

    expect(await sqlMinable(id)).toBe(true);
    expect(isMinable(BLAST)).toBe(true);
  });
});
