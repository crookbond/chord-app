/**
 * ADR 0071 import filter: calendar parts belong to the invite pipeline, not
 * the knowledge base — without this every invite email deposits an
 * "invite.ics" file into the personal group.
 */
import { describe, expect, it } from 'vitest';

import { shouldImport } from '@/services/email/attachment-import.js';

describe('shouldImport', () => {
  it('keeps real documents', () => {
    expect(shouldImport({ filename: 'itinerary.pdf', mimeType: 'application/pdf', size: 5000 })).toBe(true);
    expect(shouldImport({ filename: 'notes.txt', mimeType: 'text/plain', size: 100 })).toBe(true);
  });

  it('skips calendar parts by mime and by extension', () => {
    expect(shouldImport({ filename: 'invite.ics', mimeType: 'text/calendar', size: 900 })).toBe(false);
    expect(shouldImport({ filename: 'invite.ics', mimeType: 'application/octet-stream', size: 900 })).toBe(false);
    expect(shouldImport({ filename: 'meeting', mimeType: 'application/ics', size: 900 })).toBe(false);
  });

  it('keeps the existing size/name filters', () => {
    expect(shouldImport({ filename: '', mimeType: 'application/pdf', size: 5000 })).toBe(false);
    expect(shouldImport({ filename: 'x.jpg', mimeType: 'image/jpeg', size: 10 })).toBe(false);
  });
});
