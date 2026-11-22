/**
 * Non-ASCII text in the headers of mail Chord sends through Gmail.
 *
 * A header may only carry ASCII; anything else has to go out as an RFC 2047
 * encoded word. Sent raw, the receiving side reads the UTF-8 bytes as Latin-1
 * and the subject arrives as mojibake - and since a reply reuses the thread's
 * subject, every further reply garbles it again.
 */
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import { buildItipReplyRaw, buildReplyRaw, encodeHeaderText } from '@/services/google/gmail-sync.js';

const bytes = (raw: string): Buffer => Buffer.from(raw, 'base64url');

/** Everything before the first blank line, as the bytes actually sent. */
function headerBytes(raw: string): Buffer {
  const buf = bytes(raw);
  const end = buf.indexOf('\r\n\r\n');
  return end === -1 ? buf : buf.subarray(0, end);
}

const isAscii = (buf: Buffer): boolean => buf.every((b) => b < 0x80);

// The subject of the thread this was reported on. The dash is U+2013.
const REPORTED = 'Re: IIT Delhi Alumni Mixer – we’d love to have you this time';

const base = {
  fromEmail: 'me@example.com',
  to: ['them@example.com'],
  inReplyTo: null,
  references: null,
  body: 'See you there.',
};

describe('non-ASCII headers on outgoing Gmail', () => {
  it('sends the reported subject as ASCII that parses back to the original', async () => {
    const raw = buildReplyRaw({ ...base, subject: REPORTED });

    expect(isAscii(headerBytes(raw))).toBe(true);
    expect((await simpleParser(bytes(raw))).subject).toBe(REPORTED);
  });

  it('leaves an ASCII subject exactly as typed', () => {
    const raw = buildReplyRaw({ ...base, subject: 'Re: Picture day is next Friday' });

    expect(headerBytes(raw).toString('utf8')).toContain('Subject: Re: Picture day is next Friday\r\n');
  });

  it('keeps every encoded word within 75 characters and never splits a character', async () => {
    const long = `${'मिलन \u{1F389} '.repeat(20)}end`;
    const raw = buildReplyRaw({ ...base, subject: long });

    const words = headerBytes(raw).toString('ascii').match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect((await simpleParser(bytes(raw))).subject).toBe(long);
  });

  it('encodes a non-ASCII recipient name', async () => {
    const raw = buildReplyRaw({ ...base, subject: 'Hi', toName: 'José Álvarez' });

    expect(isAscii(headerBytes(raw))).toBe(true);
    const parsed = await simpleParser(bytes(raw));
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    expect(to?.value[0]).toEqual({ name: 'José Álvarez', address: 'them@example.com' });
  });

  it('quotes a recipient name that would otherwise read as two addresses', async () => {
    const raw = buildReplyRaw({ ...base, subject: 'Hi', toName: 'Doe, John' });

    // Asserted on the bytes: a forgiving parser reads the unquoted form too,
    // a strict one sees an address list of "Doe" and "John <...>".
    expect(headerBytes(raw).toString('utf8')).toContain('To: "Doe, John" <them@example.com>\r\n');
    const parsed = await simpleParser(bytes(raw));
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    expect(to?.value).toEqual([{ name: 'Doe, John', address: 'them@example.com' }]);
  });

  it('sends a non-ASCII attachment name that a mail client reads back in full', async () => {
    const name = 'Résumé – final.pdf';
    const raw = buildReplyRaw({
      ...base,
      subject: 'CV',
      attachments: [{ filename: name, mimeType: 'application/pdf', content: Buffer.from('pdf') }],
    });

    const parsed = await simpleParser(bytes(raw));
    expect(parsed.attachments[0]?.filename).toBe(name);
    // Clients that ignore `filename*=` still get a name, not mojibake.
    expect(bytes(raw).toString('utf8')).toContain('filename="R_sum_ _ final.pdf"');
  });

  it('encodes a body whose line is too long to send as written', async () => {
    // textToHtml puts a whole message on one line; a long reply exceeds 998 bytes.
    const paragraph = 'We’d love to have you this time. '.repeat(60);
    const html = `<div>${paragraph}</div>`;
    const raw = buildReplyRaw({ ...base, subject: 'Hi', body: paragraph, htmlBody: html });

    for (const line of bytes(raw).toString('latin1').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    const parsed = await simpleParser(bytes(raw));
    expect(parsed.html).toBe(html);
    expect(parsed.text?.trim()).toBe(paragraph.trim());
  });

  it('sends a short body exactly as written, with no transfer encoding', () => {
    const out = bytes(buildReplyRaw({ ...base, subject: 'Hi', htmlBody: '<div>See you there.</div>' })).toString('utf8');

    expect(out).not.toContain('Content-Transfer-Encoding');
    expect(out).toContain('Content-Type: text/plain; charset="UTF-8"\r\n\r\nSee you there.\r\n');
  });

  it('folds a long line of an RSVP reply at 75 bytes', () => {
    const raw = buildItipReplyRaw({
      fromEmail: 'me@example.com',
      fromName: null,
      organizerEmail: 'them@example.com',
      icalUid: 'u1',
      partstat: 'ACCEPTED',
      summary: 'IIT Delhi Alumni Mixer – we’d love to have you this time, and bring a friend along',
      sequence: 0,
    });
    const text = bytes(raw).toString('utf8');
    const ics = text.slice(text.indexOf('BEGIN:VCALENDAR'), text.indexOf('END:VCALENDAR'));

    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain(
      'SUMMARY:IIT Delhi Alumni Mixer – we’d love to have you this time\\, and bring a friend along',
    );
  });

  it('does not let a line break in a subject start a new header', () => {
    const raw = buildReplyRaw({ ...base, subject: 'Hello\r\nBcc: someone@example.com' });

    expect(headerBytes(raw).toString('utf8')).not.toMatch(/^Bcc:/m);
  });

  it('encodes the event title and responder name on an RSVP reply', async () => {
    const raw = buildItipReplyRaw({
      fromEmail: 'me@example.com',
      fromName: 'Renée Dubé',
      organizerEmail: 'them@example.com',
      icalUid: 'u1',
      partstat: 'ACCEPTED',
      summary: 'Café catch-up – Friday',
      sequence: 0,
    });

    expect(isAscii(headerBytes(raw))).toBe(true);
    const parsed = await simpleParser(bytes(raw));
    expect(parsed.subject).toBe('Accepted: Café catch-up – Friday');
    expect(parsed.from?.value[0]?.name).toBe('Renée Dubé');
  });
});

describe('encodeHeaderText', () => {
  it('returns ASCII untouched and round-trips everything else', () => {
    expect(encodeHeaderText('plain subject')).toBe('plain subject');
    expect(encodeHeaderText('–')).toBe('=?UTF-8?B?4oCT?=');
  });
});
