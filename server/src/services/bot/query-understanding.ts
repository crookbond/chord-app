/**
 * ADR 0021 Tier-2 — LLM query understanding for retrieval.
 *
 *   expandQuery  — turn a natural question into extra search keywords/synonyms
 *                  so lexical FTS matches documents that use different words.
 *   rerankByLlm  — reorder a shortlist of chunk hits by true relevance to the
 *                  question (a cheap cross-encoder stand-in).
 *
 * Both are best-effort: any failure returns a safe fallback so retrieval still
 * works without the LLM. They take an `LlmService` so callers control which
 * provider/key is used (and so the eval script can pass a real one).
 */
import { parseJsonArray } from '../../utils/json-repair.js';
import { logger } from '../../config/logging.js';
import type { LlmService } from '../llm/types.js';

/**
 * Extra single-word search terms (synonyms, entities, likely doc vocabulary)
 * for a question. Returns lowercased words only — phrases are split — so they
 * drop straight into the tsquery builder.
 */
export async function expandQuery(llm: LlmService, question: string): Promise<string[]> {
  if (!question.trim()) return [];
  try {
    const raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            'Given a user question, list 6–12 search keywords likely to appear in a document that answers it — ' +
            'include synonyms and the formal terms a document would use (e.g. question "shots" → "vaccine, immunization, mmr"). ' +
            'Single words only, lowercase. Return ONLY a JSON array of strings.',
        },
        { role: 'user', content: question },
      ],
      { maxTokens: 200, temperature: 0.2 },
    );
    const arr = parseJsonArray(raw);
    if (!arr) return [];
    const words = arr
      .flatMap((t) => String(t).toLowerCase().split(/[^a-z0-9]+/))
      .map((w) => w.trim())
      .filter((w) => w.length >= 3);
    return Array.from(new Set(words));
  } catch (err) {
    logger.warn('expandQuery failed', { err });
    return [];
  }
}

export interface RerankCandidate {
  id: string;
  /** A short, human-readable snippet/summary of the candidate. */
  text: string;
}

/**
 * Reorder candidates by relevance to the question. Returns ids best-first.
 * Falls back to the input order on any failure, and always preserves the full
 * candidate set (unranked ids are appended in their original order).
 */
export async function rerankByLlm(
  llm: LlmService,
  question: string,
  candidates: RerankCandidate[],
): Promise<string[]> {
  const inputOrder = candidates.map((c) => c.id);
  if (candidates.length <= 1) return inputOrder;
  try {
    const numbered = candidates
      .map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
    const raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            'Rank the numbered candidates by how well each answers the question, most relevant first. ' +
            'Return ONLY a JSON array of the candidate numbers in ranked order, e.g. [3,1,2]. ' +
            'Include every number exactly once.',
        },
        { role: 'user', content: `Question: ${question}\n\nCandidates:\n${numbered}` },
      ],
      { maxTokens: 120, temperature: 0 },
    );
    const arr = parseJsonArray(raw);
    if (!arr) return inputOrder;
    const order: string[] = [];
    const seen = new Set<string>();
    for (const n of arr) {
      const idx = Number(n) - 1;
      const id = candidates[idx]?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    for (const id of inputOrder) if (!seen.has(id)) order.push(id);
    return order;
  } catch (err) {
    logger.warn('rerankByLlm failed', { err });
    return inputOrder;
  }
}
