import { describe, expect, it } from 'vitest';

import { isBareAttachmentUpload } from '../bot.service.js';

// `isBareAttachmentUpload` decides whether a trigger that carried a file is a
// bare upload (no instruction/question once the @-mention is stripped). When it
// is, the bot turn stays silent so it doesn't double-post a generic narration
// on top of the auto-filer's "📎 Indexed —…" acknowledgment. The default test
// persona alias is `chord` (NODE_ENV=test skips .env.local).
describe('isBareAttachmentUpload', () => {
  it('treats an empty / whitespace body as a bare upload', () => {
    expect(isBareAttachmentUpload('')).toBe(true);
    expect(isBareAttachmentUpload('   ')).toBe(true);
    expect(isBareAttachmentUpload('\n\t')).toBe(true);
  });

  it('treats a body that is only the bot mention as a bare upload', () => {
    expect(isBareAttachmentUpload('@chord')).toBe(true);
    expect(isBareAttachmentUpload('@Chord')).toBe(true);
    expect(isBareAttachmentUpload('  @chord  ')).toBe(true);
  });

  it('treats punctuation-only / emoji-only bodies as bare', () => {
    expect(isBareAttachmentUpload('!!!')).toBe(true);
    expect(isBareAttachmentUpload('📎')).toBe(true);
  });

  it('treats the app’s own `📎 <filename>` body as bare', () => {
    expect(isBareAttachmentUpload('📎 united-confirmation.png', 'united-confirmation.png')).toBe(true);
    expect(isBareAttachmentUpload('united-confirmation.png', 'united-confirmation.png')).toBe(true);
    expect(isBareAttachmentUpload('@chord 📎 Report (final).PDF', 'Report (final).pdf')).toBe(true);
    // Without the name to compare against, a filename still reads as words.
    expect(isBareAttachmentUpload('📎 united-confirmation.png')).toBe(false);
  });

  it('a question next to the filename is still a question', () => {
    expect(isBareAttachmentUpload('📎 itinerary.pdf when do we land?', 'itinerary.pdf')).toBe(false);
  });

  it('does NOT suppress when the user asked a real question', () => {
    expect(isBareAttachmentUpload('what does this say?')).toBe(false);
    expect(isBareAttachmentUpload('@chord what is the total on this invoice')).toBe(false);
  });

  it('does NOT suppress when the user gave an instruction alongside the file', () => {
    expect(isBareAttachmentUpload('@chord add these to my costco list')).toBe(false);
    expect(isBareAttachmentUpload('summarize this')).toBe(false);
  });
});
