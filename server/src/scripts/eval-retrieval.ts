/**
 * Retrieval relevance eval — standalone runner (Tier 2 included).
 *
 * Unlike the vitest eval (which forces LLM_PROVIDER=mock), this scores the
 * LLM-assisted pipelines — query expansion and re-rank — against a REAL
 * provider, so you can measure their lift. Seeds the labeled corpus inside a
 * transaction that is rolled back at the end, so your dev database is left
 * untouched.
 *
 * Usage (PowerShell):
 *   $env:LLM_PROVIDER="openai"; $env:OPENAI_API_KEY="sk-..."; npm run eval:retrieval --workspace=server
 * or with Gemini / Anthropic per your factory config.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { applyMigrations } from '../db/migrate.js';
import { getLlm } from '../services/llm/factory.js';
import {
  formatMetricsRow,
  runEval,
  seedCorpus,
  type EvalMetrics,
} from '../services/bot/retrieval-eval/harness.js';
import {
  baselinePipeline,
  weightedPipeline,
  expansionPipeline,
  rerankPipeline,
} from '../services/bot/retrieval-eval/pipelines.js';

class Rollback extends Error {}

async function main(): Promise<void> {
  const db = openDb();
  try {
    await applyMigrations(db); // ensure the answerable_questions column exists
    const llm = getLlm();
    if (env.LLM_PROVIDER === 'mock') {
      logger.warn(
        'LLM_PROVIDER=mock — expansion/rerank will be no-ops. Set a real provider + key to measure Tier-2 lift.',
      );
    }

    const metrics: EvalMetrics[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        const ids = await seedCorpus(trx);
        const pipelines = [
          baselinePipeline,
          weightedPipeline,
          expansionPipeline(llm),
          rerankPipeline(llm),
        ];
        for (const p of pipelines) metrics.push(await runEval(trx, p, ids));
        throw new Rollback(); // discard the seeded corpus, keep the dev DB clean
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    process.stdout.write(
      `\n── retrieval eval (provider: ${env.LLM_PROVIDER}) ──\n` +
        metrics.map(formatMetricsRow).join('\n') +
        '\n\n',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
