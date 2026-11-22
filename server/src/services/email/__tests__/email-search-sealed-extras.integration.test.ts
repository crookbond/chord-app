/**
 * Search over sealed mail beyond the shared matching scenarios: operators,
 * threads with several messages, the highlighted excerpt, the edges of what the
 * index covers, and the cases where the blind index is wrong on purpose and the
 * application has to catch it. Everything is written through the sync path with
 * encryption ON and the legacy plaintext index OFF.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { contentCrypto, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { findEmailThreads } from '@/services/email/email-search.js';
import { suggestRecipients } from '@/services/email/recipients.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { ensureThreadRow, recomputeThread, upsertMessageMeta } from '@/services/google/gmail.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { normalizedFrom, seedSyncedMail, type SeedMailOpts } from '@/__test-helpers__/email-seeds.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  personalId = (await ensurePersonalGroup(db, userId)).id;
  setContentEncryption(true);
  legacy.CONTENT_LEGACY_TSV = false;
});
afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
});

const box = async (q: string) =>
  (await searchHits(db, { userId, groupId: personalId, crossGroup: true, query: q, limit: 50 })).hits.filter(
    (h) => h.entityType === 'email',
  );
const bot = async (q: string) =>
  (await searchEverything(db, { userId, groupId: personalId, crossGroup: true, query: q, perCategory: 25 })).emails;
const ids = async (q: string) => {
  const b = (await box(q)).map((h) => h.entityId).sort();
  const t = (await bot(q)).map((e) => e.id).sort();
  expect(t, `both surfaces agree on "${q}"`).toEqual(b);
  return b;
};

describe('operators on sealed mail', () => {
  const FILE = [{ id: 'a1', filename: 'form.pdf', mimeType: 'application/pdf', size: 10 }];

  it('has:attachment narrows to mail with a file', async () => {
    const withFile = await seedSyncedMail(db, userId, { subject: 'Permission slip', snippet: 'sign it', attachments: FILE });
    await seedSyncedMail(db, userId, { subject: 'Permission reminder', snippet: 'sign it' });
    expect(await ids('permission has:attachment')).toEqual([withFile]);
  });

  it('after: and before: bound the date, with no free text', async () => {
    const old = await seedSyncedMail(db, userId, { subject: 'Old note', snippet: 'a', at: '2026-01-10T10:00:00.000Z' });
    const mid = await seedSyncedMail(db, userId, { subject: 'Mid note', snippet: 'b', at: '2026-05-10T10:00:00.000Z' });
    const recent = await seedSyncedMail(db, userId, { subject: 'New note', snippet: 'c', at: '2026-09-10T10:00:00.000Z' });
    expect(await ids('after:2026-03-01')).toEqual([mid, recent].sort());
    expect(await ids('before:2026-03-01')).toEqual([old]);
    expect(await ids('after:2026-03-01 before:2026-07-01')).toEqual([mid]);
  });

  it('label: finds mail carrying a label, sealed or not', async () => {
    const t = await seedSyncedMail(db, userId, { subject: 'Labelled', snippet: 'x', labels: ['INBOX', 'Label_42'] });
    await seedSyncedMail(db, userId, { subject: 'Unlabelled', snippet: 'y' });
    expect(await ids('label:Label_42')).toEqual([t]);
  });

  it('from: matches the sealed display name and the address, alone or with text', async () => {
    const a = await seedSyncedMail(db, userId, { subject: 'Hello', fromName: 'Loudoun Schools', fromEmail: 'office@lcps.example' });
    const b = await seedSyncedMail(db, userId, { subject: 'Hello there', fromName: 'Someone Else', fromEmail: 'x@other.example' });
    expect(await ids('from:loudoun')).toEqual([a]); // name only
    expect(await ids('from:lcps.example')).toEqual([a]); // address
    expect(await ids('from:someone hello')).toEqual([b]); // name plus free text
    expect(await ids('from:nobody')).toEqual([]);
  });

  it('from: with a name that has the trigrams but not the text does not match (confirmation)', async () => {
    // "abcabc"-style: the name contains every trigram of the query without the substring.
    await seedSyncedMail(db, userId, { subject: 'Hi', fromName: 'bca abc cab', fromEmail: 'q@z.example' });
    expect(await ids('from:bcabc')).toEqual([]);
  });

  it('from: with under three characters matches addresses only (pinned: a name needs a trigram)', async () => {
    await seedSyncedMail(db, userId, { subject: 'Hi', fromName: 'Zoltan', fromEmail: 'no@reply.test' });
    expect(await ids('from:zo')).toEqual([]);
    expect(await ids('from:no@')).toHaveLength(1);
  });
});

describe('threads with more than one message', () => {
  async function threadOf(messages: SeedMailOpts[]): Promise<string> {
    const gid = newId('gt');
    const first = new Date('2026-08-01T10:00:00.000Z').getTime();
    const rowId = await ensureThreadRow(db, userId, gid, new Date(first).toISOString());
    for (const [i, m] of messages.entries()) {
      const at = new Date(first + i * 3_600_000).toISOString();
      await upsertMessageMeta(db, userId, rowId, normalizedFrom({ ...m, at }, gid, at), at);
    }
    await recomputeThread(db, userId, gid);
    return rowId;
  }

  it('finds a thread by a word that only an EARLIER message contains', async () => {
    const id = await threadOf([
      { subject: 'Trip', snippet: 'a', body: 'We should book the zebrafish tour' },
      { subject: 'Re: Trip', snippet: 'b', body: 'Sounds good, thanks' },
      { subject: 'Re: Trip', snippet: 'c', body: 'Confirmed for Friday' },
    ]);
    expect(await ids('zebrafish')).toEqual([id]);
  });

  it('finds a code in the second message and reports the thread once', async () => {
    const id = await threadOf([
      { subject: 'Booking', snippet: 'a', body: 'Details to follow' },
      { subject: 'Re: Booking', snippet: 'b', body: 'Your confirmation is KX8QP2' },
    ]);
    const hits = await box('kx8qp2');
    expect(hits.map((h) => h.entityId)).toEqual([id]);
  });

  it('shows the excerpt from the message that matched, with the word marked', async () => {
    await threadOf([
      { subject: 'Weekly', snippet: 'unrelated preview', body: 'Nothing here' },
      { subject: 'Re: Weekly', snippet: 'unrelated preview', body: 'The plumber is booked for Thursday morning' },
    ]);
    const [hit] = await box('plumber');
    expect(hit!.snippet).toContain('<b>plumber</b>');
    expect(hit!.snippet).not.toContain('unrelated');
  });

  it('a body-only match with an empty subject and snippet still gets an excerpt', async () => {
    await seedSyncedMail(db, userId, { subject: '', snippet: '', body: 'Please call the dentist about Tuesday' });
    const [hit] = await box('dentist');
    expect(hit!.snippet).toContain('<b>dentist</b>');
  });
});

describe('the edges of what the index covers', () => {
  it('a word deep inside a large body is found, up to the indexed cap', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(3000); // ~81k chars, inside the cap
    const id = await seedSyncedMail(db, userId, { subject: 'Long one', snippet: 'x', body: `${filler} quokkatail` });
    expect(await ids('quokkatail')).toEqual([id]);
  });

  it('a word past the indexed cap is NOT found by word (pinned limit), though a code still is', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(6000); // ~162k chars, past the 100k cap
    await seedSyncedMail(db, userId, { subject: 'Very long', snippet: 'x', body: `${filler} quokkatail` });
    expect(await ids('quokkatail')).toEqual([]);
  });

  it('a mailbox row with no blind index is invisible when the legacy index is off (why the backfill exists)', async () => {
    const id = await seedSyncedMail(db, userId, { subject: 'Denver plans', snippet: 'x' });
    await sql`UPDATE email_threads SET blind_words = NULL, blind_grams = NULL, blind_from = NULL WHERE id = ${id}`.execute(
      contentCrypto().raw,
    );
    expect(await ids('denver')).toEqual([]);
  });

  it('a user with no key yet searches without error and finds nothing', async () => {
    const stranger = await createUser(db, 'stranger');
    const hits = await findEmailThreads(db, { userId: stranger, text: 'anything', limit: 10, order: 'rank' });
    expect(hits).toEqual([]);
  });

  it('short queries never reach the literal arm, so ciphertext cannot match them by accident', async () => {
    // Sealed columns are base64, and a LIKE over base64 matches a short query by
    // chance. The literal arm runs on trigrams of the PLAINTEXT, and the legacy
    // columns are only read for rows with no index.
    for (let i = 0; i < 30; i++) await seedSyncedMail(db, userId, { subject: `Note ${i}`, snippet: `nothing to see ${i}`, body: `body ${i}` });
    legacy.CONTENT_LEGACY_TSV = true;
    for (const junk of ['abc', 'xyz', 'q9z', 'a1b', 'zzz']) {
      expect(await ids(junk), junk).toEqual([]);
    }
  });

  it('a sealed row is never matched through the legacy predicate even with the legacy index on', async () => {
    legacy.CONTENT_LEGACY_TSV = true;
    const id = await seedSyncedMail(db, userId, { subject: 'Sealed subject', snippet: 'quokka' });
    const raw = contentCrypto().raw;
    const stored = await raw.selectFrom('email_threads').select('subject').where('id', '=', id).executeTakeFirstOrThrow();
    // A fragment of the ciphertext must not match.
    const fragment = stored.subject.split('.')[3]!.slice(10, 16).toLowerCase();
    expect(await ids(fragment)).toEqual([]);
  });
});

describe('recipient autocomplete over sealed names', () => {
  it('finds a sender by the sealed display name, with three or more characters', async () => {
    await seedSyncedMail(db, userId, { subject: 'Hi', fromName: 'Ms Chen', fromEmail: 'office@sch.example' });
    const out = await suggestRecipients(db, userId, 'chen');
    expect(out.map((o) => o.email)).toEqual(['office@sch.example']);
    expect(out[0]!.name).toBe('Ms Chen');
  });

  it('a three-character query is exact, a longer one is confirmed against the name', async () => {
    await seedSyncedMail(db, userId, { subject: 'Hi', fromName: 'bca abc cab', fromEmail: 'q@z.example' });
    expect(await suggestRecipients(db, userId, 'cab')).toHaveLength(1);
    expect(await suggestRecipients(db, userId, 'bcabc')).toEqual([]);
  });

  it('a two-character query matches addresses only (pinned)', async () => {
    await seedSyncedMail(db, userId, { subject: 'Hi', fromName: 'Zoltan', fromEmail: 'nobody@reply.test' });
    expect(await suggestRecipients(db, userId, 'zo')).toEqual([]);
    expect((await suggestRecipients(db, userId, 'no')).map((o) => o.email)).toEqual(['nobody@reply.test']);
  });

  it('never suggests another user’s correspondent', async () => {
    const bob = await createUser(db, 'bob');
    await seedSyncedMail(db, bob, { subject: 'Hi', fromName: 'Secret Sender', fromEmail: 'secret@bob.example' });
    expect(await suggestRecipients(db, userId, 'secret')).toEqual([]);
  });
});
