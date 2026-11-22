/**
 * EXIF-rotate + downscale step for image attachments.
 *
 * Phone photos routinely arrive at 12+ megapixels with portrait
 * orientation encoded as EXIF orientation=6 (rotate 90° CW). Sending
 * those bytes straight to a vision model is wasteful (token cost) and
 * sometimes wrong (text in landscape reads as garbage). This module
 * produces a normalized buffer that is:
 *
 *   - rotated upright per EXIF (the EXIF tag is then stripped, so the
 *     bytes are visually correct without depending on the reader to
 *     honor orientation),
 *   - downscaled so the longest edge is at most MAX_EDGE pixels,
 *   - re-encoded as JPEG quality 82 (good enough for vision OCR,
 *     small enough to keep base64 payloads in the low MB),
 *   - reported back with a metadata block the caller can persist into
 *     `attachments.image_meta` for later display.
 *
 * Animated GIFs and SVGs are passed through untouched — sharp's GIF
 * coalescing flattens animation and SVG rasterization needs a
 * separate path. PNG inputs that contain alpha are flattened to white
 * (vision models don't care; flattening avoids JPEG'ing alpha into
 * weird gray bands).
 */
import sharp from 'sharp';

import { logger } from '../../config/logging.js';

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 82;
const NORMALIZED_MIME = 'image/jpeg';

export interface ImageNormalizeMeta {
  /** Final pixel dimensions after rotate + downscale. */
  width: number;
  height: number;
  /** Pre-normalization dimensions reported by sharp's metadata read.
   *  Note: these are the *encoded* dimensions before EXIF rotation, so
   *  callers comparing to width/height should keep that in mind. */
  origWidth: number;
  origHeight: number;
  /** EXIF orientation tag from the source, if any (1-8). 1 = upright. */
  orientation: number | null;
  /** Bytes in the normalized buffer the caller will hand to vision. */
  sizeBytes: number;
  /** Bytes in the source buffer. */
  origSizeBytes: number;
  /** Mime of the normalized buffer (always image/jpeg for now). */
  mimeType: string;
  /** True when the rotate/scale pipeline ran. False when the input was
   *  passed through (animated GIF, SVG, decode failure). */
  normalized: boolean;
}

export interface NormalizedImage {
  buf: Buffer;
  mimeType: string;
  meta: ImageNormalizeMeta;
}

const PASSTHROUGH_MIMES = new Set(['image/gif', 'image/svg+xml']);

export async function normalizeImage(
  buf: Buffer,
  sourceMime: string,
): Promise<NormalizedImage> {
  const sourceLower = sourceMime.toLowerCase();
  if (PASSTHROUGH_MIMES.has(sourceLower)) {
    return passthrough(buf, sourceLower, 'passthrough mime');
  }

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buf).metadata();
  } catch (err) {
    logger.warn('image normalize: sharp.metadata failed; passing source through', {
      err: (err as Error).message,
    });
    return passthrough(buf, sourceLower, 'metadata read failed');
  }

  // Animated content (multi-frame GIF that slipped past the mime check, APNG,
  // animated WebP). Sharp's pipeline collapses to first frame; for vision that
  // is usually fine, but the original is small enough to keep.
  if ((meta.pages ?? 1) > 1) {
    return passthrough(buf, sourceLower, 'animated source');
  }

  const orientation = meta.orientation ?? null;
  const origWidth = meta.width ?? 0;
  const origHeight = meta.height ?? 0;

  try {
    let pipe = sharp(buf, { failOn: 'none' })
      // rotate() with no args reads EXIF orientation and bakes it in,
      // then strips the tag from output.
      .rotate();
    // After rotate(), sharp's effective dimensions are oriented. Pull
    // them via a metadata round-trip on the rotated pipeline so the
    // resize threshold compares apples to apples.
    const rotated = await pipe.toBuffer({ resolveWithObject: true });
    const rotW = rotated.info.width;
    const rotH = rotated.info.height;
    const maxEdge = Math.max(rotW, rotH);

    pipe = sharp(rotated.data, { failOn: 'none' });
    if (maxEdge > MAX_EDGE) {
      pipe = pipe.resize({
        width: rotW >= rotH ? MAX_EDGE : undefined,
        height: rotH > rotW ? MAX_EDGE : undefined,
        withoutEnlargement: true,
        fit: 'inside',
      });
    }
    // Flatten alpha to white so JPEG encoding doesn't muddy transparent regions.
    pipe = pipe.flatten({ background: { r: 255, g: 255, b: 255 } });
    const { data, info } = await pipe
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });

    return {
      buf: data,
      mimeType: NORMALIZED_MIME,
      meta: {
        width: info.width,
        height: info.height,
        origWidth,
        origHeight,
        orientation,
        sizeBytes: data.byteLength,
        origSizeBytes: buf.byteLength,
        mimeType: NORMALIZED_MIME,
        normalized: true,
      },
    };
  } catch (err) {
    logger.warn('image normalize: pipeline failed; passing source through', {
      err: (err as Error).message,
    });
    return passthrough(buf, sourceLower, 'pipeline failed', { origWidth, origHeight, orientation });
  }
}

function passthrough(
  buf: Buffer,
  mime: string,
  reason: string,
  extras?: { origWidth?: number; origHeight?: number; orientation?: number | null },
): NormalizedImage {
  logger.debug(`image normalize passthrough: ${reason}`);
  return {
    buf,
    mimeType: mime,
    meta: {
      width: extras?.origWidth ?? 0,
      height: extras?.origHeight ?? 0,
      origWidth: extras?.origWidth ?? 0,
      origHeight: extras?.origHeight ?? 0,
      orientation: extras?.orientation ?? null,
      sizeBytes: buf.byteLength,
      origSizeBytes: buf.byteLength,
      mimeType: mime,
      normalized: false,
    },
  };
}
