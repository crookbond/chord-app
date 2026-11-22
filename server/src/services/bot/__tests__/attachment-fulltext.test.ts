/**
 * The bot must be able to read a file's actual content for content-level asks
 * ("summarize it", "when did he get rubella"), not just BM25 snippets that only
 * appear when the current message repeats the file's keywords. attachmentBlock
 * inlines the full extracted text for the top-ranked docs.
 */
import { describe, expect, it } from 'vitest';

import type { AttachmentWithExcerpts } from '@/services/bot/retrieval.js';
import { __testing } from '@/services/bot/context.js';

const { attachmentBlock, FULLTEXT_CHAR_BUDGET } = __testing;

function att(over: Partial<AttachmentWithExcerpts>): AttachmentWithExcerpts {
  return {
    id: 'a1',
    filename: 'nolan immunization_record.pdf',
    summary: 'Immunization record',
    extractedText: 'MMR (measles, mumps, rubella) administered 2019-03-14.',
    indexedAt: '2026-05-20T00:00:00Z',
    pinned: 0,
    created_at: '2026-05-20T00:00:00Z',
    owningGroupId: 'g1',
    blobMissing: false,
    excerpts: [],
    ...over,
  };
}

describe('attachmentBlock full-text inlining', () => {
  it('inlines the top doc full text even with no excerpts', () => {
    const out = attachmentBlock([att({})]);
    expect(out).toContain('Full text');
    expect(out).toContain('rubella');
  });

  it('truncates full text to the char budget', () => {
    const long = 'x'.repeat(FULLTEXT_CHAR_BUDGET + 5000);
    const out = attachmentBlock([att({ extractedText: long })]);
    expect(out).toContain('…[text truncated]');
    expect(out.length).toBeLessThan(long.length);
  });

  it('falls back to excerpts for docs past the full-text cap', () => {
    // 3rd doc (idx 2) is beyond FULLTEXT_DOC_CAP=2 → excerpts, not full text.
    const docs = [
      att({ id: 'a1', filename: 'one.pdf' }),
      att({ id: 'a2', filename: 'two.pdf' }),
      att({
        id: 'a3',
        filename: 'three.pdf',
        extractedText: 'big body text here',
        excerpts: [{ chunkIdx: 0, kind: 'text', snippet: '«hit» snippet' }],
      }),
    ];
    const out = attachmentBlock(docs);
    expect(out).toContain('three.pdf');
    // The snippet for the 3rd doc should be present; its full body should not.
    expect(out).toContain('«hit» snippet');
    expect(out).not.toContain('big body text here');
  });

  it('marks a still-indexing file instead of inlining', () => {
    const out = attachmentBlock([att({ indexedAt: null })]);
    expect(out).toContain('still indexing');
    expect(out).not.toContain('Full text');
  });

  it('flags a blob-missing file while still inlining its extracted text (insurance-cards-file-link-bug)', () => {
    const out = attachmentBlock([att({ blobMissing: true })]);
    expect(out).toContain('no longer stored on the server');
    // The prior fact is still readable — the model just can't imply it's retrievable.
    expect(out).toContain('rubella');
    expect(out).toContain('never call send_file or reference_file');
  });

  it('does not warn about a healthy attachment', () => {
    const out = attachmentBlock([att({ blobMissing: false })]);
    expect(out).not.toContain('no longer stored on the server');
  });
});
