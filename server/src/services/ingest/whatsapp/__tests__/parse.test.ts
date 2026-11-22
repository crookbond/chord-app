import { describe, expect, it } from 'vitest';

import { parseChat } from '../parse.js';

describe('parseChat', () => {
  it('parses the bracketed format (DD/MM/YY) with AM/PM + 2-digit year', () => {
    const out = parseChat('[27/09/22, 11:27:35 PM] Sach: hello world\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sender: 'Sach', body: 'hello world' });
    expect(out[0].sentAt.getFullYear()).toBe(2022);
    expect(out[0].sentAt.getMonth()).toBe(8);
    expect(out[0].sentAt.getDate()).toBe(27);
    expect(out[0].sentAt.getHours()).toBe(23);
  });

  it('parses the unbracketed format without seconds', () => {
    const out = parseChat('3/14/24, 9:16 AM - Shreyas: message body\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sender: 'Shreyas', body: 'message body' });
    expect(out[0].sentAt.getHours()).toBe(9);
  });

  it('accumulates multi-line message bodies', () => {
    const chat = [
      '[14/03/2024, 09:16:00] Alice: line one',
      'line two',
      'line three',
      '[14/03/2024, 09:17:00] Bob: reply',
    ].join('\n');
    const out = parseChat(chat);
    expect(out).toHaveLength(2);
    expect(out[0].body).toBe('line one\nline two\nline three');
    expect(out[1].sender).toBe('Bob');
  });

  it('detects attached files and the Media omitted sentinel', () => {
    const chat = [
      '[14/03/2024, 09:16:00] Alice: IMG-20240314.jpg (file attached)',
      '[14/03/2024, 09:17:00] Bob: <Media omitted>',
    ].join('\n');
    const out = parseChat(chat);
    expect(out[0].hasAttachment).toBe(true);
    expect(out[0].attachmentFilename).toBe('IMG-20240314.jpg');
    expect(out[1].hasAttachment).toBe(false);
    expect(out[1].body).toBe('');
  });

  it('discards system messages (no sender)', () => {
    const chat = [
      '[14/03/2024, 09:00:00] Messages and calls are end-to-end encrypted.',
      '[14/03/2024, 09:16:00] Alice: real message',
    ].join('\n');
    const out = parseChat(chat);
    expect(out).toHaveLength(1);
    expect(out[0].sender).toBe('Alice');
  });

  it('strips zero-width direction-control characters before matching', () => {
    const chat = '\u200e[14/03/2024, 09:16:00] Alice: hi\n';
    const out = parseChat(chat);
    expect(out).toHaveLength(1);
    expect(out[0].sender).toBe('Alice');
  });
});
