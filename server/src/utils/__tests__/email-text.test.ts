/**
 * ADR 0110 — what the model actually gets to read.
 *
 * The fixture is the real prod snippet, padding and all: 464 of 2,432 threads
 * carry this, and on those the median amount of real text left was 78 chars.
 */
import { describe, expect, it } from 'vitest';

import {
  BODY_EXCERPT_CHARS,
  bodyExcerpt,
  cleanBodyText,
  cleanGmailSnippet,
  cleanSnippet,
  htmlToText,
} from '@/utils/email-text.js';
import { normalizeMessage } from '@/services/google/gmail-sync.js';

describe('cleanGmailSnippet', () => {
  // Gmail's API returns the preview HTML-escaped; these are as it sent them.
  const ESCAPED =
    'We noticed you have registered for past IIT Delhi Alumni mixers but haven&#39;t been able to attend. We would be delighted if you can come this time, and we&#39;re happy';

  it('decodes the escaped preview Gmail sends', () => {
    expect(cleanGmailSnippet(ESCAPED)).toBe(
      "We noticed you have registered for past IIT Delhi Alumni mixers but haven't been able to attend. We would be delighted if you can come this time, and we're happy",
    );
    expect(cleanGmailSnippet('To: John Doe &lt;ownertest@gmail.com&gt; Subject: Re: Q&amp;A')).toBe(
      'To: John Doe <ownertest@gmail.com> Subject: Re: Q&A',
    );
  });

  it('is what a synced Gmail message is stored with', () => {
    const nm = normalizeMessage({ id: 'm1', threadId: 't1', snippet: ESCAPED });
    expect(nm.snippet).not.toContain('&#39;');
    expect(nm.snippet).toContain("haven't");
  });

  it('leaves a plain-text preview from another provider alone', () => {
    // Outlook and IMAP previews are not escaped; `&amp;` there is what was written.
    expect(cleanSnippet('Type &amp; to get an ampersand')).toBe('Type &amp; to get an ampersand');
  });
});

/** `news@christysports.com`, "Your summer picks + up to 50% off". */
const CHRISTY = 'Sunny-day picks. End-of-summer prices.\r\n' + ' ‌'.repeat(100);

describe('cleanSnippet', () => {
  it('recovers the real sentence from a padded preheader', () => {
    expect(cleanSnippet(CHRISTY)).toBe('Sunny-day picks. End-of-summer prices.');
    expect(CHRISTY.length).toBeGreaterThan(200);
  });

  it('leaves ordinary text — accents, emoji, punctuation — alone', () => {
    expect(cleanSnippet('Réunion des parents jeudi ☀️ — 18h')).toBe(
      'Réunion des parents jeudi ☀️ — 18h',
    );
    expect(cleanSnippet('Bake sale Friday')).toBe('Bake sale Friday');
  });

  // Prod 2026-10-29: U+E0139 between every letter of "Coinbase".
  it('strips variation selectors hidden between letters', () => {
    const vs = '\u{E0139}';
    expect(cleanSnippet(`C${vs}o${vs}i${vs}n${vs}b${vs}a${vs}${vs}${vs}se Email Support`)).toBe(
      'Coinbase Email Support',
    );
    expect(cleanSnippet('Support️')).toBe('Support');
  });

  it('reduces an all-padding snippet to empty, not to a row of spaces', () => {
    // A NOT NULL column, so '' rather than null; but it must not be ' '.
    expect(cleanSnippet('‌​ ﻿⠀')).toBe('');
    expect(cleanSnippet(null)).toBe('');
  });
});

describe('cleanBodyText', () => {
  it('keeps line structure and collapses the blank-line runs', () => {
    const body = 'Flight UA512\n\n\n\nSeat 14C   \n  Gate B7\n\n\n\n\nSee you there';
    expect(cleanBodyText(body)).toBe('Flight UA512\n\nSeat 14C\nGate B7\n\nSee you there');
  });

  it('strips the invisible padding a body carries too', () => {
    expect(cleanBodyText('Order‌ confirmed  today')).toBe('Order confirmed today');
  });
});

describe('bodyExcerpt', () => {
  it('caps at the read budget, cleaning first so the cap is spent on text', () => {
    const padded = '‌'.repeat(5000) + 'x'.repeat(3000);
    const excerpt = bodyExcerpt(padded)!;
    expect(excerpt).toHaveLength(BODY_EXCERPT_CHARS);
    expect(excerpt.startsWith('xxx')).toBe(true);
  });

  it('distinguishes "no text part" from "never fetched"', () => {
    // null, never '': the backfill reads this column to know what it still owes.
    expect(bodyExcerpt(null)).toBeNull();
    expect(bodyExcerpt('   ‌  ')).toBeNull();
    expect(bodyExcerpt('Hi')).toBe('Hi');
  });
});

describe('htmlToText', () => {
  it('reads an HTML-only body, which is all Outlook ever returns', () => {
    // The shape that matters: an invoice whose amount is in a table.
    const html =
      '<html><head><style>p{color:red}</style></head><body>' +
      '<p>Dear John Doe,</p><table><tr><td>Amount Due</td><td>$1,240.00</td></tr></table>' +
      '<div>Due 8/31/2026</div></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Dear John Doe,');
    expect(text).toContain('$1,240.00');
    expect(text).toContain('Due 8/31/2026');
    // Styling and markup must not survive as text the model has to wade past.
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('<');
  });

  it('keeps block boundaries as line breaks', () => {
    expect(htmlToText('<div>Gate B7</div><div>Seat 14C</div>')).toBe('Gate B7\nSeat 14C');
    expect(htmlToText('One<br>Two')).toBe('One\nTwo');
  });

  it('decodes the entities that carry meaning', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &quot;live&quot; &#8212; 7pm</p>')).toBe(
      'Tom & Jerry "live" — 7pm',
    );
    // Named punctuation and hex references: how an HTML mail spells "we'd".
    expect(htmlToText('<p>we&rsquo;d love to &ndash; this time &#x2014; Ren&eacute;e</p>')).toBe(
      'we’d love to – this time — Renée',
    );
    // &nbsp; is padding by another name.
    expect(htmlToText('<p>Total:&nbsp;&nbsp;&nbsp;$5</p>')).toBe('Total: $5');
  });

  it('returns empty for nothing, so callers can treat it like a missing body', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText('<div></div>')).toBe('');
  });
});
