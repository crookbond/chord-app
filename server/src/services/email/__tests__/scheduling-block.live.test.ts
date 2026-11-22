/**
 * ADR 0346 phase 2 eval set, against a real model: what gets STORED (the
 * model's block finished in code) for the shapes that broke or were asked
 * about. Each case is one email; the assertions are only the fields the case
 * is about.
 *
 * Skipped unless MAGICS_LIVE=1 and an OpenAI-compatible key is set. From `server/`:
 *
 *   MAGICS_LIVE=1 npx vitest run src/services/email/__tests__/scheduling-block.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SchedulingBlock, SchedulingFacts } from '@chord/kernel';

import { env } from '@/config/env.js';
import { llmExtractor } from '@/services/email/magics.service.js';
import { finishScheduling } from '@/services/email/scheduling-block.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import { svWall } from '@/utils/tz.js';

const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;
const TZ = 'America/New_York';
const ME = 'john@example.com';

interface Case {
  name: string;
  subject: string;
  body: string;
  from: [name: string, email: string];
  to: string[];
  cc?: string[];
  /** null = no block, or a block saying only fyi. */
  expect: Partial<SchedulingFacts> | null;
  check?: (f: SchedulingFacts) => void;
}

const CASES: Case[] = [
  {
    name: 'Rob offers a window',
    subject: 'Catch up',
    body: 'Hi John,\nI am mostly free tomorrow from 10-1. Anything work for you?\n\nBest\nRob',
    from: ['Rob Smith', 'rob@acme.com'],
    to: [ME],
    expect: { act: 'offer_slots', inviteBy: 'unknown', addressed: 'to' },
  },
  {
    name: 'an assistant offers windows and will send the invite',
    subject: 'Meeting with Omar',
    body: 'Hi John,\n\nOmar is available:\n - 11/10: 10:30 AM - 12:00 PM PT\n - 11/12: 3:00 PM - 5:00 PM PT\n\nLet me know what works and I will send over a calendar invitation.\n\nAna\nAssistant to Omar',
    from: ['Ana Lee', 'ana@vc.com'],
    to: [ME],
    cc: ['omar@vc.com'],
    expect: { act: 'offer_slots', writer: 'assistant', inviteBy: 'them', notCore: ['ana@vc.com'] },
  },
  {
    name: 'they ask the user to send the invite',
    subject: 'Re: intro',
    body: 'Thursday at 2pm works for me. Can you send an invite? Zoom is fine.',
    from: ['Kim', 'kim@startup.io'],
    to: [ME],
    expect: { act: 'agree', inviteBy: 'me', format: 'video' },
  },
  {
    // Prod 2026-11-17 (ADR 0347): agreeing a time says nothing about who sends.
    name: 'Arthur agrees a time and says nothing about the invite',
    subject: "Re: Partnerships: You've received a submission from arthur@optizent.com",
    body:
      '2:00 works, I am in Seattle so 11:00 PST.\n\nArthur Baker\nOptizent.com\n\n' +
      'From: John Doe <john@example.com>\nSent: Tuesday, November 17, 2026 1:15 PM\nTo: Arthur Baker <arthur@optizent.com>\n' +
      'Subject: Re: Partnerships\n\nIn NYC. how is noon est tomorrow? Or anytime between 2-4p est?',
    from: ['Arthur Baker (Optizent)', 'arthur@optizent.com'],
    to: [ME],
    expect: { act: 'agree', inviteBy: 'unknown' },
    check: (f) => {
      // The user's quoted times are not Arthur's offer.
      expect(f.offered).toEqual([]);
    },
  },
  {
    name: 'an in-person meeting at a place',
    subject: 'Coffee',
    body: 'Let us meet Friday at 9am at Blue Bottle on Bryant Street. See you there!',
    from: ['Lee', 'lee@x.com'],
    to: [ME],
    expect: { act: 'agree', format: 'in_person' },
  },
  {
    name: 'the user is on Cc only',
    subject: 'Re: sync',
    body: 'Hi Tom, when are you free next week for the sync? John cc for visibility.',
    from: ['Sam', 'sam@x.com'],
    to: ['tom@x.com'],
    cc: [ME],
    expect: null,
  },
  {
    name: 'a refusal beside an offer (phase 7)',
    subject: 'Re: planning sync',
    body: "I can't do Wednesday at all, but Thursday 2-4pm works for me.",
    from: ['Sam', 'sam@acme.com'],
    to: [ME, 'rob@acme.com'],
    expect: {},
    check: (f) => {
      expect(f.unavailable.length).toBeGreaterThan(0);
      expect(f.offered.some((s) => s.minutes === 840)).toBe(true);
    },
  },
  {
    name: 'times passed on for others (phase 7)',
    subject: 'Re: planning sync',
    body: 'Quick update: Sam can do Tuesday afternoon and Kim prefers Wednesday morning. I am flexible.',
    from: ['Rob', 'rob@acme.com'],
    to: [ME, 'sam@acme.com', 'kim@other.org'],
    expect: {},
    check: (f) => {
      expect(f.others.map((o) => o.person).sort()).toEqual(['kim@other.org', 'sam@acme.com']);
    },
  },
  {
    name: 'a reply does not repeat the times it quotes (phase 7)',
    subject: 'Re: planning sync',
    body: 'Tuesday at 11 works for me too.\n\nOn Mon, Rob wrote:\n> I am free Tuesday 10-1 or Thursday 3-5.',
    from: ['Kim', 'kim@other.org'],
    to: [ME, 'rob@acme.com'],
    expect: {},
    check: (f) => {
      expect(f.offered.some((s) => s.minutes === 900)).toBe(false);
    },
  },
  {
    name: 'a booking confirmation is not scheduling',
    subject: 'Your appointment is confirmed',
    body: 'Your dental cleaning is confirmed for Monday, Nov 23 at 9:00 AM. Reply C to confirm.',
    from: ['Smile Dental', 'noreply@smiledental.com'],
    to: [ME],
    expect: null,
  },
];

describe.skipIf(!live)('scheduling block, live model', () => {
  const provider = env.LLM_PROVIDER;
  beforeAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
  });
  afterAll(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
  });

  for (const c of CASES) {
    it(c.name, async () => {
      let block: SchedulingBlock | null = null;
      const sent = new Date(Date.now() - 3600_000);
      const cc = c.cc ?? [];
      const raw = await llmExtractor().extract({
        subject: c.subject,
        snippet: c.body.slice(0, 100),
        bodyText: c.body,
        categoryTitle: 'Work',
        userTz: TZ,
        emailSentAt: sent.toISOString(),
        participants:
          `Participants: From ${c.from[0]} <${c.from[1]}>; To ${c.to.join(', ')}${cc.length ? `; Cc ${cc.join(', ')}` : ''}\n` +
          `You: ${ME} (${c.to.includes(ME) ? 'on To' : 'on Cc only'})`,
        onScheduling: (b) => {
          block = b;
        },
      });
      const facts = block
        ? finishScheduling(
            block,
            {
              bodyText: c.body,
              fromName: c.from[0],
              fromEmail: c.from[1],
              toEmails: c.to,
              ccEmails: cc,
              sentDay: svWall(sent, TZ).slice(0, 10),
            },
            [ME],
            { askedOfUser: (Array.isArray(raw) ? raw : raw ? [raw] : []).some((s) => { const a = 'askedOf' in s ? s.askedOf : undefined; return !a || a.toLowerCase() === 'me'; }) },
          )
        : null;
      console.log(`[live] ${c.name}: ${JSON.stringify(facts)}`);
      if (c.expect === null) expect(facts === null || facts.act === 'fyi').toBe(true);
      else {
        expect(facts).toMatchObject(c.expect);
        c.check?.(facts!);
      }
    }, 60_000);
  }
});
