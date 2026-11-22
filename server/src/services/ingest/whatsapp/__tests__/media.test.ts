import { describe, expect, it } from 'vitest';

import { classifyWhatsAppFilename } from '../media.js';

describe('classifyWhatsAppFilename', () => {
  it('classifies an IMG-* jpg as image/jpeg', () => {
    expect(classifyWhatsAppFilename('IMG-20240314-WA0001.jpg')).toEqual({
      mediaType: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('classifies a PTT-* opus voice note as audio/opus', () => {
    expect(classifyWhatsAppFilename('PTT-20240314-WA0001.opus')).toEqual({
      mediaType: 'audio',
      mimeType: 'audio/opus',
    });
  });

  it('classifies a DOC-* pdf as document + application/pdf', () => {
    expect(classifyWhatsAppFilename('DOC-20240314-WA0001.pdf')).toEqual({
      mediaType: 'document',
      mimeType: 'application/pdf',
    });
  });

  it('returns null for _chat.txt and other non-media files', () => {
    expect(classifyWhatsAppFilename('_chat.txt')).toBeNull();
    expect(classifyWhatsAppFilename('notes.md')).toBeNull();
  });

  it('falls back to octet-stream for recognised prefix + unknown extension', () => {
    expect(classifyWhatsAppFilename('DOC-something.xyz')).toEqual({
      mediaType: 'document',
      mimeType: 'application/octet-stream',
    });
  });
});
