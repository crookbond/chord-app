/**
 * What a file's search vector is made from (ADR 0276): its name, its summary
 * and its first two pages - not half a page, which missed anything a form or
 * letter only states further down.
 */
import { describe, expect, it } from 'vitest';

import { attachmentEmbeddingText, FILE_TEXT_CHARS } from '@/services/search/embed-text.js';

describe('attachmentEmbeddingText', () => {
  it('keeps the first two pages of text', () => {
    const page = 'word '.repeat(600); // ~3,000 characters
    const onPageTwo = `${page}${'x'.repeat(2000)} permission slip due Friday ${page}`;
    const text = attachmentEmbeddingText({ filename: 'form.pdf', summary: null, text: onPageTwo });
    expect(FILE_TEXT_CHARS).toBe(6000);
    expect(text).toContain('permission slip due Friday');
    expect(text.length).toBeLessThanOrEqual('File: form.pdf\n'.length + FILE_TEXT_CHARS);
  });
});
