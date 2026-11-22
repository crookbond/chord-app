/**
 * Retrieval relevance eval (Tier 0). Seeds the labeled corpus, scores each
 * deterministic pipeline on hit@1 / hit@3 / MRR, and prints a comparison table.
 * Assertions are regression floors + a directional check that the Tier-2
 * answerable-questions index lifts paraphrase recall. The LLM-assisted
 * pipelines (query expansion, rerank) are scored by the eval script with a real
 * provider, not here (mock can't expand/rerank).
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';
import {
  formatMetricsRow,
  runEval,
  seedCorpus,
  type EvalMetrics,
} from '@/services/bot/retrieval-eval/harness.js';
import {
  DETERMINISTIC_PIPELINES,
  weightedPipeline,
} from '@/services/bot/retrieval-eval/pipelines.js';

describe('retrieval eval — deterministic pipelines', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('scores each pipeline and holds a regression floor', async () => {
    const candidateIds = await seedCorpus(db); // production-realistic: with questions
    const results: EvalMetrics[] = [];
    for (const p of DETERMINISTIC_PIPELINES) {
      results.push(await runEval(db, p, candidateIds));
    }

    // eslint-disable-next-line no-console
    console.log('\n── retrieval eval ──\n' + results.map(formatMetricsRow).join('\n') + '\n');

    const best = results.reduce((a, b) => (b.hit3 > a.hit3 ? b : a));
    expect(best.hit3).toBeGreaterThanOrEqual(0.6);
    expect(best.mrr).toBeGreaterThanOrEqual(0.5);
  });

  it('Tier-2 answerable-questions index lifts paraphrase recall', async () => {
    // Same docs, same pipeline — only the answerable-questions chunk differs.
    const idsNoQ = await seedCorpus(db, { withQuestions: false });
    const without = await runEval(db, weightedPipeline, idsNoQ);

    await sql`DELETE FROM attachment_chunks`.execute(db);
    await sql`DELETE FROM attachment_chunk_meta`.execute(db);
    await sql`DELETE FROM attachments`.execute(db);

    const idsQ = await seedCorpus(db, { withQuestions: true });
    const withQ = await runEval(db, weightedPipeline, idsQ);

    // eslint-disable-next-line no-console
    console.log(
      '\n── answerable-questions lift ──\n' +
        formatMetricsRow({ ...without, pipeline: 'tier1 (no questions)' }) +
        '\n' +
        formatMetricsRow({ ...withQ, pipeline: 'tier2 (+questions)' }) +
        '\n',
    );

    expect(withQ.paraphraseHit3).toBeGreaterThan(without.paraphraseHit3);
    expect(withQ.hit3).toBeGreaterThanOrEqual(without.hit3);
  });
});
