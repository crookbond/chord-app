/**
 * ADR 0244 addendum — two DIFFERENT emails with the same ask stage one card.
 *
 * The duplicate checks (`shouldStage*Proposal`) compare against other
 * threads' cards, but ran before the staging lock, and the lock was per
 * thread. Two passes reaching two emails at once (a confirmation and its
 * reminder; one message in two mailboxes) both read "no card yet" and both
 * staged. Events and list items were cleaned up later by the consolidation
 * sweeps; a to-do has no such sweep, so its twin stayed.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  runEmailMagics,
  runReadTimeEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb, urlForDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
/** A second connection: the test pool has one, which would serialize the
 *  two passes and hide the race. Two processes in prod each have their own. */
let other: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
  const pool = new Pool({ connectionString: urlForDb(name), max: 2 });
  pool.on('error', () => {});
  other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  userId = await createUser(db, 'cross-thread-user');
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  await other.destroy();
  await closeTestDb(db);
});

async function seedThread(opts: {
  gid: string;
  subject: string;
  body: string;
  at?: string;
}): Promise<string> {
  const at = opts.at ?? new Date().toISOString();
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: opts.gid,
      subject: opts.subject,
      snippet: opts.subject,
      from_email: 'office@school.example',
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${opts.gid}`,
      gmail_thread_id: opts.gid,
      from_email: 'office@school.example',
      subject: opts.subject,
      snippet: opts.subject,
      to_emails: JSON.stringify(['me@example.com']),
      cc_emails: JSON.stringify([]),
      body_text: opts.body,
      // '' = parsed, no invite: without it the ADR 0074 probe defers the thread.
      ics_text: '',
      internal_date: at,
      created_at: at,
    })
    .execute();
  return threadId;
}

const pendingCards = (toolName: string) =>
  db
    .selectFrom('proposals')
    .select(['id', 'provenance', 'args_json'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', toolName)
    .where('status', '=', 'pending')
    .execute();

/**
 * Holds every extraction until `n` have started, so both passes have their
 * model answer before either reaches the staging step: the timing two
 * processes (or the sweep and a thread open) hit in prod.
 */
function barrierExtractor(n: number, answer: Awaited<ReturnType<EmailExtractor['extract']>>): EmailExtractor {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return {
    async extract() {
      arrived += 1;
      if (arrived >= n) release();
      await all;
      return answer;
    },
  };
}

describe('cross-thread duplicate cards (ADR 0244 addendum)', () => {
  it('a confirmation and its reminder read at the same moment stage ONE to-do card', async () => {
    const a = await seedThread({
      gid: 't_slip_confirm',
      subject: 'Field trip permission slip',
      body: 'Please sign and return the permission slip.',
    });
    const b = await seedThread({
      gid: 't_slip_reminder',
      subject: 'Reminder: Field trip permission slip',
      body: 'Reminder - please sign and return the permission slip.',
    });
    const extractor = barrierExtractor(2, { kind: 'task', title: 'Return the permission slip' });

    await Promise.all([
      runReadTimeEmailMagics(db, userId, a, { extractor }),
      runReadTimeEmailMagics(other, userId, b, { extractor }),
    ]);

    expect(await pendingCards('create_task')).toHaveLength(1);
  });

  it('the same holds for an event card and a list entry', async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) + 'T18:00:00Z';
    const a = await seedThread({ gid: 't_ev_a', subject: 'Spring concert', body: 'Concert at 6pm.' });
    const b = await seedThread({ gid: 't_ev_b', subject: 'Spring concert', body: 'Concert at 6pm.' });
    const events = barrierExtractor(2, { kind: 'event', title: 'Spring concert', startsAt });
    await Promise.all([
      runReadTimeEmailMagics(db, userId, a, { extractor: events }),
      runReadTimeEmailMagics(other, userId, b, { extractor: events }),
    ]);
    expect(await pendingCards('create_event')).toHaveLength(1);

    const c = await seedThread({ gid: 't_li_a', subject: 'Bake sale', body: 'Bring cupcakes.' });
    const d = await seedThread({ gid: 't_li_b', subject: 'Bake sale reminder', body: 'Bring cupcakes.' });
    const lists = barrierExtractor(2, { kind: 'list', listName: 'Groceries', item: 'Cupcakes' });
    await Promise.all([
      runReadTimeEmailMagics(db, userId, c, { extractor: lists }),
      runReadTimeEmailMagics(other, userId, d, { extractor: lists }),
    ]);
    expect(await pendingCards('add_list_item')).toHaveLength(1);
  });

  it('a different to-do from the other email still stages', async () => {
    const a = await seedThread({ gid: 't_x', subject: 'Slip', body: 'Return the slip.' });
    const b = await seedThread({ gid: 't_y', subject: 'Fees', body: 'Pay the trip fee.' });
    const answers = ['Return the permission slip', 'Pay the field trip fee'];
    let i = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    const extractor: EmailExtractor = {
      async extract() {
        const title = answers[i++]!;
        if (i >= 2) release();
        await all;
        return { kind: 'task', title };
      },
    };
    await Promise.all([
      runReadTimeEmailMagics(db, userId, a, { extractor }),
      runReadTimeEmailMagics(other, userId, b, { extractor }),
    ]);
    expect(await pendingCards('create_task')).toHaveLength(2);
  });
});

describe('one "someone must be home" card per parcel (ADR 0244 addendum)', () => {
  let priorProvider: string;
  beforeEach(() => {
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(() => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
  });

  const inDays = (n: number): string =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it('the shipped notice and the out-for-delivery notice for one package stage one card, at the newest ETA', async () => {
    const tracking = '1Z999AA10123456784';
    const earlier = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const later = new Date(Date.now() - 3_600_000).toISOString();
    await seedThread({
      gid: 't_shipped',
      subject: 'Your order has shipped',
      body: `Tracking ${tracking}. Adult signature required on delivery.`,
      at: earlier,
    });
    await seedThread({
      gid: 't_out',
      subject: 'Out for delivery today - signature required',
      body: `Your UPS package ${tracking} is out for delivery. Someone must sign.`,
      at: later,
    });
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:del', parentId: null, title: 'Deliveries', depth: 0 }],
      assignments: [
        { gmailThreadId: 't_shipped', categoryId: 'c:del' },
        { gmailThreadId: 't_out', categoryId: 'c:del' },
      ],
    });
    const eta: Record<string, string> = { t_shipped: inDays(4), t_out: inDays(2) };
    const extractor: EmailExtractor = {
      async extract(input) {
        const gid = input.subject.startsWith('Out') ? 't_out' : 't_shipped';
        input.onDelivery?.({ etaAt: eta[gid]!, needsPresence: true });
        return null;
      },
    };

    await runEmailMagics(db, userId, { extractor });

    const cards = await pendingCards('create_event');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.provenance).toBe('gmail:t_out');
    expect((JSON.parse(cards[0]!.args_json) as { startsAt: string }).startsAt).toContain(inDays(2));
  });

  it('two different parcels keep a card each', async () => {
    await seedThread({ gid: 't_p1', subject: 'Your desk lamp is on its way', body: 'Tracking 1Z999AA10123456784. Signature required.' });
    await seedThread({ gid: 't_p2', subject: 'Rug order update', body: 'Tracking 1Z12345E0205271688. Signature required.' });
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:del', parentId: null, title: 'Deliveries', depth: 0 }],
      assignments: [
        { gmailThreadId: 't_p1', categoryId: 'c:del' },
        { gmailThreadId: 't_p2', categoryId: 'c:del' },
      ],
    });
    const extractor: EmailExtractor = {
      async extract(input) {
        input.onDelivery?.({ etaAt: inDays(3), needsPresence: true });
        return null;
      },
    };
    await runEmailMagics(db, userId, { extractor });
    expect(await pendingCards('create_event')).toHaveLength(2);
  });
});
