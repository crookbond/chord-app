/**
 * A NUL byte in extracted text must never reach Postgres.
 *
 * `text` cannot hold U+0000 (`22021 invalid byte sequence for encoding
 * "UTF8": 0x00`), and PDF text layers produce them routinely — five prod
 * receipts and invoices in one afternoon. The throw landed in the indexing
 * catch, so those files kept their bytes but got no text, no summary, no
 * chunks and no FTS row, and the recovery pass retried them forever.
 *
 * Both sides are pinned because both write a column Postgres will reject, and
 * the email one is worse: `email_messages.body_text` feeds a GENERATED
 * tsvector, so the failure would be an INSERT inside the sync — a wedged
 * mailbox, not one bad file.
 */
import { describe, expect, it } from 'vitest';

import { stripNulls } from '@/services/attachments.extract.js';
import { extractBodies } from '@/services/google/gmail-sync.js';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('stripNulls', () => {
  it('removes NUL and keeps everything around it', () => {
    expect(stripNulls('Invoice\u0000 4BA4A944\u0000-0019')).toBe('Invoice 4BA4A944-0019');
  });

  it('leaves other control characters alone', () => {
    // A form feed is real page structure in a PDF text layer, and tabs and
    // newlines carry the table shape the extractor exists to capture.
    expect(stripNulls('a\fb\tc\nd')).toBe('a\fb\tc\nd');
  });

  it('is a no-op on ordinary text', () => {
    expect(stripNulls('Receipt 2028-3447-6756')).toBe('Receipt 2028-3447-6756');
  });
});

describe('extractBodies', () => {
  it('strips NUL from both the plain and html bodies', () => {
    const bodies = extractBodies({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('hello\u0000 world') } },
        { mimeType: 'text/html', body: { data: b64url('<p>hi\u0000</p>') } },
      ],
    });
    expect(bodies.text).toBe('hello world');
    expect(bodies.html).toBe('<p>hi</p>');
  });

  it('still reports an absent body as null, not empty', () => {
    // ADR 0110 leans on the null/empty distinction: null means nobody looked.
    expect(extractBodies({ mimeType: 'text/plain' })).toEqual({ text: null, html: null });
  });
});
