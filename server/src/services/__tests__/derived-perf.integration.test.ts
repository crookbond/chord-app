/**
 * The bot reads attachment chunks on every turn, so sealing them must not slow
 * a reply (ADR 0201, phase 4). Two groups of the same size in one database:
 * one indexed the old way (plaintext chunks, generated tsvector), one the new
 * way (sealed chunks, blind index). The same searches run against each, back
 * to back. Ratios need no scaling; absolute ceilings are scaled by machine load.
 */
import { performance } from 'node:perf_hooks';

import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { contentCrypto, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks, searchAttachmentChunks } from '@/services/attachments.index.js';
import { selectExcerptsForTurn } from '@/services/bot/retrieval.js';
import { createGroup } from '@/services/groups.service.js';
import { createProposal, listProposalsForUser } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { scaled } from '@/__test-helpers__/perf.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let raw: Kysely<DB>;
let userId: string;
const FILES = 150;

const TOPICS = ['soccer schedule', 'school calendar', 'dentist appointment', 'flight itinerary', 'permission slip', 'insurance policy'];

function textFor(i: number): string {
  const topic = TOPICS[i % TOPICS.length]!;
  return Array.from({ length: 6 }, (_, p) => `Paragraph ${p} of document ${i} about the ${topic}. ${'Please review the details carefully and reply by Friday. '.repeat(12)}Reference code KX${i}Q${p}.`).join('\n\n');
}

async function makeAttachment(groupId: string, i: number): Promise<string> {
  const id = newId('a');
  const now = new Date().toISOString();
  await raw
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: groupId,
      uploaded_by: userId,
      filename: `doc-${i}.txt`,
      mime_type: 'text/plain',
      size: 100,
      path: `group/${groupId}/${id}/doc-${i}.txt`,
      summary: `A document about ${TOPICS[i % TOPICS.length]}`,
      extracted_text: textFor(i),
      image_meta: null,
      pinned: 0,
      indexed_at: now,
      created_at: now,
    })
    .execute();
  return id;
}

let plainGroup: string;
let sealedGroup: string;
let plainIds: string[];
let sealedIds: string[];

beforeEach(async () => {
  db = await openTestDb();
  raw = contentCrypto().raw;
  userId = await createUser(db, 'alice');
  plainGroup = (await createGroup(db, { name: 'Plain', kind: 'group', createdBy: userId })).id;
  sealedGroup = (await createGroup(db, { name: 'Sealed', kind: 'group', createdBy: userId })).id;
  plainIds = [];
  sealedIds = [];
  setContentEncryption(false);
  for (let i = 0; i < FILES; i++) {
    const id = await makeAttachment(plainGroup, i);
    plainIds.push(id);
    await indexAttachmentChunks(db, id);
  }
  // Written the old way: no blind index, plaintext generated tsvector only.
  await sql`UPDATE attachment_chunks SET blind_words = NULL`.execute(raw);
  setContentEncryption(true);
  for (let i = 0; i < FILES; i++) {
    const id = await makeAttachment(sealedGroup, i);
    sealedIds.push(id);
    // The row was inserted plaintext; seal it under the owner as the write path does.
    const { sealAttachmentText } = await import('@/services/attachments.service.js');
    await raw
      .updateTable('attachments')
      .set(await sealAttachmentText(sealedGroup, { extracted_text: textFor(i), summary: `A document about ${TOPICS[i % TOPICS.length]}` }))
      .where('id', '=', id)
      .execute();
    await indexAttachmentChunks(db, id);
  }
  await sql`ANALYZE attachment_chunks`.execute(raw);
}, 240_000);
afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
});

async function median(runs: number, fn: () => Promise<unknown>): Promise<number> {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  return t.sort((a, b) => a - b)[Math.floor(t.length / 2)]!;
}

const QUERIES: Array<[string, string[]]> = [
  ['a common word', ['review']],
  ['a topic', ['dentist', 'appointment']],
  ['a rare code', ['kx77q3']],
  ['a stemmed word', ['schedules']],
  ['nothing', ['zzqqxxnotaword']],
];

describe('chunk search', () => {
  for (const [label, kw] of QUERIES) {
    it(`sealed against plaintext: ${label}`, async () => {
      legacy.CONTENT_LEGACY_TSV = true;
      await searchAttachmentChunks(db, { keywords: kw, candidateIds: plainIds, limit: 10 });
      const plain = await median(9, () => searchAttachmentChunks(db, { keywords: kw, candidateIds: plainIds, limit: 10 }));
      legacy.CONTENT_LEGACY_TSV = false;
      await searchAttachmentChunks(db, { keywords: kw, candidateIds: sealedIds, limit: 10 });
      const sealed = await median(9, () => searchAttachmentChunks(db, { keywords: kw, candidateIds: sealedIds, limit: 10 }));

      console.log(`PERF chunks "${kw.join(' ')}": plain ${plain.toFixed(1)} ms, sealed ${sealed.toFixed(1)} ms`);
      expect(sealed).toBeLessThan(plain * 3 + scaled(25));
      expect(sealed).toBeLessThan(scaled(200));
    });
  }

  it('finds the same number of chunks in both, before they are timed', async () => {
    for (const [label, kw] of QUERIES) {
      legacy.CONTENT_LEGACY_TSV = true;
      const p = (await searchAttachmentChunks(db, { keywords: kw, candidateIds: plainIds, limit: 50 })).length;
      legacy.CONTENT_LEGACY_TSV = false;
      const s = (await searchAttachmentChunks(db, { keywords: kw, candidateIds: sealedIds, limit: 50 })).length;
      expect(s, `${label}: "${kw.join(' ')}"`).toBe(p);
    }
  });

  it('searching both groups at once costs one query per owner, not one per file', async () => {
    legacy.CONTENT_LEGACY_TSV = false;
    const both = [...plainIds.slice(0, 40), ...sealedIds.slice(0, 40)];
    await searchAttachmentChunks(db, { keywords: ['review'], candidateIds: both, limit: 10 });
    const t = await median(7, () => searchAttachmentChunks(db, { keywords: ['review'], candidateIds: both, limit: 10 }));
    console.log(`PERF chunks across two owners: ${t.toFixed(1)} ms`);
    expect(t).toBeLessThan(scaled(200));
  });
});

describe('the bot’s per-turn retrieval', () => {
  it('sealed adds no more than a small multiple to the work done before every reply', async () => {
    const turn = (groupId: string) =>
      selectExcerptsForTurn(db, { groupId, triggeringUserId: userId, triggerText: 'when is the dentist appointment' });
    legacy.CONTENT_LEGACY_TSV = true;
    await turn(plainGroup);
    const plain = await median(7, () => turn(plainGroup));
    legacy.CONTENT_LEGACY_TSV = false;
    await turn(sealedGroup);
    const sealed = await median(7, () => turn(sealedGroup));

    console.log(`PERF bot retrieval (${FILES} files): plain ${plain.toFixed(1)} ms, sealed ${sealed.toFixed(1)} ms`);
    expect(sealed).toBeLessThan(plain * 3 + scaled(40));
    expect(sealed).toBeLessThan(scaled(300));
  });
});

describe('indexing a file', () => {
  it('sealing and indexing the chunks costs a small multiple of writing them plain', async () => {
    const files = 25;
    const time = async (encrypt: boolean, groupId: string): Promise<number> => {
      setContentEncryption(encrypt);
      const ids: string[] = [];
      for (let i = 0; i < files; i++) ids.push(await makeAttachment(groupId, 1000 + i));
      if (encrypt) {
        const { sealAttachmentText } = await import('@/services/attachments.service.js');
        for (const [i, id] of ids.entries()) {
          await raw.updateTable('attachments').set(await sealAttachmentText(groupId, { extracted_text: textFor(1000 + i) })).where('id', '=', id).execute();
        }
      }
      const t0 = performance.now();
      for (const id of ids) await indexAttachmentChunks(db, id);
      return (performance.now() - t0) / files;
    };
    await time(false, plainGroup); // warm up
    const off = await time(false, plainGroup);
    const on = await time(true, sealedGroup);

    console.log(`PERF index one file (6 chunks): plain ${off.toFixed(1)} ms, sealed ${on.toFixed(1)} ms`);
    expect(on).toBeLessThan(off * 3 + scaled(15));
    expect(on).toBeLessThan(scaled(150));
  });
});

describe('proposals', () => {
  it('opening a list of sealed suggestions costs a few milliseconds more, not tens', async () => {
    const make = async (provenance: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await createProposal(db, { groupId: plainGroup, proposedByUserId: userId, proposedByMessageId: null, toolName: 'create_task', args: { title: `Task ${i} with some longer text about the school`, details: 'x'.repeat(300) }, provenance });
      }
    };
    setContentEncryption(true);
    await make('gmail:t', 60);
    const sealed = await median(9, () => listProposalsForUser(db, userId));
    await raw.deleteFrom('proposals').execute();
    setContentEncryption(false);
    await make('gmail:t', 60);
    const plain = await median(9, () => listProposalsForUser(db, userId));

    console.log(`PERF list 60 suggestions: plain ${plain.toFixed(1)} ms, sealed ${sealed.toFixed(1)} ms`);
    expect(sealed - plain).toBeLessThan(scaled(25));
  });
});
