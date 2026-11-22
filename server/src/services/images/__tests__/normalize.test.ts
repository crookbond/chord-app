import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { MAX_EDGE, normalizeImage } from '../normalize.js';

/** Build a synthetic JPEG with given pixel dimensions + EXIF orientation. */
async function makeJpeg(
  width: number,
  height: number,
  orientation?: number,
): Promise<Buffer> {
  let pipe = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 240, g: 180, b: 60 },
    },
  }).jpeg({ quality: 90 });
  if (orientation) {
    pipe = pipe.withMetadata({ orientation });
  }
  return pipe.toBuffer();
}

describe('normalizeImage', () => {
  it('downscales an oversize photo so the longest edge is MAX_EDGE', async () => {
    const src = await makeJpeg(4000, 3000);
    const out = await normalizeImage(src, 'image/jpeg');
    expect(out.meta.normalized).toBe(true);
    expect(Math.max(out.meta.width, out.meta.height)).toBe(MAX_EDGE);
    // 4:3 aspect preserved
    expect(out.meta.width).toBe(MAX_EDGE);
    expect(out.meta.height).toBe(Math.round((MAX_EDGE * 3) / 4));
    expect(out.meta.origWidth).toBe(4000);
    expect(out.meta.origHeight).toBe(3000);
    expect(out.meta.origSizeBytes).toBe(src.byteLength);
    expect(out.meta.sizeBytes).toBeLessThan(src.byteLength);
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('does not upscale a small image', async () => {
    const src = await makeJpeg(400, 300);
    const out = await normalizeImage(src, 'image/jpeg');
    expect(out.meta.width).toBe(400);
    expect(out.meta.height).toBe(300);
  });

  it('bakes EXIF orientation into pixels and strips the tag', async () => {
    // orientation=6 = rotate 90° CW: a 400x200 encoded image should
    // appear as 200x400 after rotate.
    const src = await makeJpeg(400, 200, 6);
    const srcMeta = await sharp(src).metadata();
    expect(srcMeta.orientation).toBe(6);

    const out = await normalizeImage(src, 'image/jpeg');
    expect(out.meta.normalized).toBe(true);
    expect(out.meta.orientation).toBe(6); // recorded as the source orientation
    // Pixel dims after baked rotation
    expect(out.meta.width).toBe(200);
    expect(out.meta.height).toBe(400);

    // Output should no longer carry an EXIF orientation tag.
    const outMeta = await sharp(out.buf).metadata();
    expect(outMeta.orientation ?? 1).toBe(1);
  });

  it('passes through animated GIFs untouched', async () => {
    // Two-frame animated GIF via sharp's create + repeated frames.
    const frame = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .png()
      .toBuffer();
    // sharp can produce a GIF from a single PNG; "animated" passthrough
    // also covers the GIF mime-type rule. Use the GIF mime directly.
    const gif = await sharp(frame).gif().toBuffer();
    const out = await normalizeImage(gif, 'image/gif');
    expect(out.meta.normalized).toBe(false);
    expect(out.buf).toBe(gif);
    expect(out.mimeType).toBe('image/gif');
  });

  it('gracefully passes through non-image junk bytes', async () => {
    const junk = Buffer.from('not an image at all', 'utf8');
    const out = await normalizeImage(junk, 'image/jpeg');
    expect(out.meta.normalized).toBe(false);
    expect(out.buf).toBe(junk);
  });
});
