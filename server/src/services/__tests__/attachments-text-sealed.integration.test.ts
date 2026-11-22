/**
 * What was read out of a file is as sensitive as the file (ADR 0201, phase 4):
 * extracted text, the summary, the questions it answers, and the search chunks
 * built from them, which the bot retrieves from on every turn. They are sealed
 * under the file's owner and searched through a blind index, so the checks are
 * the ones the mail has: nothing readable at rest, everything still findable,
 * and the bot's retrieval still working.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { contentCrypto, isSealedText, sealedOwner, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks, searchAttachmentChunks } from '@/services/attachments.index.js';
import {
  copyAttachmentToGroup,
  getAttachment,
  patchAttachmentMeta,
  saveFile,
} from '@/services/attachments.service.js';
import { selectExcerptsForTurn } from '@/services/bot/retrieval.js';
import { sealExistingDerived } from '@/services/encryption/backfill-derived.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

const MARKER = 'quokkasecret-plan-KX8QP2';
const TEXT = `Term calendar for the school year.\n\nPickup moves to 2:45 on Fridays. The ${MARKER} is confidential.\n\nBring the swimming kit on Thursday.`;

let db: Kysely<DB>;
let raw: Kysely<DB>;
let userId: string;
let groupId: string;
const dirs: string[] = [];

beforeEach(async () => {
  db = await openTestDb();
  raw = contentCrypto().raw;
  userId = await createUser(db, 'alice');
  groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  dirs.push(path.join(env.FILES_DIR, 'group', groupId));
  setContentEncryption(true);
  legacy.CONTENT_LEGACY_TSV = false;
});
afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function save(opts: { group?: string; filename?: string; text?: string } = {}) {
  const g = opts.group ?? groupId;
  return saveFile(db, {
    scope: { kind: 'group', groupId: g },
    uploadedBy: userId,
    filename: opts.filename ?? 'calendar.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(opts.text ?? TEXT),
    awaitExtraction: true,
  });
}

async function search(keywords: string[], ids: string[], limit = 10) {
  return searchAttachmentChunks(db, { keywords, candidateIds: ids, limit });
}

async function dump(table: 'attachments' | 'attachment_chunks'): Promise<string> {
  const r = await sql<{ t: string }>`SELECT t::text AS t FROM ${sql.table(table)} t`.execute(raw);
  return r.rows.map((x) => x.t).join('\n');
}

describe('what is stored', () => {
  it('the text, the summary and the chunks are sealed; nothing readable is left', async () => {
    await save();

    for (const table of ['attachments', 'attachment_chunks'] as const) {
      const text = await dump(table);
      expect(text, `${table} leaked the marker`).not.toContain('quokkasecret');
      expect(text, `${table} leaked the text`).not.toContain('swimming kit');
      expect(text, `${table} leaked the text`).not.toContain('Pickup');
    }
    const a = await raw.selectFrom('attachments').selectAll().executeTakeFirstOrThrow();
    expect(isSealedText(a.extracted_text)).toBe(true);
    const chunks = await sql<{ content: string; indexed: boolean }>`
      SELECT content, (blind_words IS NOT NULL) AS indexed FROM attachment_chunks`.execute(raw);
    expect(chunks.rows.length).toBeGreaterThan(0);
    for (const c of chunks.rows) {
      expect(isSealedText(c.content)).toBe(true);
      expect(c.indexed).toBe(true);
    }
  });

  it('the filename stays readable, as it does on the attachment row', async () => {
    await save({ filename: 'term-calendar.txt' });
    expect(await dump('attachment_chunks')).toContain('term-calendar.txt');
  });

  it('the application reads the text back exactly', async () => {
    const att = await save();
    const row = await getAttachment(db, att.id);
    expect(row?.extractedText).toBe(TEXT);
  });

  it('is sealed under the file’s owner, so a group file opens for the group', async () => {
    await save();
    const a = await raw.selectFrom('attachments').select('extracted_text').executeTakeFirstOrThrow();
    expect(sealedOwner(a.extracted_text!)).toBe(groupId);
    const c = await sql<{ content: string }>`SELECT content FROM attachment_chunks LIMIT 1`.execute(raw);
    expect(sealedOwner(c.rows[0]!.content)).toBe(groupId);
  });
});

describe('finding it again', () => {
  it('finds a chunk by a word, a stem and a prefix', async () => {
    const att = await save();
    // 'swim' is a prefix of the stem of "swimming" and 'conf' of "confidential".
    for (const kw of [['swimming'], ['pickups'], ['pickup'], ['swim'], ['conf'], ['confidential']]) {
      const hits = await search(kw, [att.id]);
      expect(hits.length, kw.join()).toBeGreaterThan(0);
      expect(hits[0]!.attachmentId).toBe(att.id);
    }
  });

  it('marks the match in the snippet with the same « » markers as before', async () => {
    const att = await save();
    const [hit] = await search(['swimming'], [att.id]);
    expect(hit!.snippet).toContain('«swimming»');
  });

  it('finds a file by a word that appears only in its filename', async () => {
    const att = await save({ filename: 'zebrafish-itinerary.txt', text: 'Nothing about that here at all.' });
    const hits = await search(['zebrafish'], [att.id]);
    // Every chunk of the file carries its filename in the index (as body_tsv always did).
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.attachmentId))).toEqual(new Set([att.id]));
  });

  it('a word that is not there finds nothing', async () => {
    const att = await save();
    expect(await search(['electrician'], [att.id])).toEqual([]);
  });

  it('only searches the candidate files it is given', async () => {
    const a = await save({ filename: 'a.txt', text: 'The zebrafish tour is on Monday.' });
    const b = await save({ filename: 'b.txt', text: 'The zebrafish tour is on Tuesday.' });
    expect((await search(['zebrafish'], [a.id])).map((h) => h.attachmentId)).toEqual([a.id]);
    const both = await search(['zebrafish'], [a.id, b.id]);
    expect(new Set(both.map((h) => h.attachmentId))).toEqual(new Set([a.id, b.id]));
  });

  it('searches files of DIFFERENT owners in one call, each under its own key', async () => {
    const other = (await createGroup(db, { name: 'Trip', kind: 'group', createdBy: userId })).id;
    dirs.push(path.join(env.FILES_DIR, 'group', other));
    const a = await save({ group: groupId, filename: 'a.txt', text: 'The zebrafish tour is on Monday.' });
    const b = await save({ group: other, filename: 'b.txt', text: 'The zebrafish tour is on Tuesday.' });

    const hits = await search(['zebrafish'], [a.id, b.id]);

    expect(new Set(hits.map((h) => h.attachmentId))).toEqual(new Set([a.id, b.id]));
  });

  it('one group’s words do not match another group’s file (different keys)', async () => {
    const other = (await createGroup(db, { name: 'Trip', kind: 'group', createdBy: userId })).id;
    dirs.push(path.join(env.FILES_DIR, 'group', other));
    await save({ group: groupId, filename: 'a.txt', text: 'The zebrafish tour is on Monday.' });
    const b = await save({ group: other, filename: 'b.txt', text: 'Nothing relevant in here.' });
    expect(await search(['zebrafish'], [b.id])).toEqual([]);
  });

  it('the bot’s per-turn retrieval finds and excerpts the file', async () => {
    const att = await save();
    const out = await selectExcerptsForTurn(db, {
      groupId,
      triggeringUserId: userId,
      triggerText: 'what time is pickup on friday',
    });
    const hit = out.find((r) => r.id === att.id);
    expect(hit).toBeDefined();
    expect(hit!.excerpts.length).toBeGreaterThan(0);
    expect(hit!.excerpts.map((e) => e.snippet).join(' ')).toContain('«');
  });
});

describe('a copy and an edit', () => {
  it('a copy shared into another group is sealed and indexed under THAT group', async () => {
    const other = (await createGroup(db, { name: 'Trip', kind: 'group', createdBy: userId })).id;
    dirs.push(path.join(env.FILES_DIR, 'group', other));
    const src = await save();

    const copy = await copyAttachmentToGroup(db, (await getAttachment(db, src.id))!, other, userId);

    const row = await raw.selectFrom('attachments').select(['extracted_text']).where('id', '=', copy.id).executeTakeFirstOrThrow();
    expect(sealedOwner(row.extracted_text!)).toBe(other);
    const chunk = await sql<{ content: string }>`SELECT content FROM attachment_chunks WHERE attachment_id = ${copy.id} LIMIT 1`.execute(raw);
    expect(sealedOwner(chunk.rows[0]!.content)).toBe(other);
    expect((await search(['swimming'], [copy.id])).length).toBeGreaterThan(0);
    // and the source is untouched
    expect(sealedOwner((await raw.selectFrom('attachments').select('extracted_text').where('id', '=', src.id).executeTakeFirstOrThrow()).extracted_text!)).toBe(groupId);
  });

  it('the value returned for a copy is readable, not ciphertext', async () => {
    const other = (await createGroup(db, { name: 'Trip', kind: 'group', createdBy: userId })).id;
    dirs.push(path.join(env.FILES_DIR, 'group', other));
    const src = await save();
    const copy = await copyAttachmentToGroup(db, (await getAttachment(db, src.id))!, other, userId);
    expect(copy.extractedText).toBe(TEXT);
  });

  it('editing tags reseals the summary and the image metadata', async () => {
    const att = await save();
    await patchAttachmentMeta(db, att.id, { tags: ['school', 'calendar'] });

    const row = await raw.selectFrom('attachments').select(['summary', 'image_meta']).where('id', '=', att.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.summary)).toBe(true);
    expect(isSealedText(row.image_meta)).toBe(true);
    const read = await getAttachment(db, att.id);
    expect(read?.summary).toContain('Tags: school, calendar');
    expect(read?.imageMeta?.tags).toEqual(['school', 'calendar']);
    expect(await dump('attachments')).not.toContain('calendar, school');
  });

  it('deleting the file takes its chunks with it', async () => {
    const att = await save();
    await raw.deleteFrom('attachments').where('id', '=', att.id).execute();
    await sql`DELETE FROM attachment_chunks WHERE attachment_id = ${att.id}`.execute(raw);
    expect(await search(['swimming'], [att.id])).toEqual([]);
  });
});

describe('a mailbox of files that predates encryption', () => {
  async function legacyAttachment(): Promise<string> {
    setContentEncryption(false);
    const id = newId('a');
    const now = new Date().toISOString();
    await raw
      .insertInto('attachments')
      .values({
        id,
        scope_kind: 'group',
        scope_id: groupId,
        uploaded_by: userId,
        filename: 'old-calendar.txt',
        mime_type: 'text/plain',
        size: 10,
        path: `group/${groupId}/${id}/old-calendar.txt`,
        summary: 'An old calendar',
        extracted_text: TEXT,
        image_meta: null,
        pinned: 0,
        indexed_at: now,
        created_at: now,
      })
      .execute();
    // As the old indexer wrote it: plaintext content, no blind index.
    await sql`INSERT INTO attachment_chunks (attachment_id, chunk_idx, kind, filename, content)
              VALUES (${id}, 0, 'text', 'old-calendar.txt', ${'Bring the swimming kit on Thursday.'})`.execute(raw);
    setContentEncryption(true);
    return id;
  }

  it('is found through the old index while the legacy flag is on', async () => {
    const id = await legacyAttachment();
    legacy.CONTENT_LEGACY_TSV = true;
    expect((await search(['swimming'], [id])).map((h) => h.attachmentId)).toEqual([id]);
  });

  it('is not found once the legacy flag is off, until the backfill has run', async () => {
    const id = await legacyAttachment();
    expect(await search(['swimming'], [id])).toEqual([]);

    await sealExistingDerived(db);

    expect((await search(['swimming'], [id])).map((h) => h.attachmentId)).toEqual([id]);
    const c = await sql<{ content: string }>`SELECT content FROM attachment_chunks WHERE attachment_id = ${id}`.execute(raw);
    expect(isSealedText(c.rows[0]!.content)).toBe(true);
  });

  it('a sealed chunk is never matched through the legacy predicate', async () => {
    const att = await save();
    legacy.CONTENT_LEGACY_TSV = true;
    const c = await sql<{ content: string }>`SELECT content FROM attachment_chunks WHERE attachment_id = ${att.id} LIMIT 1`.execute(raw);
    const fragment = c.rows[0]!.content.split('.')[3]!.slice(10, 16).toLowerCase();
    expect(await search([fragment], [att.id])).toEqual([]);
  });

  it('re-indexing an attachment replaces its chunks, sealed, with no duplicates', async () => {
    const att = await save();
    const before = await sql<{ n: string }>`SELECT count(*)::text AS n FROM attachment_chunks WHERE attachment_id = ${att.id}`.execute(raw);
    await indexAttachmentChunks(db, att.id);
    const after = await sql<{ n: string }>`SELECT count(*)::text AS n FROM attachment_chunks WHERE attachment_id = ${att.id}`.execute(raw);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('when the owner is erased', () => {
  it('the chunks can no longer be opened and search neither throws nor leaks', async () => {
    const att = await save();
    const { store, keys } = contentCrypto();
    await store.destroy(keys, groupId);

    const hits = await search(['swimming'], [att.id]);

    expect(hits).toEqual([]);
    expect(await dump('attachment_chunks')).not.toContain('swimming');
  });
});
