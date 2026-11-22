/**
 * The write-side helpers (ADR 0201): what `sealField` and `sealJsonField` leave
 * alone on purpose, and the key the blind index is built with. The "leave alone"
 * rules are the ones that keep a column's meaning intact once its content is
 * sealed, so each has its own case.
 */
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '../../schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { withoutSealedPayloads } from '@/__test-helpers__/sealed-text.js';
import {
  contentCrypto,
  indexKeyFor,
  isSealedText,
  JSON_CTX_SUFFIX,
  sealedContext,
  sealField,
  sealJsonField,
  setContentEncryption,
} from '../index.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('sealField', () => {
  it('returns the value untouched when encryption is off', async () => {
    setContentEncryption(false);
    expect(await sealField('u_a', 'email_messages:subject', 'hello')).toBe('hello');
  });

  it('seals text when encryption is on, under the context it was given', async () => {
    setContentEncryption(true);
    const sealed = await sealField('u_a', 'email_messages:subject', 'hello');
    expect(isSealedText(sealed)).toBe(true);
    expect(sealedContext(sealed as string)).toBe('email_messages:subject');
  });

  it('leaves null, undefined and the empty string alone, because they carry meaning', async () => {
    setContentEncryption(true);
    expect(await sealField('u_a', 'c', null)).toBeNull(); // "never fetched"
    expect(await sealField('u_a', 'c', undefined)).toBeUndefined();
    expect(await sealField('u_a', 'c', '')).toBe(''); // "parsed, nothing there"
  });

  it('does not create a key for a value it does not seal', async () => {
    setContentEncryption(true);
    await sealField('u_nokey', 'c', null);
    await sealField('u_nokey', 'c', '');
    const rows = await db.selectFrom('content_keys').select('owner').where('owner', '=', 'u_nokey').execute();
    expect(rows).toEqual([]);
  });
});

describe('sealJsonField', () => {
  it('returns the JSON text unchanged when encryption is off', async () => {
    setContentEncryption(false);
    expect(await sealJsonField('u_a', 'email_threads:flight_json', '{"iata":"UA"}')).toBe('{"iata":"UA"}');
    expect(await sealJsonField('u_a', 'email_threads:flight_json', null)).toBeNull();
  });

  it('seals a real value as a JSON string scalar, tagged so the reader parses it back', async () => {
    setContentEncryption(true);
    const stored = await sealJsonField('u_a', 'email_threads:flight_json', '{"iata":"UA","number":"512"}');
    const scalar = JSON.parse(stored!) as string; // valid JSON: a string
    expect(isSealedText(scalar)).toBe(true);
    expect(sealedContext(scalar).endsWith(JSON_CTX_SUFFIX)).toBe(true);
    expect(withoutSealedPayloads(stored!)).not.toContain('UA');
  });

  it('leaves null, [], {} and null-the-literal alone so "is there anything" stays answerable', async () => {
    setContentEncryption(true);
    expect(await sealJsonField('u_a', 'c', null)).toBeNull();
    expect(await sealJsonField('u_a', 'c', undefined)).toBeNull();
    for (const empty of ['[]', '{}', 'null']) expect(await sealJsonField('u_a', 'c', empty)).toBe(empty);
  });

  it('round-trips through a jsonb column and the read plugin back to the same value', async () => {
    setContentEncryption(true);
    const u = await createUser(db, 'jsonb-user');
    const value = { note: 'Looks like phishing', severity: 'caution', nested: { list: [1, 2, 3] } };
    const stored = await sealJsonField(u, 'email_threads:read_advisory_json', JSON.stringify(value));
    // Any jsonb column will do for the round trip; a scratch table keeps it honest.
    const raw = contentCrypto().raw;
    await sql`CREATE TABLE IF NOT EXISTS scratch_json (id text, v jsonb)`.execute(raw);
    await sql`INSERT INTO scratch_json VALUES ('a', ${stored}::jsonb)`.execute(raw);

    const read = await sql<{ v: unknown }>`SELECT v FROM scratch_json WHERE id = 'a'`.execute(db);
    expect(read.rows[0]!.v).toEqual(value);
    const seen = await sql<{ t: string }>`SELECT v::text AS t FROM scratch_json`.execute(raw);
    expect(withoutSealedPayloads(seen.rows[0]!.t)).not.toContain('phishing');
    await sql`DROP TABLE scratch_json`.execute(raw);
  });
});

describe('indexKeyFor', () => {
  it('is 32 bytes, stable for an owner, and different from the data key and from other owners', async () => {
    const a1 = await indexKeyFor('u_index_a');
    const a2 = await indexKeyFor('u_index_a');
    const b = await indexKeyFor('u_index_b');
    const { store, keys } = contentCrypto();
    const dek = await store.getDek(keys, 'u_index_a');

    expect(a1).toHaveLength(32);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
    expect(a1.equals(dek)).toBe(false);
  });

  it('is the same after the key cache is cleared (it derives from the stored key, not from memory)', async () => {
    const before = await indexKeyFor('u_index_c');
    contentCrypto().store.clearCache();
    const after = await indexKeyFor('u_index_c');
    expect(after.equals(before)).toBe(true);
  });

  it('returns null for an owner with no key when asked not to create one, and creates nothing', async () => {
    expect(await indexKeyFor('u_index_none', false)).toBeNull();
    const rows = await db.selectFrom('content_keys').select('owner').where('owner', '=', 'u_index_none').execute();
    expect(rows).toEqual([]);
  });

  it('creates the key on first use by default', async () => {
    const k = await indexKeyFor('u_index_new');
    expect(k).toHaveLength(32);
    const rows = await db.selectFrom('content_keys').select('owner').where('owner', '=', 'u_index_new').execute();
    expect(rows).toHaveLength(1);
  });

  it('a destroyed owner has no usable index key: a read finds none, a write refuses', async () => {
    await indexKeyFor('u_index_gone');
    const { store, keys } = contentCrypto();
    await store.destroy(keys, 'u_index_gone');
    expect(await indexKeyFor('u_index_gone', false)).toBeNull();
    await expect(indexKeyFor('u_index_gone')).rejects.toThrow(/destroyed/);
  });
});
