/**
 * resolveMimeType (attachments.service): the mobile document picker and some IM
 * bridges hand the server `application/octet-stream` for images, which silently
 * disabled image classification (vision + content/trip classifiers gate on
 * `image/*`). The resolver recovers the real type from the filename extension,
 * then magic bytes. The image picker path already sends `image/*` and must be
 * left untouched.
 */
import { describe, expect, it } from 'vitest';

import { resolveMimeType } from '../attachments.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.7\n...');
const RANDOM = Buffer.from([0x00, 0x01, 0x02, 0x03]);

describe('resolveMimeType', () => {
  it('keeps a specific client-provided mime (image picker path)', () => {
    expect(resolveMimeType('image/jpeg', 'photo.jpg', JPEG)).toBe('image/jpeg');
    expect(resolveMimeType('image/png', 'shot.png', PNG)).toBe('image/png');
  });

  it('recovers an octet-stream image from the filename extension (document picker path)', () => {
    expect(resolveMimeType('application/octet-stream', 'IMG_2031.jpg', JPEG)).toBe('image/jpeg');
    expect(resolveMimeType('application/octet-stream', 'screenshot.png', PNG)).toBe('image/png');
  });

  it('recovers from magic bytes when the filename has no useful extension', () => {
    expect(resolveMimeType('application/octet-stream', 'photo', JPEG)).toBe('image/jpeg');
    expect(resolveMimeType('', 'upload', PNG)).toBe('image/png');
  });

  it('recovers a pdf the same way', () => {
    expect(resolveMimeType('application/octet-stream', 'form', PDF)).toBe('application/pdf');
  });

  it('leaves a genuinely unknown binary as octet-stream', () => {
    expect(resolveMimeType('application/octet-stream', 'data.bin', RANDOM)).toBe(
      'application/octet-stream',
    );
  });

  it('does not override a non-generic type even if the buffer looks different', () => {
    // A caller that deliberately set text/calendar (ICS import) is authoritative.
    expect(resolveMimeType('text/calendar', 'feed.ics', RANDOM)).toBe('text/calendar');
  });
});
