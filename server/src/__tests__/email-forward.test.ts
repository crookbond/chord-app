/**
 * The quoted-original builder shared by the forward preview and the send
 * (kernel/src/email-forward.ts, ADR 0112 addendum).
 */
import { describe, expect, it } from 'vitest';

import {
  FORWARD_MARKER,
  buildForwardBody,
  forwardDateLabel,
  forwardHeaderLines,
  forwardQuote,
} from '@chord/kernel';

const original = {
  fromName: 'Ms Chen',
  fromEmail: 'chen@school.example',
  date: 'Thu, Aug 20, 2026 at 6:00 AM',
  subject: 'Permission slip',
  to: ['me@example.com', 'spouse@example.com'],
  body: 'Please return it by Friday.',
};

describe('forwardHeaderLines', () => {
  it('puts the marker first, then From / Date / Subject / To', () => {
    expect(forwardHeaderLines(original)).toEqual([
      FORWARD_MARKER,
      'From: Ms Chen <chen@school.example>',
      'Date: Thu, Aug 20, 2026 at 6:00 AM',
      'Subject: Permission slip',
      'To: me@example.com, spouse@example.com',
    ]);
  });

  it('leaves out an empty To and names an unknown sender', () => {
    const lines = forwardHeaderLines({ ...original, fromName: null, fromEmail: null, to: [] });
    expect(lines).toContain('From: (unknown sender)');
    expect(lines.some((l) => l.startsWith('To:'))).toBe(false);
  });
});

describe('buildForwardBody', () => {
  it('is the note, a blank line, then exactly the quote', () => {
    expect(buildForwardBody('  Can you sign this?  ', original)).toBe(
      `Can you sign this?\n\n${forwardQuote(original)}`,
    );
  });

  it('is the quote alone with no note', () => {
    expect(buildForwardBody('   ', original)).toBe(forwardQuote(original));
    expect(forwardQuote(original)).toMatch(/^---------- Forwarded message ----------\n/);
  });
});

describe('forwardDateLabel', () => {
  it('reads the instant in the given zone', () => {
    expect(forwardDateLabel('2026-10-27T17:03:00.000Z', 'America/Los_Angeles')).toBe(
      'Tue, Oct 27, 2026 at 10:03 AM',
    );
    expect(forwardDateLabel('2026-10-27T17:03:00.000Z', 'Asia/Kolkata')).toBe(
      'Tue, Oct 27, 2026 at 10:33 PM',
    );
  });

  it('falls back to UTC for an unknown zone and to the raw value for a bad date', () => {
    expect(forwardDateLabel('2026-10-27T17:03:00.000Z', 'Not/AZone')).toBe(
      'Tue, Oct 27, 2026 at 5:03 PM',
    );
    expect(forwardDateLabel('yesterday', 'UTC')).toBe('yesterday');
  });
});
