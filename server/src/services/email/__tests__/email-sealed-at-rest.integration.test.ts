/**
 * Mail sealed at rest (ADR 0201, phase 3), from the point of view of someone
 * with a database session: what do they see? And from the application's: does
 * everything still read back?
 *
 * Mail is written through `upsertMessageMeta` and `recomputeThread`, the two
 * functions every provider's sync goes through, so this is what production
 * stores, not a hand-built row.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentCrypto, isSealedText, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { sealMessageContent, sealThreadJson } from '@/services/email/content-seal.js';
import { recomputeThread } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail, type SeedMailOpts } from '@/__test-helpers__/email-seeds.js';
import { withoutSealedPayloads } from '@/__test-helpers__/sealed-text.js';

const M = {
  subject: 'Quarterly ZEBRA-SUBJECT-KX8QP2 review',
  snippet: 'quokka snippet preview text',
  body: 'The wombat body text is the secret payload. Call 555-0142.',
  html: '<p>okapi html body with <b>secret</b></p>',
  name: 'Ophelia Quagmire',
  ics: 'BEGIN:VCALENDAR\r\nSUMMARY:narwhal invite\r\nEND:VCALENDAR',
  file: 'axolotl-report.pdf',
};
const SENDER = 'sender@mailer.example';

const FULL: SeedMailOpts = {
  subject: M.subject,
  snippet: M.snippet,
  body: M.body,
  html: M.html,
  fromName: M.name,
  fromEmail: SENDER,
  ics: M.ics,
  attachments: [{ id: 'a1', filename: M.file, mimeType: 'application/pdf', size: 1234 }],
};

let db: Kysely<DB>;
let raw: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  raw = contentCrypto().raw;
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

/** Everything a database session can see of a row, as one string. */
async function dump(table: 'email_messages' | 'email_threads'): Promise<string> {
  const res = await sql<{ t: string }>`SELECT t::text AS t FROM ${sql.table(table)} t`.execute(raw);
  return withoutSealedPayloads(res.rows.map((r) => r.t).join('\n'));
}

const NEEDLES = [
  'ZEBRA', 'KX8QP2', 'quokka', 'wombat', 'secret', '555-0142', 'okapi', 'Ophelia', 'Quagmire',
  'narwhal', 'axolotl', 'Quarterly',
];

describe('what a database session sees when encryption is on', () => {
  beforeEach(() => setContentEncryption(true));

  it('none of the content is readable, in any column, in either table', async () => {
    await seedSyncedMail(db, userId, FULL);

    for (const table of ['email_messages', 'email_threads'] as const) {
      const text = await dump(table);
      for (const needle of NEEDLES) {
        expect(text.toLowerCase(), `${needle} leaked into ${table}`).not.toContain(needle.toLowerCase());
      }
    }
  });

  it('the sender address is the one thing left readable (owner decision), and only that', async () => {
    await seedSyncedMail(db, userId, FULL);
    const text = await dump('email_threads');
    expect(text).toContain(SENDER);
    const msg = await raw.selectFrom('email_messages').select(['from_email', 'from_name']).executeTakeFirstOrThrow();
    expect(msg.from_email).toBe(SENDER);
    expect(isSealedText(msg.from_name)).toBe(true);
  });

  it('every content column holds a sealed value', async () => {
    await seedSyncedMail(db, userId, FULL);
    const m = await raw.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    for (const col of ['subject', 'snippet', 'from_name', 'body_text', 'body_html', 'ics_text'] as const) {
      expect(isSealedText(m[col]), `${col} should be sealed`).toBe(true);
    }
    const t = await raw.selectFrom('email_threads').selectAll().executeTakeFirstOrThrow();
    for (const col of ['subject', 'snippet', 'from_name'] as const) {
      expect(isSealedText(t[col]), `thread ${col} should be sealed`).toBe(true);
    }
    // attachment metadata is a jsonb string scalar carrying the sealed text
    const att = await sql<{ kind: string }>`SELECT jsonb_typeof(attachments_json) AS kind FROM email_messages`.execute(raw);
    expect(att.rows[0]!.kind).toBe('string');
  });

  it('the application reads every field back exactly', async () => {
    const id = await seedSyncedMail(db, userId, FULL);
    const m = await db.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    expect(m).toMatchObject({
      subject: M.subject,
      snippet: M.snippet,
      from_name: M.name,
      from_email: SENDER,
      body_text: M.body,
      body_html: M.html,
      ics_text: M.ics,
    });
    expect(m.attachments_json).toEqual(FULL.attachments);
    const t = await db.selectFrom('email_threads').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(t).toMatchObject({ subject: M.subject, snippet: M.snippet, from_name: M.name });
  });

  it('the blind index is present and contains nothing readable', async () => {
    await seedSyncedMail(db, userId, FULL);
    const rows = await sql<{ w: string; g: string; f: string }>`
      SELECT blind_words::text AS w, blind_grams::text AS g, blind_from::text AS f FROM email_threads`.execute(raw);
    const { w, g, f } = rows.rows[0]!;
    expect(w.length).toBeGreaterThan(0);
    expect(g.length).toBeGreaterThan(0);
    expect(f.length).toBeGreaterThan(0);
    for (const needle of ['zebra', 'quokka', 'wombat', 'ophelia', 'quagmire', 'quarterly']) {
      expect(`${w} ${g} ${f}`.toLowerCase()).not.toContain(needle);
    }
    expect(w.replace(/'x[0-9a-f]{8}'(:[\d,]+)?/g, '').trim()).toBe('');
  });

  it('empty and absent values are left as they are, so their meaning survives', async () => {
    await seedSyncedMail(db, userId, { subject: 'Plain note', snippet: 'x', body: null, attachments: undefined, ics: '' });
    const m = await raw.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    expect(m.body_text).toBeNull(); // never fetched: still "never fetched"
    expect(m.ics_text).toBe(''); // parsed, no invite: still ''
    const att = await sql<{ text: string }>`SELECT attachments_json::text AS text FROM email_messages`.execute(raw);
    expect(att.rows[0]!.text).toBe('[]'); // no attachments: still []
    expect(isSealedText(m.subject)).toBe(true);
  });

  it('has:attachment keeps working on sealed attachment metadata', async () => {
    await seedSyncedMail(db, userId, FULL);
    await seedSyncedMail(db, userId, { subject: 'No file here', snippet: 'nothing attached' });
    const withFiles = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM email_messages WHERE attachments_json IS NOT NULL AND attachments_json <> '[]'`.execute(raw);
    expect(withFiles.rows[0]!.n).toBe('1');
  });

  it('recomputing a thread whose content did not change rewrites no ciphertext', async () => {
    // A mark-read or a label change recomputes the thread. Re-sealing would
    // write a fresh ciphertext (new IV) and a new index for nothing, and every
    // write is WAL and a row version.
    const id = await seedSyncedMail(db, userId, FULL);
    const before = await raw.selectFrom('email_threads').select(['subject', 'snippet', 'from_name']).where('id', '=', id).executeTakeFirstOrThrow();
    const { gmail_thread_id } = await raw.selectFrom('email_threads').select('gmail_thread_id').where('id', '=', id).executeTakeFirstOrThrow();

    await recomputeThread(db, userId, gmail_thread_id);

    const after = await raw.selectFrom('email_threads').select(['subject', 'snippet', 'from_name']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const read = await db.selectFrom('email_threads').select('subject').where('id', '=', id).executeTakeFirstOrThrow();
    expect(read.subject).toBe(M.subject);
  });

  it('recomputing a thread whose newest message changed reseals the new content', async () => {
    const id = await seedSyncedMail(db, userId, FULL);
    const { gmail_thread_id } = await raw.selectFrom('email_threads').select('gmail_thread_id').where('id', '=', id).executeTakeFirstOrThrow();
    const before = await raw.selectFrom('email_threads').select('snippet').where('id', '=', id).executeTakeFirstOrThrow();
    await raw
      .updateTable('email_messages')
      .set({ snippet: 'plain replacement text' })
      .where('gmail_thread_id', '=', gmail_thread_id)
      .execute();

    await recomputeThread(db, userId, gmail_thread_id);

    const after = await raw.selectFrom('email_threads').select('snippet').where('id', '=', id).executeTakeFirstOrThrow();
    expect(after.snippet).not.toBe(before.snippet);
    expect(isSealedText(after.snippet)).toBe(true);
    const read = await db.selectFrom('email_threads').select('snippet').where('id', '=', id).executeTakeFirstOrThrow();
    expect(read.snippet).toBe('plain replacement text');
    expect(await dump('email_threads')).not.toContain('replacement');
  });

  it('a thread fact (flight, delivery, receipt, advisory) is sealed and reads back as the same object', async () => {
    const id = await seedSyncedMail(db, userId, FULL);
    const flight = { iata: 'UA', number: '512', ident: 'UAL512', origin: 'IAD', destination: 'DEN' };
    const advisory = { note: 'This looks like a phishing attempt', severity: 'caution' };
    await db
      .updateTable('email_threads')
      .set({
        flight_json: await sealThreadJson(userId, 'flight_json', flight),
        read_advisory_json: await sealThreadJson(userId, 'read_advisory_json', advisory),
      })
      .where('id', '=', id)
      .execute();

    const row = await db.selectFrom('email_threads').select(['flight_json', 'read_advisory_json']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.flight_json).toEqual(flight);
    expect(row.read_advisory_json).toEqual(advisory);
    const seen = await sql<{ t: string }>`SELECT flight_json::text AS t FROM email_threads`.execute(raw);
    expect(withoutSealedPayloads(seen.rows[0]!.t)).not.toContain('IAD');
    expect(withoutSealedPayloads(seen.rows[0]!.t)).not.toContain('UAL512');
    // "is there a flight" is still answerable in SQL
    const has = await sql<{ n: string }>`SELECT count(*)::text AS n FROM email_threads WHERE flight_json IS NOT NULL`.execute(db);
    expect(has.rows[0]!.n).toBe('1');
  });

  it('a body-only update seals the body and re-indexes without touching the subject', async () => {
    await seedSyncedMail(db, userId, { subject: 'Untouched subject', snippet: 's', body: null });
    const fields = await sealMessageContent(userId, { body_text: M.body });
    expect(Object.keys(fields).sort()).toEqual(['blind_grams', 'blind_words', 'body_text']);
    expect(isSealedText(fields.body_text as string)).toBe(true);
  });
});

describe('what changes, and what does not, when encryption is off', () => {
  beforeEach(() => setContentEncryption(false));

  it('content is written as before, but the blind index is still maintained', async () => {
    await seedSyncedMail(db, userId, FULL);
    const m = await raw.selectFrom('email_messages').selectAll().executeTakeFirstOrThrow();
    expect(m.subject).toBe(M.subject);
    expect(m.body_text).toBe(M.body);
    const idx = await sql<{ n: string }>`SELECT count(*)::text AS n FROM email_threads WHERE blind_words IS NOT NULL AND blind_grams IS NOT NULL`.execute(raw);
    expect(idx.rows[0]!.n).toBe('1');
  });

  it('sealed and plain rows sit side by side and both read back', async () => {
    setContentEncryption(false);
    const plain = await seedSyncedMail(db, userId, { subject: 'Plain subject wombat', snippet: 'p' });
    setContentEncryption(true);
    const sealed = await seedSyncedMail(db, userId, { subject: 'Sealed subject narwhal', snippet: 's' });

    const rows = await db.selectFrom('email_threads').select(['id', 'subject']).where('id', 'in', [plain, sealed]).execute();
    const by = Object.fromEntries(rows.map((r) => [r.id, r.subject]));
    expect(by[plain]).toBe('Plain subject wombat');
    expect(by[sealed]).toBe('Sealed subject narwhal');
    const rawRows = await raw.selectFrom('email_threads').select(['id', 'subject']).where('id', 'in', [plain, sealed]).execute();
    const rawBy = Object.fromEntries(rawRows.map((r) => [r.id, r.subject]));
    expect(isSealedText(rawBy[plain])).toBe(false);
    expect(isSealedText(rawBy[sealed])).toBe(true);
  });
});

describe('when the owner is erased', () => {
  it('sealed mail stays unreadable and does not break a listing', async () => {
    setContentEncryption(true);
    const other = await createUser(db, 'bob');
    const mine = await seedSyncedMail(db, userId, FULL);
    const theirs = await seedSyncedMail(db, other, { subject: 'Bob still here', snippet: 'b' });
    const { store, keys } = contentCrypto();
    await store.destroy(keys, userId);

    const rows = await db.selectFrom('email_threads').select(['id', 'subject']).where('id', 'in', [mine, theirs]).execute();
    const by = Object.fromEntries(rows.map((r) => [r.id, r.subject]));
    expect(by[theirs]).toBe('Bob still here');
    expect(isSealedText(by[mine])).toBe(true); // ciphertext, never plaintext
    expect(by[mine]).not.toContain('ZEBRA');
  });
});
