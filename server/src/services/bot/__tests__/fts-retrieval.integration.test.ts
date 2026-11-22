/**
 * ADR 0021 — attachment chunk index (FTS5 in SQLite; tsvector + GIN
 * in Postgres, per ADR 0038).
 *
 * Verifies the retrieval shape end-to-end against the test Postgres:
 * indexer chunks the right things, ts_rank_cd picks the right
 * paragraph, the visibility filter still gates results, the empty-
 * keyword path falls back to pinned, and the migration backfill is
 * idempotent. The unit-level scoring formula tests in retrieval.test.ts
 * still cover the no-keywords / pinned fallback path.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  chunkText,
  indexAttachmentChunks,
  searchAttachmentChunks,
} from '@/services/attachments.index.js';
import { selectExcerptsForTurn } from '@/services/bot/retrieval.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function seedGroup(
  db: Kysely<DB>,
  name = 'Fam',
): Promise<{ userId: string; groupId: string }> {
  const userId = await createUser(db, name.toLowerCase());
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name,
      kind: 'group',
      invite_code: newId('c').slice(0, 6).toUpperCase(),
      ingest_email: `${name.toLowerCase()}-${groupId.slice(2, 8)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  await addMember(db, groupId, userId, 'owner');
  return { userId, groupId };
}

async function insertAttachment(
  db: Kysely<DB>,
  opts: {
    scopeKind: 'group' | 'user';
    scopeId: string;
    uploadedBy: string;
    filename: string;
    extractedText?: string;
    summary?: string;
    pinned?: boolean;
    indexed?: boolean;
  },
): Promise<string> {
  const id = newId('a');
  const now = new Date().toISOString();
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: opts.scopeKind,
      scope_id: opts.scopeId,
      uploaded_by: opts.uploadedBy,
      filename: opts.filename,
      mime_type: 'application/pdf',
      size: 1000,
      path: `tests/${id}.pdf`,
      summary: opts.summary ?? null,
      extracted_text: opts.extractedText ?? null,
      image_meta: null,
      pinned: opts.pinned ? 1 : 0,
      indexed_at: opts.indexed === false ? null : now,
      created_at: now,
    })
    .execute();
  if (opts.indexed !== false) {
    await indexAttachmentChunks(db, id);
  }
  return id;
}

const FIVE_PARAGRAPH_PDF = [
  'This document covers the spring schedule for our family. The cover page is intentionally generic.',
  '',
  'Section one: piano lessons run every Tuesday at 4pm in the studio downtown.',
  '',
  'Section two: art class is held on Thursdays after school at the community center.',
  '',
  'Section three: the soccer game on May 15 starts at 3:45pm at Greenwood Field. Bring water and shin guards.',
  '',
  'Section four: PTA meetings happen monthly; the next is May 22 at 7pm in the school library.',
].join('\n');

describe('chunkText', () => {
  it('splits on blank lines and drops empty paragraphs', () => {
    const chunks = chunkText('para one\n\n  \n\npara two');
    expect(chunks.map((c) => c.content)).toEqual(['para one', 'para two']);
  });

  it('further splits paragraphs longer than maxWords', () => {
    const long = Array.from({ length: 250 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(long, 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.content.split(/\s+/).length).toBeLessThanOrEqual(100);
    }
  });

  it('returns empty for whitespace-only input', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('FTS5 attachment retrieval (ADR 0021)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('ranks the matching paragraph above the cover page', async () => {
    const { userId, groupId } = await seedGroup(db);
    const attId = await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'spring-schedule.pdf',
      summary: 'Spring schedule for the kids',
      extractedText: FIVE_PARAGRAPH_PDF,
    });

    const hits = await searchAttachmentChunks(db, {
      keywords: ['soccer'],
      candidateIds: [attId],
      limit: 6,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.toLowerCase()).toContain('soccer');
    // The match marker is present.
    expect(hits[0]!.snippet).toMatch(/«[^»]*»/);
  });

  it('selectExcerptsForTurn surfaces the right paragraph as an excerpt', async () => {
    const { userId, groupId } = await seedGroup(db);
    await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'spring-schedule.pdf',
      summary: 'Spring schedule for the kids',
      extractedText: FIVE_PARAGRAPH_PDF,
    });

    const result = await selectExcerptsForTurn(db, {
      groupId,
      triggeringUserId: userId,
      triggerText: '@Chord what time is the soccer game?',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.excerpts.length).toBeGreaterThan(0);
    const allSnippets = result[0]!.excerpts.map((e) => e.snippet.toLowerCase()).join(' | ');
    expect(allSnippets).toContain('soccer');
  });

  it('respects scope visibility — file in another group is not returned', async () => {
    const { userId: outsider } = await seedGroup(db, 'Outside');
    const { userId: aliceA, groupId: groupA } = await seedGroup(db, 'GroupA');
    await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupA,
      uploadedBy: aliceA,
      filename: 'private-soccer-doc.pdf',
      extractedText: 'soccer schedule confidential',
    });

    // Outsider asks the same question in their own group; they're not a
    // member of groupA, so the FTS hit must be filtered out.
    const { groupId: groupOutside } = await seedGroup(db, 'OutsideGroup');
    const result = await selectExcerptsForTurn(db, {
      groupId: groupOutside,
      triggeringUserId: outsider,
      triggerText: 'what about soccer?',
    });
    expect(result).toEqual([]);
  });

  it('indexes vision-derived caption + keyFacts on images', async () => {
    const { userId, groupId } = await seedGroup(db);
    const id = newId('a');
    const now = new Date().toISOString();
    // Image-style row: no extracted_text, but image_meta has caption +
    // keyFacts + (intentionally noisy) ocr. The user's question keyword
    // ("UA127") should hit the keyFacts chunk even though OCR is garbage.
    await db
      .insertInto('attachments')
      .values({
        id,
        scope_kind: 'group',
        scope_id: groupId,
        uploaded_by: userId,
        filename: 'boarding-pass.jpg',
        mime_type: 'image/jpeg',
        size: 1000,
        path: `tests/${id}.jpg`,
        summary: null,
        extracted_text: null,
        image_meta: JSON.stringify({
          caption: 'United Airlines boarding pass for Seattle to JFK on May 12',
          keyFacts: ['Flight UA127', 'Departs SEA 8:30am', 'Confirmation ABC123'],
          ocrText: 'UA1 27 BO ARDING noisy ocr garble',
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
          ocrChars: 33,
        }),
        pinned: 0,
        indexed_at: now,
        created_at: now,
      })
      .execute();
    await indexAttachmentChunks(db, id);

    const hits = await searchAttachmentChunks(db, {
      keywords: ['UA127'],
      candidateIds: [id],
      limit: 6,
    });
    expect(hits.length).toBeGreaterThan(0);
    // Top hit comes from one of the vision-derived columns, not OCR.
    expect(['caption', 'keyfacts']).toContain(hits[0]!.kind);
  });

  it('falls back to pinned files when the trigger has no usable keywords', async () => {
    const { userId, groupId } = await seedGroup(db);
    const pinnedId = await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'pinned-handbook.pdf',
      summary: 'Always-on family handbook',
      extractedText: 'handbook contents here',
      pinned: true,
    });
    await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'unrelated.pdf',
      extractedText: 'random text',
    });

    // Empty / stop-word-only trigger.
    const result = await selectExcerptsForTurn(db, {
      groupId,
      triggeringUserId: userId,
      triggerText: 'hi',
    });
    expect(result.map((r) => r.id)).toEqual([pinnedId]);
    expect(result[0]!.excerpts).toEqual([]);
  });

  it('indexAttachmentChunks is idempotent — re-indexing replaces, never duplicates', async () => {
    const { userId, groupId } = await seedGroup(db);
    const attId = await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'doc.pdf',
      extractedText: 'paragraph one\n\nparagraph two',
    });

    const countMeta = async (): Promise<number> => {
      const r = await db
        .selectFrom('attachment_chunk_meta')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('attachment_id', '=', attId)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    };

    const first = await countMeta();
    await indexAttachmentChunks(db, attId);
    await indexAttachmentChunks(db, attId);
    const after = await countMeta();
    expect(after).toBe(first);
  });

  it('filename hits rank above pure body hits', async () => {
    const { userId, groupId } = await seedGroup(db);
    const filenameAtt = await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'soccer-roster.pdf',
      extractedText: 'just a roster of kids — no other keywords here',
    });
    await insertAttachment(db, {
      scopeKind: 'group',
      scopeId: groupId,
      uploadedBy: userId,
      filename: 'unrelated-doc.pdf',
      extractedText: 'paragraph mentions soccer once in passing',
    });

    const all = await db
      .selectFrom('attachments')
      .select('id')
      .where('scope_kind', '=', 'group')
      .where('scope_id', '=', groupId)
      .execute();
    const hits = await searchAttachmentChunks(db, {
      keywords: ['soccer'],
      candidateIds: all.map((r) => r.id),
      limit: 6,
    });
    expect(hits[0]!.attachmentId).toBe(filenameAtt);
  });
});
