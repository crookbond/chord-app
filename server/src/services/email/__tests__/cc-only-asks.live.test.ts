/**
 * Asks aimed at someone else, against a real model. Two real emails the
 * user received on Cc (2026-11-16), names kept, addresses made up:
 *
 * 1. Jason asks "Ash" for 30 minutes tomorrow morning; Ashton answers that
 *    he is open except 1-2:30pm. The newest message is Ashton's reply.
 * 2. Tom introduces himself and the user ("John Doe, our CFO") to Geoff and
 *    offers three times "that work for John and me". The user is mentioned,
 *    but the ask (pick a time) is Geoff's.
 *
 * Neither should leave the user a to-do, an event or a list item.
 *
 * Skipped unless MAGICS_LIVE=1 and an OpenAI-compatible key is set. From `server/`:
 *
 *   MAGICS_LIVE=1 npx vitest run src/services/email/__tests__/cc-only-asks.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import {
  dropAsksOfOthers,
  llmExtractor,
  participantsLine,
  type EmailSuggestion,
  type ExtractStageBodyRow,
} from '@/services/email/magics.service.js';
import { __resetLlmCacheForTests, __setLlmForTests, getLlm } from '@/services/llm/factory.js';
import type { LlmService } from '@/services/llm/types.js';

const TZ = 'America/New_York';
const ME = 'john.doe@neuralads.example';
const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;

const DATA_REPLY = {
  subject: 'RE: Brightstream AI respondent data ready: brightstream_ai_respondents_2026_11',
  sentAt: '2026-11-16T13:49:00-05:00',
  from: { name: 'Ashton Grant', email: 'ashton.grant@brightstream.example' },
  to: [
    'jason.sellers@big-village.example',
    'andy.davidson@brightstream.example',
    'jp.sands@brightstream.example',
    'gary.yates@big-village.example',
  ],
  cc: [
    'mike.miller@big-village.example',
    'brad.thompson@brightstream.example',
    'tom.kelly@neuralads.example',
    ME,
    'ryota.xing@brightstream.example',
  ],
  body: `Yes, I am open tomorrow any time outside of the 1-2.30pm EST window.

Get Outlook for iOS

From: Jason Sellers <jason.sellers@big-village.example>
Sent: Monday, November 16, 2026 1:42 PM
To: Ashton Grant; Andy Dawson; JP Sands; Gary Yates
Cc: Mike Miller; Brad Thomas; Tom Kent; John Doe; Ryan SHaw
Subject: Brightstream AI respondent data ready: brightstream_ai_respondents_2026_11

Ash,

It's probably easier to discuss this over a meeting, are you available for 30 mins tomorrow morning?

Thanks,

Jason

Jason Sellers, Senior Data Architect
Big Village
A BRIGHT MOUNTAIN COMPANY
jason.sellers@big-village.example`,
};

const INTRO = {
  subject: 'Neural Ads <> Geoff - intro',
  sentAt: '2026-11-16T12:12:00-05:00',
  from: { name: 'Tom Kent', email: 'tom.kelly@neuralads.example' },
  to: ['geoff.judge@judgecapital.example'],
  cc: [ME],
  body: `Rusty, thank you for the intro, much appreciated. Moving you to bcc.

Geoff, great to meet you. Quick intro on our side: I'm co-founder and CRO at Neural Ads, and I've copied my co-founder John Doe, our CFO, who is leading the round. We'd both love to join the call.

A few options that work for John and me this week:

- Wed 11/18: 1:00pm ET (10:00am PT)
- Thu 11/19: 1:30pm ET (10:30am PT)
- Fri 11/20: 2:30pm ET (11:30am PT)

Happy to send a Teams invite for whichever works, or use your link. Our deck is attached to Dave's note below if you want a look beforehand.

Tom`,
};

type Email = typeof DATA_REPLY;

function bodyRow(e: Email): ExtractStageBodyRow {
  return {
    id: 'm1',
    gmail_message_id: 'm1',
    body_text: e.body,
    body_html: null,
    body_excerpt: null,
    internal_date: e.sentAt,
    headers_json: {},
    from_email: e.from.email,
    from_name: e.from.name,
    to_emails: e.to,
    cc_emails: e.cc,
  };
}

async function extract(e: Email, own: string[]): Promise<EmailSuggestion[]> {
  const found = await llmExtractor().extract({
    subject: e.subject,
    snippet: e.body.slice(0, 100),
    bodyText: e.body,
    categoryTitle: 'Work',
    userTz: TZ,
    emailSentAt: e.sentAt,
    participants: participantsLine(bodyRow(e), own),
  });
  return dropAsksOfOthers(found, bodyRow(e), [...own, 'John Doe', 'John']);
}

const actions = (items: EmailSuggestion[]) =>
  items.filter((s) => s.kind === 'task' || s.kind === 'event' || s.kind === 'list');

describe.skipIf(!live)('magics extractor, live model: asks aimed at someone else', () => {
  const provider = env.LLM_PROVIDER;
  beforeAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
    // The raw reply is logged: the parsed items hide an item dropped for askedOf.
    const real = getLlm();
    const logged: LlmService = {
      ...real,
      complete: async (m, o) => {
        const raw = await real.complete(m, o);
        console.log(`raw: ${raw}`);
        return raw;
      },
    };
    __setLlmForTests(logged);
  });
  afterAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
  });

  for (const [name, email] of [
    ['a reply to an ask that was Ash\'s', DATA_REPLY],
    ['times offered to Geoff that mention the user', INTRO],
  ] as const) {
    it(`gives the user nothing for ${name}`, async () => {
      const items = await extract(email, [ME]);
      console.log(`model=${env.OPENAI_MODEL} ${name}\n${JSON.stringify(items, null, 2)}`);
      expect(actions(items)).toEqual([]);
    }, 60_000);
  }
});
