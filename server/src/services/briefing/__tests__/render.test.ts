/**
 * ADR 0091 — the template slots.
 *
 * Meta rejects a body parameter that is empty or contains a newline, a tab, or
 * 4+ consecutive spaces, and a rejected template is a briefing that silently
 * never arrives. These are the rules that keep that from happening.
 */
import { describe, expect, it } from 'vitest';

import type { BriefingFacts } from '@/services/briefing/facts.js';
import { renderTeaser, sanitizeParam, templateParams } from '@/services/briefing/render.js';

const EMPTY: BriefingFacts = {
  weather: null,
  today: null,
  thisWeek: null,
  headsUp: null,
  tasks: null,
  email: null,
};

const FULL: BriefingFacts = {
  weather:
    '⛅ Partly cloudy today, low 58° and high 72°F · ⛈️ 60% chance of thunderstorms around 3 PM — carry an umbrella',
  today: '2 events — first: Standup at 9:00 AM',
  thisWeek: '3 events — next: Recital on 2026-08-25',
  headsUp: 'birthday for Ella in 9d',
  tasks: '4 open tasks, 1 overdue — next: Book dentist',
  email: '2 waiting on you · 14 unread',
};

describe('templateParams', () => {
  it('always fills exactly five slots', () => {
    expect(templateParams(FULL)).toHaveLength(5);
    expect(templateParams(EMPTY)).toHaveLength(5);
  });

  it('never emits an empty parameter, even with nothing to say', () => {
    for (const p of templateParams(EMPTY)) {
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it('never emits a newline, tab, or run of spaces', () => {
    const facts: BriefingFacts = {
      ...FULL,
      today: 'line one\nline two\twith    padding',
    };
    for (const p of templateParams(facts)) {
      expect(p).not.toMatch(/[\r\n\t]/);
      expect(p).not.toMatch(/ {2}/);
    }
  });

  it('leads the week slot with today, which has no slot of its own', () => {
    const [, week] = templateParams(FULL);
    expect(week.indexOf('Standup')).toBeLessThan(week.indexOf('Recital'));
  });

  it('orders slots weather, week, heads-up, tasks, email', () => {
    const [weather, week, headsUp, tasks, email] = templateParams(FULL);
    expect(weather).toContain('Partly cloudy');
    expect(week).toContain('Recital');
    expect(headsUp).toContain('Ella');
    expect(tasks).toContain('dentist');
    expect(email).toContain('unread');
  });
});

describe('sanitizeParam', () => {
  it('floors a whitespace-only value rather than sending an empty one', () => {
    expect(sanitizeParam('   ')).toBe('—');
    expect(sanitizeParam('\n\t')).toBe('—');
  });

  it('collapses whitespace instead of dropping the content', () => {
    expect(sanitizeParam('a\n\nb     c')).toBe('a b c');
  });

  it('caps length so one runaway fact cannot blow the 1024-char body', () => {
    expect(sanitizeParam('x'.repeat(5000)).length).toBeLessThanOrEqual(900);
  });
});

describe('renderTeaser', () => {
  it('omits absent facts rather than flooring them — plain text can be short', () => {
    const out = renderTeaser(EMPTY);
    expect(out).toContain('Nothing on the calendar today');
    expect(out).not.toContain('—\n');
    expect(out).not.toContain('No open tasks');
  });

  it('keeps the ADR 0079 affordance', () => {
    const out = renderTeaser(FULL);
    expect(out).toContain('A peek at your day');
    expect(out).toContain('Read more');
    expect(out).toContain('AI Plan');
  });
});
