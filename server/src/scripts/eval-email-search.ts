/**
 * Email search eval against a REAL embedding model (ADR 0276).
 *
 * The vitest eval uses a stand-in embedder that only proves the plumbing. This
 * seeds the same labelled mailbox, embeds it with the configured model, and
 * prints keyword-only and blended scores side by side, so a model or threshold
 * change can be judged on numbers. Everything happens inside a transaction
 * that is rolled back; the dev database keeps only an unused content key.
 *
 * Usage (PowerShell), with OpenRouter as in prod:
 *   $env:EMBEDDINGS_ENABLED="true"; $env:LLM_PROVIDER="openai"
 *   $env:OPENAI_BASE_URL="https://openrouter.ai/api/v1"; $env:OPENAI_API_KEY="sk-or-..."
 *   npm run eval:email-search --workspace=server
 */
import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { applyMigrations } from '../db/migrate.js';
import { createGroup } from '../services/groups.service.js';
import { getEmbedderForUser } from '../services/llm/embeddings.js';
import { runEmbedPass } from '../services/search/embed-pass.js';
import { EMAIL_QUERIES, ME, seedEmailCorpus } from '../services/search/eval/email-corpus.js';
import { formatEmailEval, scoreEmailEval, type EmailQueryResult } from '../services/search/eval/email-eval.js';
import { __resetSemanticCachesForTests } from '../services/search/semantic.js';
import { searchEverything } from '../services/search.service.js';
import { newId } from '../utils/ids.js';

class Rollback extends Error {}

async function main(): Promise<void> {
  if (!env.EMBEDDINGS_ENABLED) throw new Error('Set EMBEDDINGS_ENABLED=true to measure meaning search.');
  const db = openDb();
  try {
    await applyMigrations(db);
    try {
      await db.transaction().execute(async (trx) => {
        const userId = newId('u');
        await trx
          .insertInto('users')
          .values({ id: userId, username: userId, display_name: 'Eval', email: ME, created_at: new Date().toISOString(), shadow: 0 })
          .execute();
        const groupId = (await createGroup(trx, { name: 'Personal', kind: 'personal', createdBy: userId })).id;
        const keyOf = await seedEmailCorpus(trx, userId);

        const run = async (label: string) => {
          const results: EmailQueryResult[] = [];
          for (const q of EMAIL_QUERIES) {
            const res = await searchEverything(trx, { userId, groupId, crossGroup: true, query: q.query, categories: ['emails'], perCategory: 10 });
            results.push({ query: q, ranked: res.emails.map((e) => keyOf.get(e.id) ?? e.id) });
          }
          const misses = results.filter((r) => !r.ranked.slice(0, 3).some((k) => r.query.relevant.includes(k)));
          console.log(`\n── ${label}\n${formatEmailEval(scoreEmailEval(results), misses)}`);
        };

        const flags = env as { EMBEDDINGS_ENABLED: boolean };
        flags.EMBEDDINGS_ENABLED = false;
        await run('keyword only');
        flags.EMBEDDINGS_ENABLED = true;
        const embedder = await getEmbedderForUser(trx, userId);
        if (!embedder) throw new Error('No embedder: set EMBEDDINGS_API_KEY or an OpenAI-compatible LLM_PROVIDER key.');
        const t0 = Date.now();
        const pass = await runEmbedPass(trx, userId);
        console.log(`\nembedded ${pass.threads} threads with ${embedder.id} in ${Date.now() - t0} ms`);
        __resetSemanticCachesForTests();
        await run(`blended (${embedder.id}, min similarity ${env.SEARCH_SEMANTIC_MIN_SIM})`);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  logger.error('email search eval failed', { err });
  process.exit(1);
});
