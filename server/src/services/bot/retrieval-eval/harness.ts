/**
 * Retrieval eval harness. Seeds the labeled corpus into a test DB, runs a
 * pluggable retrieval pipeline over every query, and scores hit@1 / hit@3 /
 * MRR (plus a paraphrase-only breakdown). Keeps relevance changes measurable:
 * each Tier-1/Tier-2 improvement is a new pipeline scored against the same set.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { createUser } from '../../../__test-helpers__/db.js';
import { indexAttachmentChunks } from '../../attachments.index.js';
import { CORPUS, QUERIES, type CorpusDoc, type EvalQuery } from './corpus.js';

export interface RetrievalPipeline {
  name: string;
  /** Return candidate attachment ids ranked best-first for the query. */
  retrieve(db: Kysely<DB>, query: string, candidateIds: string[]): Promise<string[]>;
}

/**
 * Insert the corpus as indexed attachments. Returns the candidate id list.
 * `withQuestions: false` omits the Tier-2 answerable-questions chunk so the
 * eval can measure the lift it provides.
 */
export async function seedCorpus(
  db: Kysely<DB>,
  opts: { docs?: CorpusDoc[]; withQuestions?: boolean } = {},
): Promise<string[]> {
  const docs = opts.docs ?? CORPUS;
  const withQuestions = opts.withQuestions ?? true;
  const uploader = await createUser(db); // unique id — seedable more than once per test
  const now = new Date().toISOString();
  for (const d of docs) {
    await db
      .insertInto('attachments')
      .values({
        id: d.key,
        scope_kind: 'group',
        scope_id: 'g_eval',
        uploaded_by: uploader,
        filename: d.filename,
        mime_type: d.mimeType,
        size: Math.max(1, d.extractedText.length),
        path: `eval/${d.key}`,
        summary: d.summary,
        extracted_text: d.extractedText || null,
        image_meta: d.imageMeta ?? null,
        answerable_questions:
          withQuestions && d.answerableQuestions?.length
            ? d.answerableQuestions.join('\n')
            : null,
        pinned: 0,
        indexed_at: now,
        index_requested: 1,
        created_at: now,
      })
      .execute();
    await indexAttachmentChunks(db, d.key);
  }
  return docs.map((d) => d.key);
}

export function hitAtK(ranked: string[], expected: string[], k: number): number {
  const top = ranked.slice(0, k);
  return expected.some((e) => top.includes(e)) ? 1 : 0;
}

export function reciprocalRank(ranked: string[], expected: string[]): number {
  for (let i = 0; i < ranked.length; i++) {
    if (expected.includes(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export interface PerQueryResult {
  query: string;
  expected: string[];
  ranked: string[];
  rr: number;
  paraphrase: boolean;
}

export interface EvalMetrics {
  pipeline: string;
  n: number;
  hit1: number;
  hit3: number;
  mrr: number;
  /** hit@3 restricted to paraphrased queries — the synonym/intent stress set. */
  paraphraseHit3: number;
  perQuery: PerQueryResult[];
}

export async function runEval(
  db: Kysely<DB>,
  pipeline: RetrievalPipeline,
  candidateIds: string[],
  queries: EvalQuery[] = QUERIES,
): Promise<EvalMetrics> {
  const per: PerQueryResult[] = [];
  for (const q of queries) {
    const ranked = await pipeline.retrieve(db, q.query, candidateIds);
    per.push({
      query: q.query,
      expected: q.expected,
      ranked,
      rr: reciprocalRank(ranked, q.expected),
      paraphrase: !!q.paraphrase,
    });
  }
  const avg = (f: (p: PerQueryResult) => number, rows: PerQueryResult[]): number =>
    rows.length ? rows.reduce((a, p) => a + f(p), 0) / rows.length : 0;
  const para = per.filter((p) => p.paraphrase);
  return {
    pipeline: pipeline.name,
    n: per.length,
    hit1: avg((p) => hitAtK(p.ranked, p.expected, 1), per),
    hit3: avg((p) => hitAtK(p.ranked, p.expected, 3), per),
    mrr: avg((p) => p.rr, per),
    paraphraseHit3: avg((p) => hitAtK(p.ranked, p.expected, 3), para),
    perQuery: per,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

/** One-line metrics summary for logs / the eval script table. */
export function formatMetricsRow(m: EvalMetrics): string {
  return (
    `${m.pipeline.padEnd(22)} ` +
    `hit@1 ${pct(m.hit1).padStart(4)}  ` +
    `hit@3 ${pct(m.hit3).padStart(4)}  ` +
    `MRR ${m.mrr.toFixed(3)}  ` +
    `paraphrase hit@3 ${pct(m.paraphraseHit3).padStart(4)}`
  );
}
