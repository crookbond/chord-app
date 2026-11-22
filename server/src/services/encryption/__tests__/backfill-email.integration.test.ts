/**
 * Sealing a mailbox that already exists (ADR 0201, phase 3): the plaintext rows
 * a deployment has today. Every property here is one an operator is counting on
 * while running it against production: it seals everything, it can be stopped
 * and restarted, running it twice is harmless, and search still finds the mail
 * afterwards.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { contentCrypto, isSealedText, sealText, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { countPlaintextMail, sealExistingMail } from '@/services/encryption/backfill-email.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchHits } from '@/services/search.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail, type SeedMailOpts } from '@/__test-helpers__/email-seeds.js';
import { withoutSealedPayloads } from '@/__test-helpers__/sealed-text.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let raw: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  raw = contentCrypto().raw;
  userId = await createUser(db, 'alice');
  setContentEncryption(true);
});
afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
});

const FULL: SeedMailOpts = {
  subject: 'Flight UA512 to Denver confirmation KX8QP2',
  snippet: 'Your itinerary is attached',
  body: 'Your confirmation code is KX8QP2. Departure 09:40 from Dulles.',
  html: '<p>Your confirmation code is <b>KX8QP2</b></p>',
  fromName: 'United Airlines',
  fromEmail: 'noreply@united.example',
  ics: 'BEGIN:VCALENDAR\r\nSUMMARY:UA512\r\nEND:VCALENDAR',
  attachments: [{ id: 'a1', filename: 'boarding-pass.pdf', mimeType: 'application/pdf', size: 9000 }],
};

async function dump(): Promise<string> {
  const a = await sql<{ t: string }>`SELECT t::text AS t FROM email_messages t`.execute(raw);
  const b = await sql<{ t: string }>`SELECT t::text AS t FROM email_threads t`.execute(raw);
  return [...a.rows, ...b.rows].map((r) => r.t).join('\n');
}

async function searchFor(uid: string, query: string): Promise<string[]> {
  const personal = (await ensurePersonalGroup(db, uid)).id;
  const res = await searchHits(db, { userId: uid, groupId: personal, crossGroup: true, query, limit: 50 });
  return res.hits.filter((h) => h.entityType === 'email').map((h) => h.entityId);
}

describe('sealing a legacy mailbox', () => {
  it('leaves nothing readable, and the application still reads every field', async () => {
    const id = await seedPlainMail(db, userId, FULL);
    expect((await countPlaintextMail(db)).total).toBeGreaterThan(0);

    const r = await sealExistingMail(db);

    expect(r).toMatchObject({ messagesScanned: 1, messagesSealed: 1, threadsScanned: 1, threadsSealed: 1, failed: 0 });
    expect((await countPlaintextMail(db)).total).toBe(0);
    const text = withoutSealedPayloads(await dump());
    for (const needle of ['KX8QP2', 'UA512', 'Dulles', 'boarding-pass', 'United Airlines', 'Denver']) {
      expect(text).not.toContain(needle);
    }
    const m = await db.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    expect(m).toMatchObject({ subject: FULL.subject, snippet: FULL.snippet, body_text: FULL.body, body_html: FULL.html, from_name: 'United Airlines', ics_text: FULL.ics });
    expect(m.attachments_json).toEqual(FULL.attachments);
    const t = await db.selectFrom('email_threads').select(['subject', 'from_name']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(t).toEqual({ subject: FULL.subject, from_name: 'United Airlines' });
  });

  it('keeps the meaning of empty and absent values', async () => {
    await seedPlainMail(db, userId, { subject: 'No body yet', snippet: 'x', body: null });
    await sealExistingMail(db);

    const m = await raw.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    expect(m.body_text).toBeNull();
    expect(m.body_html).toBeNull();
    expect(m.ics_text).toBe('');
    const att = await sql<{ t: string }>`SELECT attachments_json::text AS t FROM email_messages`.execute(raw);
    expect(att.rows[0]!.t).toBe('[]');
  });

  it('seals thread facts (delivery, flight, receipt, advisory) and they read back as the same objects', async () => {
    const id = await seedPlainMail(db, userId, FULL);
    const facts = {
      delivery_json: { etaAt: '2026-10-01', carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
      flight_json: { iata: 'UA', number: '512', origin: 'IAD', destination: 'DEN' },
      receipt_json: { merchant: 'Acme', amount: 12.5, currency: 'USD' },
      read_advisory_json: { note: 'Looks like phishing', severity: 'caution' },
    };
    for (const [col, value] of Object.entries(facts)) {
      await sql`UPDATE email_threads SET ${sql.ref(col)} = ${JSON.stringify(value)}::jsonb WHERE id = ${id}`.execute(raw);
    }

    await sealExistingMail(db);

    const row = await db.selectFrom('email_threads').select(['delivery_json', 'flight_json', 'receipt_json', 'read_advisory_json']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toEqual(facts);
    const seen = await sql<{ t: string }>`SELECT (delivery_json::text || flight_json::text || receipt_json::text || read_advisory_json::text) AS t FROM email_threads`.execute(raw);
    for (const needle of ['UPS', '1Z999', 'IAD', 'Acme', 'phishing']) expect(withoutSealedPayloads(seen.rows[0]!.t)).not.toContain(needle);
  });

  it('seals each user under their own key', async () => {
    const bob = await createUser(db, 'bob');
    await seedPlainMail(db, userId, { subject: 'Alice secret', snippet: 'a' });
    await seedPlainMail(db, bob, { subject: 'Bob secret', snippet: 'b' });

    await sealExistingMail(db);

    const rows = await raw.selectFrom('email_threads').select(['user_id', 'subject']).execute();
    for (const r of rows) expect(r.subject.split('.')[1]).toBe(r.user_id);
  });

  it('search finds the mail afterwards, with the legacy index switched off', async () => {
    const id = await seedPlainMail(db, userId, FULL);
    legacy.CONTENT_LEGACY_TSV = false;
    expect(await searchFor(userId, 'denver')).toEqual([]); // no blind index yet

    await sealExistingMail(db);

    expect(await searchFor(userId, 'denver')).toEqual([id]);
    expect(await searchFor(userId, 'kx8qp2')).toEqual([id]); // a code, found in the body
    expect(await searchFor(userId, 'united')).toEqual([id]); // the sealed sender name
    expect(await searchFor(userId, 'zebra')).toEqual([]);
  });

  it('the same words never match another user’s mail', async () => {
    const bob = await createUser(db, 'bob');
    await seedPlainMail(db, userId, { subject: 'Denver trip', snippet: 'a' });
    const bobs = await seedPlainMail(db, bob, { subject: 'Denver plans', snippet: 'b' });
    legacy.CONTENT_LEGACY_TSV = false;
    await sealExistingMail(db);

    expect(await searchFor(bob, 'denver')).toEqual([bobs]);
  });
});

describe('running it again, and stopping half way', () => {
  it('is idempotent: a second run changes nothing', async () => {
    await seedPlainMail(db, userId, FULL);
    await sealExistingMail(db);
    const before = await dump();

    const again = await sealExistingMail(db);

    expect(again).toMatchObject({ messagesSealed: 0, threadsSealed: 0, failed: 0 });
    expect(again.skipped).toBe(2);
    expect(await dump()).toBe(before);
  });

  it('a dry run reports the work and writes nothing', async () => {
    await seedPlainMail(db, userId, FULL);
    const before = await dump();

    const r = await sealExistingMail(db, { dryRun: true });

    expect(r.messagesSealed).toBe(1);
    expect(await dump()).toBe(before);
    expect((await countPlaintextMail(db)).total).toBeGreaterThan(0);
  });

  it('finishes a row that an earlier run only half sealed', async () => {
    const id = await seedPlainMail(db, userId, FULL);
    // As if a previous run sealed the subject and stopped: subject sealed, body not, no index.
    const sealed = await sealText(contentCrypto().store, contentCrypto().keys, userId, 'email_threads:subject', FULL.subject);
    await raw.updateTable('email_threads').set({ subject: sealed }).where('id', '=', id).execute();

    const r = await sealExistingMail(db);

    expect(r.failed).toBe(0);
    expect((await countPlaintextMail(db)).total).toBe(0);
    const t = await db.selectFrom('email_threads').select('subject').where('id', '=', id).executeTakeFirstOrThrow();
    expect(t.subject).toBe(FULL.subject);
  });

  it('works through more rows than one batch holds', async () => {
    for (let i = 0; i < 25; i++) await seedPlainMail(db, userId, { subject: `Note number ${i}`, snippet: `snippet ${i}`, body: `body ${i} zebrafish` });

    const r = await sealExistingMail(db, { batch: 7 });

    expect(r).toMatchObject({ messagesScanned: 25, messagesSealed: 25, threadsScanned: 25, threadsSealed: 25, failed: 0 });
    expect((await countPlaintextMail(db)).total).toBe(0);
  });

  it('a mailbox already written sealed is left alone and only gets its index if missing', async () => {
    const id = await seedPlainMail(db, userId, FULL);
    await sealExistingMail(db);
    await sql`UPDATE email_threads SET blind_words = NULL, blind_from = NULL WHERE id = ${id}`.execute(raw);

    const r = await sealExistingMail(db);

    expect(r.threadsSealed).toBe(1);
    const idx = await sql<{ n: string }>`SELECT count(*)::text AS n FROM email_threads WHERE blind_words IS NOT NULL`.execute(raw);
    expect(idx.rows[0]!.n).toBe('1');
  });
});

describe('countPlaintextMail', () => {
  it('counts each readable column, and treats sealed, empty and [] as clean', async () => {
    await seedPlainMail(db, userId, { subject: 'Readable', snippet: 'also readable', body: 'and this' });
    const c = await countPlaintextMail(db);
    expect(c.messages.subject).toBe(1);
    expect(c.messages.body_text).toBe(1);
    expect(c.messages.ics_text).toBe(0); // '' is not content
    expect(c.messages.attachments_json).toBe(0); // [] is not content
    expect(c.threads.subject).toBe(1);
    expect(c.total).toBeGreaterThan(0);
    expect(isSealedText('enc1.x.y.z')).toBe(true);
  });
});
