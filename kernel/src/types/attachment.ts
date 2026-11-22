import { z } from 'zod';
import type {
  AttachmentId,
  GroupId,
  IsoDateTime,
  UserId,
} from './ids';

/** Where an attachment lives / who can read it. */
export type AttachmentScope =
  | { kind: 'group'; groupId: GroupId }
  | { kind: 'user'; userId: UserId };

/** Structured metadata extracted by the vision LLM on image uploads.
 *  Mobile/web clients render the always-present fields and use the
 *  dimension/orientation fields for hover detail when available. */
/** Maximum tags persisted per image. */
export const MAX_IMAGE_TAGS = 8;
/** Per-tag length cap (post-normalize). */
export const MAX_IMAGE_TAG_LEN = 32;

/** Normalize a free-form vision-supplied tag into a search-friendly slug:
 *  lowercase, trim, collapse whitespace to hyphens, strip everything
 *  outside [a-z0-9-]. Returns null when the result is empty or too long. */
export function normalizeImageTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > MAX_IMAGE_TAG_LEN) return null;
  return slug;
}

export interface ImageMeta {
  caption: string | null;
  keyFacts: string[];
  /** Free-form vision-supplied tags (lowercase, kebab-cased on the way in).
   *  Open vocabulary by design — the model picks whatever makes sense for
   *  the picture (`coupon`, `pizza-menu`, `school-form`, `concert-ticket`).
   *  Folded into the attachment's `summary` so BM25 retrieval matches
   *  ("show me my coupons" finds anything tagged `coupon`). */
  tags: string[];
  mimeType: string;
  /** Mime of the source file as uploaded. May differ from `mimeType` when
   *  the server normalized HEIC/PNG to JPEG before vision. */
  sourceMimeType?: string;
  sizeBytes: number;
  ocrChars: number;
  /** Pixel dimensions of the normalized image sent to vision. */
  width?: number;
  height?: number;
  /** Pixel dimensions of the source as decoded (pre-EXIF-rotate). */
  origWidth?: number;
  origHeight?: number;
  /** EXIF orientation tag from the source (1-8). 1 = upright; null when absent. */
  orientation?: number | null;
  /** Bytes in the normalized JPEG sent to vision. */
  normalizedSizeBytes?: number;
  /** False when normalization was skipped (animated GIF, SVG, decode failure). */
  normalized?: boolean;
}

export interface Attachment {
  id: AttachmentId;
  scope: AttachmentScope;
  uploadedBy: UserId;
  filename: string;
  mimeType: string;
  size: number;
  /** Server-relative path under DATA_DIR. */
  path: string;
  /** Short LLM-generated or extracted text summary — injected as bot context. */
  summary?: string;
  /** Full extracted text, bounded in length. */
  extractedText?: string;
  /** Vision-derived structured metadata for image uploads. */
  imageMeta?: ImageMeta;
  /** If true, summary is always injected into bot turns in this group. */
  pinned: boolean;
  /** True when the binary is gone from server storage (row outlived its blob).
   *  The file can't be opened or sent until re-uploaded; search skips it. */
  blobMissing?: boolean;
  indexedAt?: IsoDateTime;
  /** Email thread this file was imported from (ADR 0071) — deep-link target
   *  `/email/<id>`. Null/absent once the source mailbox mirror is gone. */
  originEmailThreadId?: string;
  createdAt: IsoDateTime;
}

export const ShareAttachmentRequest = z.object({
  groupId: z.string().min(1),
});
export type ShareAttachmentRequest = z.infer<typeof ShareAttachmentRequest>;
