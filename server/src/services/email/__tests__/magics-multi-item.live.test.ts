/**
 * ADR 0243, against a real model: one short email holding two confirmed
 * times and two things to do must come back as two events and two to-dos.
 *
 * Skipped unless MAGICS_LIVE=1 and an OpenAI-compatible key is set, since it
 * spends a real call. Run from `server/`:
 *
 *   MAGICS_LIVE=1 OPENAI_API_KEY=… [OPENAI_BASE_URL=…] [OPENAI_MODEL=…] \
 *     npx vitest run src/services/email/__tests__/magics-multi-item.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { llmExtractor, type EmailSuggestion } from '@/services/email/magics.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import { offsetForLocalDatetime } from '@/utils/tz.js';

const TZ = 'America/New_York';
const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;

/**
 * The most recent Tuesday, today included. Never a future one: the model is
 * also told the real "today", and mail dated after it is a contradiction it
 * resolves by ignoring the sent date.
 */
function lastTuesday(): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
const dayPlus = (base: Date, days: number): string =>
  new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hhmm: string): string =>
  `${day}T${hhmm}:00${offsetForLocalDatetime(TZ, `${day}T${hhmm}:00`)}`;

const BODY =
  "I agree, lets meet for lunch tomorrow at 2p. lets also set time for next week Monday at 4p. In addition, please email Alice to set Ben's doctor appointment. and email Alice if she is free at 3p tomorrow?";

describe.skipIf(!live)('magics extractor, live model: several items in one email', () => {
  const provider = env.LLM_PROVIDER;
  beforeAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
  });
  afterAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
  });

  it('returns two events and two to-dos', async () => {
    const tuesday = lastTuesday();
    const sentDay = dayPlus(tuesday, 0);
    const found = await llmExtractor().extract({
      subject: 'Re: lunch',
      snippet: BODY.slice(0, 100),
      bodyText: BODY,
      categoryTitle: 'Personal',
      userTz: TZ,
      emailSentAt: at(sentDay, '10:00'),
    });
    const items: EmailSuggestion[] = found ? (Array.isArray(found) ? found : [found]) : [];
    console.log(`model=${env.OPENAI_MODEL} sent=${sentDay} (Tuesday)\n${JSON.stringify(items, null, 2)}`);

    const events = items.filter((s) => s.kind === 'event');
    const tasks = items.filter((s) => s.kind === 'task');
    expect(events).toHaveLength(2);
    expect(tasks).toHaveLength(2);

    const starts = events.map((e) => Date.parse(e.startsAt)).sort((a, b) => a - b);
    expect(starts).toEqual([
      Date.parse(at(dayPlus(tuesday, 1), '14:00')), // lunch, Wednesday 2pm
      Date.parse(at(dayPlus(tuesday, 6), '16:00')), // next week Monday 4pm
    ]);
    for (const t of tasks) expect(t.title).toMatch(/alice/i);
    expect(tasks.some((t) => /doctor|appointment/i.test(t.title))).toBe(true);
    expect(tasks.some((t) => /free|3\s*(pm|p\b|:00)/i.test(t.title))).toBe(true);
  }, 60_000);
});
