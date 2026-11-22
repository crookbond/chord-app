/**
 * Retrieval pipelines under evaluation. Each maps a query to a ranked list of
 * candidate attachment ids. They share the same scoring harness so we can read
 * the relevance lift of each improvement directly.
 *
 *   baseline  — today's path: extractKeywords → searchAttachmentChunks (FTS).
 *
 * Tier-1 / Tier-2 pipelines are appended here as they land.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { searchAttachmentChunks } from '../../attachments.index.js';
import { extractKeywords } from '../retrieval.js';
import { expandQuery, rerankByLlm } from '../query-understanding.js';
import type { LlmService } from '../../llm/types.js';
import type { RetrievalPipeline } from './harness.js';

/** Group ranked chunk hits down to first-seen attachment order. */
function chunksToAttachmentOrder(hits: { attachmentId: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.attachmentId)) continue;
    seen.add(h.attachmentId);
    out.push(h.attachmentId);
  }
  return out;
}

export const baselinePipeline: RetrievalPipeline = {
  name: 'baseline-fts',
  async retrieve(db: Kysely<DB>, query: string, candidateIds: string[]): Promise<string[]> {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];
    const hits = await searchAttachmentChunks(db, { keywords, candidateIds, limit: 10 });
    return chunksToAttachmentOrder(hits);
  },
};

/** Tier 1: coordination + per-kind weighting in the FTS re-rank. */
export const weightedPipeline: RetrievalPipeline = {
  name: 'tier1-weighted',
  async retrieve(db: Kysely<DB>, query: string, candidateIds: string[]): Promise<string[]> {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];
    const hits = await searchAttachmentChunks(db, {
      keywords,
      candidateIds,
      limit: 10,
      ranking: 'weighted',
    });
    return chunksToAttachmentOrder(hits);
  },
};

/** All pipelines that run without a live LLM (deterministic, gate-safe). */
export const DETERMINISTIC_PIPELINES: RetrievalPipeline[] = [baselinePipeline, weightedPipeline];

// ── LLM-assisted pipelines (Tier 2) — need a live provider; scored by the eval
//    script, not the mock gate. Built as factories so the script injects the LLM.

/** Tier 2a: expand the query with LLM synonyms, then weighted FTS. */
export function expansionPipeline(llm: LlmService): RetrievalPipeline {
  return {
    name: 'tier2-expansion',
    async retrieve(db: Kysely<DB>, query: string, candidateIds: string[]): Promise<string[]> {
      const base = extractKeywords(query);
      const extra = await expandQuery(llm, query);
      const keywords = Array.from(new Set([...base, ...extra]));
      if (keywords.length === 0) return [];
      const hits = await searchAttachmentChunks(db, {
        keywords,
        candidateIds,
        limit: 10,
        ranking: 'weighted',
      });
      return chunksToAttachmentOrder(hits);
    },
  };
}

/** Tier 2b: weighted FTS shortlist, then LLM re-rank of the top chunks. */
export function rerankPipeline(llm: LlmService): RetrievalPipeline {
  return {
    name: 'tier2-rerank',
    async retrieve(db: Kysely<DB>, query: string, candidateIds: string[]): Promise<string[]> {
      const keywords = extractKeywords(query);
      if (keywords.length === 0) return [];
      const hits = await searchAttachmentChunks(db, {
        keywords,
        candidateIds,
        limit: 15,
        ranking: 'weighted',
      });
      // One candidate per attachment (best chunk), then let the LLM reorder.
      const byAtt = new Map<string, string>();
      for (const h of hits) if (!byAtt.has(h.attachmentId)) byAtt.set(h.attachmentId, h.snippet);
      const candidates = [...byAtt].map(([id, text]) => ({ id, text }));
      return rerankByLlm(llm, query, candidates);
    },
  };
}
