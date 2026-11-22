/**
 * The email cost benchmark (tokens per thread).
 *
 * The number that matters is `tokensPerThread`, because the passes are not
 * comparable without it: the classifier spends one call on a batch of up to 40
 * threads while magics and person-extraction spend one call each. Raw totals
 * make the batched pass look like the expensive one when it is the cheap one.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { logger } from '@/config/logging.js';
import { trackPassCost } from '@/services/email/pass-cost.js';

const lastLog = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('trackPassCost', () => {
  afterEach(() => vi.restoreAllMocks());

  it('divides a batch call across the threads it covered', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cost = trackPassCost();

    cost.onUsage({ promptTokens: 3800, completionTokens: 200 });
    cost.report({ pass: 'classify', userId: 'u1', threads: 40, model: 'gpt-x', ms: 1200 });

    expect(lastLog(spy)).toMatchObject({
      pass: 'classify',
      threads: 40,
      totalTokens: 4000,
      tokensPerThread: 100,
    });
  });

  it('reports a per-thread pass as its own whole cost', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cost = trackPassCost();

    cost.onUsage({ promptTokens: 900, completionTokens: 100 });
    cost.report({ pass: 'magics', threads: 1, model: 'gpt-x', ms: 800 });

    expect(lastLog(spy)).toMatchObject({ totalTokens: 1000, tokensPerThread: 1000 });
  });

  it('says null, not zero, when the provider reported nothing', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cost = trackPassCost();

    // The mock provider never calls onUsage. "We don't know" and "it was free"
    // are different claims, and a benchmark that conflates them is worse than
    // no benchmark.
    cost.report({ pass: 'magics', threads: 1, model: 'mock', ms: 3 });

    expect(lastLog(spy)).toMatchObject({
      totalTokens: null,
      tokensPerThread: null,
      promptTokens: null,
    });
  });

  it('never divides by zero when a batch was empty', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cost = trackPassCost();

    cost.onUsage({ promptTokens: 10, completionTokens: 0 });
    cost.report({ pass: 'classify', userId: 'u1', threads: 0, model: 'gpt-x', ms: 5 });

    expect(lastLog(spy)!.tokensPerThread).toBeNull();
  });

  it('rounds to a tenth rather than implying false precision', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cost = trackPassCost();

    cost.onUsage({ promptTokens: 1000, completionTokens: 0 });
    cost.report({ pass: 'classify', userId: 'u1', threads: 3, model: 'gpt-x', ms: 5 });

    expect(lastLog(spy)!.tokensPerThread).toBe(333.3);
  });
});
