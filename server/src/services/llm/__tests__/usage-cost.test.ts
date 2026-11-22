/**
 * ADR 0332 — OpenRouter's usage block carries what the call cost and how much
 * of the prompt came from cache. We read only prompt/completion tokens, so
 * there was no way to map our token counts to OpenRouter's dollars.
 */
import { describe, expect, it } from 'vitest';

import { usageFromResponse } from '@/services/llm/openai.service.js';
import { addUsage } from '@/services/llm/types.js';

describe('usageFromResponse', () => {
  it('reads cost and cached tokens from an OpenRouter chat usage block', () => {
    const u = usageFromResponse({
      prompt_tokens: 88_000,
      completion_tokens: 400,
      total_tokens: 88_400,
      cost: 0.01472,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 70_400, cache_write_tokens: 0 },
      cost_details: { upstream_inference_cost: null },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(u).toEqual({ promptTokens: 88_000, completionTokens: 400, cachedTokens: 70_400, costUsd: 0.01472 });
  });

  it('OpenAI direct: a cached count but no cost', () => {
    const u = usageFromResponse({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } });
    expect(u).toEqual({ promptTokens: 50, completionTokens: 5, cachedTokens: 0 });
  });

  it('ignores a missing or malformed cost rather than recording a guess', () => {
    expect(usageFromResponse({ prompt_tokens: 1, completion_tokens: 1, cost: '0.1' })).toEqual({
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(usageFromResponse({ prompt_tokens: 1, completion_tokens: 1, cost: -1, prompt_tokens_details: null })).toEqual({
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(usageFromResponse(undefined)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe('addUsage', () => {
  it('sums every round trip of a turn, cost included', () => {
    let t = addUsage(null, { promptTokens: 10, completionTokens: 1, cachedTokens: 4, costUsd: 0.001 });
    t = addUsage(t, { promptTokens: 20, completionTokens: 2, cachedTokens: 16, costUsd: 0.002 });
    expect(t.promptTokens).toBe(30);
    expect(t.completionTokens).toBe(3);
    expect(t.cachedTokens).toBe(20);
    expect(t.costUsd).toBeCloseTo(0.003, 10);
  });

  it('a cost becomes unknown once any round trip did not report one (a partial sum would read as the whole)', () => {
    const t = addUsage(addUsage(null, { promptTokens: 10, completionTokens: 1, costUsd: 0.001 }), {
      promptTokens: 10,
      completionTokens: 1,
    });
    expect(t.costUsd).toBeUndefined();
    expect(t.promptTokens).toBe(20);
  });

  it('stays without cost or cached fields when nobody reported them', () => {
    expect(addUsage(addUsage(null, { promptTokens: 1, completionTokens: 1 }), { promptTokens: 1, completionTokens: 1 })).toEqual({
      promptTokens: 2,
      completionTokens: 2,
    });
  });
});
