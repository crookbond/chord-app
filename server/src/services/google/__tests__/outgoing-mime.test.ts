/**
 * The MIME a message with files actually goes out as (ADR 0111).
 *
 * Worth pinning rather than eyeballing: an attachment is invisible in the
 * product until a mail client parses it, so a malformed boundary or an
 * unwrapped base64 line fails somewhere we never look.
 */
import { describe, expect, it } from 'vitest';

import { buildReplyRaw } from '@/services/google/gmail-sync.js';

const decode = (raw: string): string =>
  Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const base = {
  fromEmail: 'me@example.com',
  to: ['them@example.com'],
  subject: 'Here it is',
  inReplyTo: null,
  references: null,
  body: 'The itinerary is attached.',
};

describe('outgoing MIME with attachments', () => {
  it('is unchanged when there is nothing attached', () => {
    // The no-attachment shape is the one every existing send already uses;
    // wrapping it in multipart/mixed regardless would change every message.
    const out = decode(buildReplyRaw({ ...base, htmlBody: '<p>hi</p>' }));

    expect(out).toContain('Content-Type: multipart/alternative');
    expect(out).not.toContain('multipart/mixed');
  });

  it('wraps body and files in multipart/mixed', () => {
    const out = decode(
      buildReplyRaw({
        ...base,
        htmlBody: '<p>hi</p>',
        attachments: [
          { filename: 'trip.txt', mimeType: 'text/plain', content: Buffer.from('UA512') },
        ],
      }),
    );

    expect(out).toContain('Content-Type: multipart/mixed');
    // The body keeps its alternative pair INSIDE the mixed wrapper.
    expect(out).toContain('Content-Type: multipart/alternative');
    expect(out).toContain('Content-Disposition: attachment; filename="trip.txt"');
    expect(out).toContain('Content-Transfer-Encoding: base64');
    expect(out).toContain(Buffer.from('UA512').toString('base64'));
  });

  it('closes every boundary it opens', () => {
    const out = decode(
      buildReplyRaw({
        ...base,
        htmlBody: '<p>hi</p>',
        attachments: [
          { filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('a') },
          { filename: 'b.txt', mimeType: 'text/plain', content: Buffer.from('b') },
        ],
      }),
    );

    const mixed = /boundary="(chord-mix-[^"]+)"/.exec(out)?.[1];
    const alt = /boundary="(chord-alt-[^"]+)"/.exec(out)?.[1];
    expect(mixed && out.includes(`--${mixed}--`)).toBe(true);
    expect(alt && out.includes(`--${alt}--`)).toBe(true);
    // One opener per part plus the closer: body + two files.
    expect(out.split(`--${mixed}`).length - 1).toBe(4);
  });

  it('wraps base64 at 76 characters', () => {
    // RFC 2045 caps a line at 76; some servers reject one long line outright,
    // so this is correctness rather than neatness.
    const out = decode(
      buildReplyRaw({
        ...base,
        attachments: [
          {
            filename: 'big.bin',
            mimeType: 'application/octet-stream',
            content: Buffer.alloc(1000, 7),
          },
        ],
      }),
    );

    const longest = Math.max(...out.split('\r\n').map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(76);
  });

  it('strips a newline out of a filename', () => {
    // A filename carrying CRLF would end the Content-Disposition line and let
    // whatever follows be read as headers - header injection via file picker.
    const out = decode(
      buildReplyRaw({
        ...base,
        attachments: [
          {
            filename: 'ok.txt\r\nBcc: someone@evil.example',
            mimeType: 'text/plain',
            content: Buffer.from('x'),
          },
        ],
      }),
    );

    expect(out).not.toMatch(/^Bcc: someone@evil\.example/m);
    expect(out).toContain('filename="ok.txt Bcc: someone@evil.example"');
  });

  it('keeps a plain-text body plain when files ride along', () => {
    const out = decode(
      buildReplyRaw({
        ...base,
        attachments: [
          { filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('a') },
        ],
      }),
    );

    expect(out).toContain('Content-Type: multipart/mixed');
    expect(out).not.toContain('multipart/alternative');
    expect(out).toContain('The itinerary is attached.');
  });
});
