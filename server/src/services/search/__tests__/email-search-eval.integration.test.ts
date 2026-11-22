/**
 * Email search quality, measured. Each query in the corpus is run through the
 * same `searchEverything` call the bot's `search` tool makes, against mail
 * written through the real sync path with encryption on. The floors below are
 * what search scores today; a change that lowers one has made search worse.
 */
import { Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { searchEverything } from '@/services/search.service.js';
import { runEmbedPass } from '@/services/search/embed-pass.js';
import { __resetSemanticCachesForTests } from '@/services/search/semantic.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

import { EMAIL_QUERIES, ME, seedEmailCorpus } from '../eval/email-corpus.js';
import { formatEmailEval, scoreEmailEval, type EmailQueryResult } from '../eval/email-eval.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let keyOf: Map<string, string>;

beforeAll(async () => {
  legacy.CONTENT_LEGACY_TSV = false;
  db = await openTestDb();
  // After opening: openTestDb sets encryption back to its default.
  setContentEncryption(true);
  userId = await createUser(db, 'evaluser');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
  groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Personal',
      kind: 'personal',
      invite_code: 'EVALSR',
      ingest_email: 'evalsr@chord.app',
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  await addMember(db, groupId, userId, 'owner');
  keyOf = await seedEmailCorpus(db, userId);
  // The point of this eval is a SEALED mailbox: prove it is one.
  const raw = await sql<{ sealed: boolean }>`select bool_and(subject like 'enc1.%') as sealed from email_threads where user_id = ${userId}`.execute(db);
  if (!raw.rows[0]?.sealed) throw new Error('eval mailbox is not sealed');
});

afterAll(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  setContentEncryption(false);
  await closeTestDb(db);
});

async function runEval(): Promise<ReturnType<typeof scoreEmailEval>> {
  const results: EmailQueryResult[] = [];
  for (const q of EMAIL_QUERIES) {
    const res = await searchEverything(db, {
      userId,
      groupId,
      crossGroup: true,
      query: q.query,
      categories: ['emails'],
      perCategory: 10,
    });
    results.push({ query: q, ranked: res.emails.map((e) => keyOf.get(e.id) ?? e.id) });
  }
  const s = scoreEmailEval(results);
  const misses = results.filter((r) => !r.ranked.slice(0, 3).some((k) => r.query.relevant.includes(k)));
  console.log(`
${formatEmailEval(s, misses)}
`);
  return s;
}

describe('email search eval', () => {
  it('keyword search scores at or above the recorded floor', async () => {
    const s = await runEval();
    expect(s.overall.mrr).toBeGreaterThanOrEqual(FLOOR.mrr);
    expect(s.byClass.person.hit3).toBeGreaterThanOrEqual(FLOOR.personHit3);
    expect(s.byClass.person.clean5).toBeGreaterThanOrEqual(FLOOR.personClean5);
    expect(s.byClass.keyword.hit3).toBeGreaterThanOrEqual(FLOOR.keywordHit3);
  });

  // ADR 0276, with the deterministic stand-in embedder: this proves the
  // pipeline (embed, seal, compare, blend) and that blending does not cost the
  // keyword and person classes anything. How good a REAL model is, is measured
  // by `npm run eval:email-search` against the provider.
  it('meaning search lifts paraphrases without costing the other classes', async () => {
    const flags = env as { EMBEDDINGS_ENABLED: boolean };
    flags.EMBEDDINGS_ENABLED = true;
    try {
      __resetSemanticCachesForTests();
      const pass = await runEmbedPass(db, userId);
      expect(pass.threads).toBeGreaterThan(0);
      const s = await runEval();
      expect(s.byClass.paraphrase.hit3).toBeGreaterThanOrEqual(MEANING_FLOOR.paraphraseHit3);
      expect(s.overall.mrr).toBeGreaterThanOrEqual(MEANING_FLOOR.mrr);
      expect(s.byClass.person.clean5).toBe(1);
      expect(s.byClass.keyword.hit3).toBe(1);
    } finally {
      flags.EMBEDDINGS_ENABLED = false;
    }
  });
});

// Baseline before ADR 0270: overall MRR 0.55, person hit@3 0.17 / clean@5 0.50, keyword hit@3 1.00.
// After ADR 0270 (people + filters): MRR 0.82, person hit@3 0.83 / clean@5 1.00.
// After ADR 0271 (ranking): MRR 0.89, context hit@1 1.00.
// After ADR 0275 (roles: "mail from the dentist"): MRR 0.94, person hit@3 1.00.
const FLOOR = { mrr: 0.94, personHit3: 1, personClean5: 1, keywordHit3: 1 };
// With the stand-in embedder, whose synonyms were written for this corpus: a
// pipeline check, not a quality claim (`npm run eval:email-search` measures a
// real model on the same set).
const MEANING_FLOOR = { mrr: 0.95, paraphraseHit3: 1 };
