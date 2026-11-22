/**
 * ADR 0135 — a shipping update says WHEN, and links to the carrier.
 *
 * Reported: "half the emails have 'arriving on this day' — we should show
 * that", against a tile that rendered the word "shipped" and a to-do that said
 * "track this".
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  parseDelivery,
  runEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { buildStateFact, dropLandedRows } from '@/services/email/tile-facts.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('parseDelivery', () => {
  it('takes the date the email stated', () => {
    expect(parseDelivery('{"kind":"none","delivery":{"etaAt":"2026-09-03","needsPresence":false}}'))
      .toEqual({ etaAt: '2026-09-03', needsPresence: false });
  });

  it('drops a date it cannot parse rather than rendering a wrong day', () => {
    // Beside an email that states the right one, a wrong day is worse than none.
    expect(parseDelivery('{"delivery":{"etaAt":"sometime next week"}}')).toBeNull();
    expect(parseDelivery('{"delivery":{"etaAt":""}}')).toBeNull();
  });

  it('keeps a presence flag even with no date, and ignores mail with neither', () => {
    expect(parseDelivery('{"delivery":{"needsPresence":true}}')).toEqual({
      etaAt: null,
      needsPresence: true,
    });
    expect(parseDelivery('{"kind":"none"}')).toBeNull();
    expect(parseDelivery('not json')).toBeNull();
  });
});

describe('state facts carry the arrival', () => {
  it('builds the carrier link from carrier + number', () => {
    const fact = buildStateFact('REI order', 'shipped', 't1', {
      etaAt: '2026-09-03',
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
    });
    expect(fact.etaAt).toBe('2026-09-03');
    expect(fact.tracking?.url).toContain('ups.com/track');
  });

  it('offers no link when only half the pair is known', () => {
    const fact = buildStateFact('Parcel', 'shipped', 't2', { etaAt: null, carrier: 'UPS' });
    // Absent, not null: a fact we learned nothing extra about keeps the shape
    // it had before this ADR.
    expect(fact.tracking).toBeUndefined();
    expect(fact.etaAt).toBeUndefined();
  });

  it('drops a parcel once its day has gone, and keeps undated ones', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    const kept = dropLandedRows(
      [
        buildStateFact('Arrived', 'shipped', 'a', { etaAt: '2026-09-03T12:00:00Z' }),
        buildStateFact('Coming', 'shipped', 'b', { etaAt: '2026-09-09T12:00:00Z' }),
        // Nothing tells us this one is over, so it stays.
        buildStateFact('Undated', 'shipped', 'c', null),
      ],
      now,
    );
    expect(kept.map((k) => k.title)).toEqual(['Coming', 'Undated']);
  });
});

describe('runEmailMagics — deliveries', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'delivery');
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const seed = async (gid: string, subject: string, body: string): Promise<void> => {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: 'ship@store.example',
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
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: body,
        // '' = parsed, no invite: without it the ADR 0074 probe defers the thread.
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:del', parentId: null, title: 'Deliveries', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:del' }],
    });
  };

  /** Answers like the real extractor: a delivery block, suggestion "none". */
  const stubFor = (etaAt: string, needsPresence: boolean): EmailExtractor => ({
    async extract(input) {
      input.onDelivery?.({ etaAt, needsPresence });
      return null;
    },
  });

  const inDays = (n: number): string =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it('stores the arrival and the tracking number, and proposes nothing', async () => {
    await seed('t_box', 'Your order has shipped', 'Tracking 1Z999AA10123456784, arriving soon.');
    await runEmailMagics(db, userId, { extractor: stubFor(inDays(3), false) });

    const row = await db
      .selectFrom('email_threads')
      .select('delivery_json')
      .where('gmail_thread_id', '=', 't_box')
      .executeTakeFirstOrThrow();
    expect(row.delivery_json).toMatchObject({
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      needsPresence: false,
    });

    // A parcel left at the door is not a calendar entry (ADR 0100), and one
    // card per package is the ADR 0092 pile-up.
    const proposals = await db
      .selectFrom('proposals')
      .selectAll()
      .where('provenance', '=', 'gmail:t_box')
      .execute();
    expect(proposals).toHaveLength(0);
  });

  it('proposes a calendar entry only when someone has to be there', async () => {
    await seed('t_sig', 'Signature required on delivery', 'Someone must be home to sign.');
    await runEmailMagics(db, userId, { extractor: stubFor(inDays(5), true) });

    const proposals = await db
      .selectFrom('proposals')
      .selectAll()
      .where('provenance', '=', 'gmail:t_sig')
      .execute();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.tool_name).toBe('create_event');
    // ADR 0009's 72h TTL would expire this before the parcel lands - and land it
    // in "expired, still owed", which is for obligations, not parcels.
    const livesFor = Date.parse(proposals[0]!.expires_at) - Date.now();
    expect(livesFor).toBeGreaterThan(4 * 86_400_000);
  });
});
