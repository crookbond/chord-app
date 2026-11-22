/**
 * pickFileRef — given a Telegram message, returns the single best
 * file_id to download (or null). Photo arrays come in size-resized
 * variants; we pick the largest. Documents / voice / audio / video are
 * direct one-shot refs. Pure function so we can unit-test without
 * mocking fetch.
 */
import { describe, expect, it } from 'vitest';

import { pickFileRef } from '@/services/connectors/telegram/telegram.connector.js';
import type { TgMessage } from '@/services/connectors/telegram/telegram.api.js';

function base(): TgMessage {
  return {
    message_id: 1,
    chat: { id: 1, type: 'private' },
    date: 0,
  };
}

describe('pickFileRef', () => {
  it('returns null when the message has no attachments', () => {
    expect(pickFileRef(base())).toBeNull();
  });

  it('picks the largest photo variant', () => {
    const ref = pickFileRef({
      ...base(),
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 5000 },
        { file_id: 'medium', file_unique_id: 'm', width: 320, height: 320, file_size: 30000 },
        { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280, file_size: 250000 },
      ],
    });
    expect(ref).not.toBeNull();
    expect(ref!.fileId).toBe('large');
    expect(ref!.kind).toBe('photo');
    expect(ref!.mimeType).toBe('image/jpeg');
    expect(ref!.filename).toMatch(/^photo-l\.jpg$/);
  });

  it('falls back to width*height when file_size is missing', () => {
    const ref = pickFileRef({
      ...base(),
      photo: [
        { file_id: 'a', file_unique_id: 'a', width: 100, height: 100 },
        { file_id: 'b', file_unique_id: 'b', width: 800, height: 800 },
      ],
    });
    expect(ref!.fileId).toBe('b');
  });

  it('reads document fields verbatim', () => {
    const ref = pickFileRef({
      ...base(),
      document: {
        file_id: 'doc1',
        file_unique_id: 'd',
        file_name: 'school-form.pdf',
        mime_type: 'application/pdf',
      },
    });
    expect(ref).toMatchObject({
      fileId: 'doc1',
      filename: 'school-form.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
    });
  });

  it('handles voice with sensible defaults', () => {
    const ref = pickFileRef({
      ...base(),
      voice: { file_id: 'voice1', file_unique_id: 'v', duration: 3 },
    });
    expect(ref!.kind).toBe('voice');
    expect(ref!.mimeType).toBe('audio/ogg');
    expect(ref!.filename).toBe('voice-v.ogg');
  });

  it('prioritises photo over document when both are present', () => {
    // Per Telegram API, a message has at most one media type but defensively
    // pickFileRef picks photo first by the order of checks.
    const ref = pickFileRef({
      ...base(),
      photo: [{ file_id: 'p', file_unique_id: 'p', width: 100, height: 100 }],
      document: { file_id: 'd', file_unique_id: 'd' },
    });
    expect(ref!.kind).toBe('photo');
  });

  it('handles video with mp4 fallback mime', () => {
    const ref = pickFileRef({
      ...base(),
      video: {
        file_id: 'v1',
        file_unique_id: 'v',
        width: 720,
        height: 1280,
        duration: 10,
      },
    });
    expect(ref!.kind).toBe('video');
    expect(ref!.mimeType).toBe('video/mp4');
  });
});
