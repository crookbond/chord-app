/**
 * ADR 0244, against a real model: the potluck email and a dated email from
 * the 2026-10-12 recording, through the production extractor.
 *
 * Skipped unless MAGICS_LIVE=1 and an OpenAI-compatible key is set, since it
 * spends real calls. Run from `server/`:
 *
 *   MAGICS_LIVE=1 OPENAI_API_KEY=… [OPENAI_BASE_URL=…] [OPENAI_MODEL=…] \
 *     npx vitest run src/services/email/__tests__/magics-demo-recording.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { capSuggestions, llmExtractor, type EmailSuggestion } from '@/services/email/magics.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import { offsetForLocalDatetime, reanchorNowStampedOffset } from '@/utils/tz.js';

const TZ = 'America/New_York';
const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;

describe.skipIf(!live)('magics extractor, live model: the recorded emails', () => {
  const provider = env.LLM_PROVIDER;
  beforeAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
  });
  afterAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
  });

  const extract = async (subject: string, body: string): Promise<EmailSuggestion[]> =>
    capSuggestions(
      await llmExtractor().extract({
        subject,
        snippet: body.slice(0, 100),
        bodyText: body,
        categoryTitle: null,
        userTz: TZ,
        emailSentAt: new Date().toISOString(),
        interactive: true,
      }),
    );

  it('potluck: the things to bring are a list of separate entries, with no to-do repeating them', async () => {
    const found = await extract(
      'Potluck on Sunday - what to bring',
      'For the block potluck this Sunday at noon, could you bring paper plates, a fruit salad, and two bottles of sparkling water? Everyone else has mains covered. Thanks, Priya',
    );
    console.log('[live] potluck:', JSON.stringify(found));
    const entries = found.filter((s) => s.kind === 'list');
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(found.filter((s) => s.kind === 'task' && /bring/i.test(s.title))).toEqual([]);
  }, 60_000);

  it('a time on the far side of a clock change carries that date\'s offset once staged', async () => {
    // Ten days past the next change, whichever way it goes.
    const today = offsetForLocalDatetime(TZ, `${new Date().toISOString().slice(0, 10)}T08:15:00`);
    let d = new Date();
    for (let i = 1; i < 300; i++) {
      d = new Date(Date.now() + i * 86_400_000);
      if (offsetForLocalDatetime(TZ, `${d.toISOString().slice(0, 10)}T08:15:00`) !== today) break;
    }
    d = new Date(d.getTime() + 10 * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const pretty = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const found = await extract(
      'Conference slot confirmed',
      `Your parent-teacher conference is confirmed for ${pretty} at 8:15 AM in Room 12. Please arrive five minutes early.`,
    );
    console.log('[live] conference:', JSON.stringify(found));
    const event = found.find((s) => s.kind === 'event');
    expect(event && event.kind === 'event').toBe(true);
    if (event?.kind !== 'event') return;
    // What extractAndStage does to the model's time before staging it.
    expect(reanchorNowStampedOffset(event.startsAt, TZ)).toBe(
      `${day}T08:15:00${offsetForLocalDatetime(TZ, `${day}T08:15:00`)}`,
    );
  }, 60_000);
});
