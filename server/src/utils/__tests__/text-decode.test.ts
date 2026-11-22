import { describe, expect, it } from 'vitest';

import { extractBodies } from '@/services/google/gmail-sync.js';
import { parseIcsBuffer } from '@/services/ingest/ics/parse.js';
import { charsetOf, decodeText, repairWindows1252 } from '@/utils/text-decode.js';

describe('decodeText', () => {
  it('reads a UTF-16 file by its byte-order mark', () => {
    // What Windows Notepad writes for "Unicode": read as UTF-8 it is NULs and noise.
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café menu', 'utf16le')]);
    expect(le.toString('utf8')).not.toContain('Caf');
    expect(decodeText(le)).toBe('Café menu');

    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Hi', 'utf16le').swap16()]);
    expect(decodeText(be)).toBe('Hi');
  });

  it('drops a UTF-8 byte-order mark', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name,qty')]))).toBe('name,qty');
  });

  it('uses the declared charset when the bytes are not UTF-8', () => {
    const latin1 = Buffer.from('José – café'.replace('–', '-'), 'latin1');
    expect(latin1.toString('utf8')).toContain('�');
    expect(decodeText(latin1, 'iso-8859-1')).toBe('José - café');
  });

  it('falls back to Windows-1252 for undeclared Western text', () => {
    // 0x93/0x94 are curly quotes and 0x96 an en dash in Windows-1252.
    expect(decodeText(Buffer.from([0x93, 0x68, 0x69, 0x94, 0x20, 0x96]))).toBe('“hi” –');
  });

  it('reads the same bytes the same way under a Latin-1 label', () => {
    // The standard maps iso-8859-1 and latin1 to Windows-1252.
    const bytes = Buffer.from([0x93, 0x68, 0x69, 0x94, 0x20, 0x96]);
    expect(decodeText(bytes, 'iso-8859-1')).toBe('“hi” –');
    expect(decodeText(bytes, 'latin1')).toBe('“hi” –');
  });

  describe('repairWindows1252', () => {
    // What Node 20 hands back for the bytes above: the C1 control characters
    // numbered 0x93, 0x94 and 0x96, not the punctuation. Built from code
    // points so the test does not depend on which Node runs it.
    const node20 = (...bytes: number[]): string => String.fromCharCode(...bytes);

    it('turns the control characters Node 20 produces into the real ones', () => {
      expect(repairWindows1252(node20(0x93, 0x68, 0x69, 0x94, 0x20, 0x96))).toBe('“hi” –');
      expect(repairWindows1252(node20(0x80, 0x35, 0x20, 0x99, 0x85))).toBe('€5 ™…');
    });

    it('leaves a correct decode, accented letters and the undefined bytes alone', () => {
      expect(repairWindows1252('“hi” – café')).toBe('“hi” – café');
      expect(repairWindows1252(node20(0xe9, 0xfc))).toBe('éü');
      // 0x81, 0x8D, 0x8F, 0x90 and 0x9D mean nothing in Windows-1252.
      expect(repairWindows1252(node20(0x81, 0x8d, 0x8f, 0x90, 0x9d))).toBe(
        node20(0x81, 0x8d, 0x8f, 0x90, 0x9d),
      );
    });
  });

  it('trusts valid UTF-8 over a label that says otherwise', () => {
    // A provider may convert the bytes and leave the original label on the part.
    expect(decodeText(Buffer.from('we’d love to', 'utf8'), 'iso-8859-1')).toBe('we’d love to');
  });

  it('survives a charset label it has never heard of', () => {
    expect(decodeText(Buffer.from([0xe9]), 'x-no-such-charset')).toBe('é');
  });
});

describe('charsetOf', () => {
  it('pulls the charset out of a Content-Type value', () => {
    expect(charsetOf('text/plain; charset="ISO-8859-1"; format=flowed')).toBe('iso-8859-1');
    expect(charsetOf('text/html; charset=windows-1252')).toBe('windows-1252');
    expect(charsetOf('text/plain')).toBeNull();
    expect(charsetOf(undefined)).toBeNull();
  });
});

describe('extractBodies', () => {
  it('decodes a Latin-1 body by the charset its part declares', () => {
    const data = Buffer.from('Réunion à 15h', 'latin1').toString('base64url');
    const { text } = extractBodies({
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }],
      body: { data },
    });
    expect(text).toBe('Réunion à 15h');
  });

  it('still reads a UTF-8 body', () => {
    const data = Buffer.from('we’d love to have you', 'utf8').toString('base64url');
    expect(extractBodies({ mimeType: 'text/plain', body: { data } }).text).toBe('we’d love to have you');
  });
});

describe('parseIcsBuffer', () => {
  it('reads a UTF-16 calendar file', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:utf16-1@example.com',
      'DTSTAMP:20300101T000000Z',
      'DTSTART:20300105T150000Z',
      'DTEND:20300105T160000Z',
      'SUMMARY:Café catch-up',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ics, 'utf16le')]);

    const out = parseIcsBuffer(buf);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.title).toBe('Café catch-up');
  });
});
