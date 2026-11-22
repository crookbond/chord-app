import { createRequire } from 'node:module';

import { MAX_IMAGE_TAGS, fileFormat, normalizeImageTag } from '@chord/kernel';

import { env } from '../config/env.js';
import { readBlob } from '../db/crypto/index.js';
import { logger } from '../config/logging.js';
import { debugSnippet } from '../utils/prompt-log.js';
import { decodeText } from '../utils/text-decode.js';
import { htmlToText, stripInvisible } from '../utils/email-text.js';
import { parseJsonArray, parseJsonLoose, parseJsonObject } from '../utils/json-repair.js';
import type { LlmService } from './llm/types.js';
import { normalizeImage } from './images/normalize.js';
import { OFFICE_TEXT_FORMATS, extractOfficeText, type OfficeTextFormat } from './office-text.js';

/** Max characters of extracted text we keep/inject into bot context. */
const MAX_TEXT_CHARS = 40_000;
const SUMMARY_MAX_TOKENS = 400;

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'ini', 'conf',
]);

function looksTexty(mime: string, filename: string): boolean {
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTS.has(ext);
}

// pdfjs-dist checks for browser globals at module load time even when only
// doing text extraction. Install minimal stubs so the load succeeds on Node 18.
function ensurePdfjsGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g['DOMMatrix']) g['DOMMatrix'] = class DOMMatrix {};
  if (!g['ImageData']) {
    g['ImageData'] = class ImageData {
      constructor(public data: Uint8ClampedArray, public width: number, public height?: number) {}
    };
  }
  // Path2D: pdfjs-dist uses this for vector drawing. The stub below records
  // commands so renderPdfFirstPage can replay them via the canvas context.
  if (!g['Path2D']) g['Path2D'] = makePath2DClass();
  // process.getBuiltinModule is Node 22+; pdfjs-dist uses it to get
  // createRequire so it can load the `canvas` package. On Node 18 we shim it
  // with the real createRequire from node:module — pdfjs-dist then finds the
  // canvas package and uses it for internal canvas creation during rendering.
  if (!(process as unknown as Record<string, unknown>)['getBuiltinModule']) {
    (process as unknown as Record<string, unknown>)['getBuiltinModule'] = (name: string) =>
      name === 'module' ? { createRequire } : undefined;
  }
}

type PathCmd = { op: string; args: (number | boolean)[] };

 
function makePath2DClass(): any {
  return class Path2DImpl {
    _cmds: PathCmd[] = [];
    moveTo(x: number, y: number) { this._cmds.push({ op: 'moveTo', args: [x, y] }); }
    lineTo(x: number, y: number) { this._cmds.push({ op: 'lineTo', args: [x, y] }); }
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) {
      this._cmds.push({ op: 'bezierCurveTo', args: [cp1x, cp1y, cp2x, cp2y, x, y] });
    }
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
      this._cmds.push({ op: 'quadraticCurveTo', args: [cpx, cpy, x, y] });
    }
    arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean) {
      this._cmds.push({ op: 'arc', args: [x, y, r, start, end, !!ccw] });
    }
    arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
      this._cmds.push({ op: 'arcTo', args: [x1, y1, x2, y2, r] });
    }
    ellipse(x: number, y: number, rx: number, ry: number, rot: number, start: number, end: number, ccw?: boolean) {
      this._cmds.push({ op: 'ellipse', args: [x, y, rx, ry, rot, start, end, !!ccw] });
    }
    rect(x: number, y: number, w: number, h: number) {
      this._cmds.push({ op: 'rect', args: [x, y, w, h] });
    }
    closePath() { this._cmds.push({ op: 'closePath', args: [] }); }

     
    replayOn(ctx: any) {
      ctx.beginPath();
      for (const { op, args } of this._cmds) {
        if (typeof ctx[op] === 'function') (ctx[op] as (...a: unknown[]) => unknown)(...args);
      }
    }
  };
}

let ctxPrototypePatched = false;

/** Patch the node-canvas context prototype once so every context — including
 *  ones pdfjs-dist creates internally for transparency groups — handles our
 *  Path2DImpl objects in fill / stroke / clip. */
 
function patchCanvasPrototype(sampleCtx: any): void {
  if (ctxPrototypePatched) return;
  ctxPrototypePatched = true;
  const proto = Object.getPrototypeOf(sampleCtx);
  const isPath2D = (v: unknown) => v !== null && typeof v === 'object' && '_cmds' in v;
   
  const replay = (path: any, ctx: any) => (path as { replayOn: (c: unknown) => void }).replayOn(ctx);

  const origFill = proto.fill;
  proto.fill = function (pathOrRule?: unknown, rule?: string) {
    if (isPath2D(pathOrRule)) {
      replay(pathOrRule, this);
      if (rule !== undefined) origFill.call(this, rule); else origFill.call(this);
    } else origFill.call(this, pathOrRule, rule);
  };
  const origStroke = proto.stroke;
  proto.stroke = function (path?: unknown) {
    if (isPath2D(path)) { replay(path, this); origStroke.call(this); }
    else origStroke.call(this);
  };
  if (proto.clip) {
    const origClip = proto.clip;
    proto.clip = function (pathOrRule?: unknown, rule?: string) {
      if (isPath2D(pathOrRule)) {
        replay(pathOrRule, this);
        if (rule !== undefined) origClip.call(this, rule); else origClip.call(this);
      } else origClip.call(this, pathOrRule, rule);
    };
  }
}

async function extractPdfText(path: string): Promise<string> {
  ensurePdfjsGlobals();
  const { PDFParse } = await import('pdf-parse');
  const buf = await readBlob(path);
  const parser = new PDFParse({ data: buf });
  try {
    const res = await parser.getText();
    return res.text ?? '';
  } finally {
    await parser.destroy();
  }
}

export interface ExtractResult {
  text: string;
  summary?: string;
  /** PNG of the first page — present when text extraction returned empty (image-only PDF). */
  pageImage?: Buffer;
  /** JSON-serialized vision metadata for image uploads. */
  imageMeta?: string;
  /** ADR 0021 Tier-2 — natural questions this doc answers, for the questions index. */
  answerableQuestions?: string[];
}

const QUESTIONS_MAX_TOKENS = 300;

/**
 * ADR 0021 Tier-2 — generate the natural questions a family member would ask
 * that this document answers, phrased the way people *ask* (synonyms, casual
 * wording) rather than how the document reads. Indexed as a high-weight chunk
 * so question-shaped queries match even when the prose uses different words.
 * Best-effort: any failure returns [] and indexing proceeds without it.
 */
async function generateAnswerableQuestions(
  filename: string,
  context: string,
  llm: LlmService,
): Promise<string[]> {
  if (!context.trim()) return [];
  try {
    const raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            'You generate the 3–6 natural questions a family/group member would ask that THIS document answers. ' +
            'Use the words people actually say (e.g. "shots" not just "vaccine", "game" not just "match"), not the document\'s phrasing. ' +
            'Return ONLY a JSON array of question strings — no prose, no keys.',
        },
        { role: 'user', content: `File: ${filename}\n\n---\n${context.slice(0, 8_000)}\n---` },
      ],
      { maxTokens: QUESTIONS_MAX_TOKENS, temperature: 0.3 },
    );
    const arr = parseJsonArray(raw);
    if (!arr) return [];
    return arr
      .map((q) => String(q).trim())
      .filter((q) => q.length > 0)
      .slice(0, 8);
  } catch (err) {
    logger.warn(`answerable-questions gen failed for ${filename}`, { err });
    return [];
  }
}

const VISION_SUPPORTED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp']);

function isImage(mime: string, filename: string): boolean {
  if (mime.startsWith('image/')) return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

async function extractImageViaVision(opts: {
  path: string;
  mimeType: string;
  filename: string;
  llm: LlmService;
}): Promise<ExtractResult> {
  const mime = opts.mimeType.toLowerCase();
  if (!VISION_SUPPORTED_MIME.has(mime)) {
    logger.info(`${opts.filename}: image mime ${mime} not supported by vision — skipping extraction`);
    return { text: '' };
  }
  const sourceBuf = await readBlob(opts.path);
  // EXIF-rotate + downscale before vision. Saves tokens on big phone
  // photos and keeps text in rotated photos right-side-up. image_meta
  // carries the original + normalized dimensions so the UI can show
  // them on hover and the bot can decide whether to re-look.
  const normalized = await normalizeImage(sourceBuf, mime);
  const base64 = normalized.buf.toString('base64');
  const llm = opts.llm;
  let raw: string;
  try {
    raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            'You analyse images uploaded to a family/group chat assistant. ' +
            'Reply with ONLY a single JSON object (no prose, no code fences) with these exact keys: ' +
            '{"caption": string — one short sentence describing what the image shows; ' +
            '"ocrText": string — verbatim text visible in the image, joined with newlines, empty string if none; ' +
            '"keyFacts": string[] — 0-8 short bullet-style facts (dates, names, places, amounts, IDs, totals, addresses, phone numbers); ' +
            '"tags": string[] — 0-5 short classification tags you choose freely to describe WHAT KIND of image this is and WHAT TOPIC it covers. ' +
            'Lowercase, kebab-case, one or two words each (e.g. "coupon", "receipt", "boarding-pass", "school-form", "pizza-menu", "concert-ticket", "vaccination-record", "lease-document", "vacation-photo", "screenshot"). ' +
            'Prefer common, searchable nouns over adjectives — the user will later ask things like "show me my coupons" or "find my school forms", so the tag should match how a person would name the category. ' +
            'Always include a top-level category tag (coupon / receipt / ticket / menu / form / document / screenshot / photo / etc.) when it clearly applies. ' +
            'Skip tags you are not confident about; empty array is fine.}',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `File: ${opts.filename}` },
            { type: 'image', mimeType: normalized.mimeType, base64 },
          ],
        },
      ],
      // A text-heavy screenshot produces a long ocrText; 600 tokens truncated
      // the JSON mid-string for those (→ unparseable → no tags/trips), while
      // sparse photos fit. Give it room.
      { maxTokens: 1500, temperature: 0.1 },
    );
  } catch (err) {
    logger.warn(`vision extract failed for ${opts.filename}`, { err });
    return { text: '' };
  }
  // Strict object parse first; fall back to the repairing loose parser, which
  // can close an unterminated object from a truncated/over-long response so we
  // still recover caption/tags instead of dropping the whole extraction.
  let parsed = parseJsonObject(raw);
  if (!parsed) {
    const loose = parseJsonLoose(raw);
    if (loose && typeof loose === 'object' && !Array.isArray(loose)) {
      parsed = loose as Record<string, unknown>;
    }
  }
  if (!parsed) {
    // Log a snippet of what the model actually returned — without it we can't
    // tell an empty completion from a refusal, prose, or a provider wrapper.
    logger.warn(`vision extract returned unparseable JSON for ${opts.filename}`, {
      rawLen: raw.length,
      rawSnippet: debugSnippet(raw, 500, env.NODE_ENV),
    });
    return { text: '' };
  }
  const caption = String(parsed['caption'] ?? '').trim();
  const ocrText = String(parsed['ocrText'] ?? '').slice(0, MAX_TEXT_CHARS);
  const keyFactsRaw = parsed['keyFacts'];
  const keyFacts: string[] = Array.isArray(keyFactsRaw)
    ? keyFactsRaw.map((f) => String(f).trim()).filter((f) => f.length > 0).slice(0, 12)
    : [];
  // Open vocabulary — the model picks the tags, we just normalize them.
  // Dedup + cap so a chatty model can't flood the summary with weak tags.
  const tagsRaw = parsed['tags'];
  const tags: string[] = Array.isArray(tagsRaw)
    ? Array.from(
        new Set(
          tagsRaw.map(normalizeImageTag).filter((t): t is string => t !== null),
        ),
      ).slice(0, MAX_IMAGE_TAGS)
    : [];

  // Fold tags into the summary so BM25 indexing picks them up — that's
  // what lets "show me my coupons" later match this image.
  const summaryLines: string[] = [];
  if (tags.length) summaryLines.push(`Tags: ${tags.join(', ')}`);
  if (caption) summaryLines.push(caption);
  if (keyFacts.length) summaryLines.push(...keyFacts.map((f) => `- ${f}`));
  const summary = summaryLines.length ? summaryLines.join('\n') : undefined;

  const imageMeta = JSON.stringify({
    caption: caption || null,
    keyFacts,
    tags,
    mimeType: mime,
    sourceMimeType: mime,
    sizeBytes: sourceBuf.byteLength,
    ocrChars: ocrText.length,
    width: normalized.meta.width,
    height: normalized.meta.height,
    origWidth: normalized.meta.origWidth,
    origHeight: normalized.meta.origHeight,
    orientation: normalized.meta.orientation,
    normalizedSizeBytes: normalized.meta.sizeBytes,
    normalized: normalized.meta.normalized,
  });

  const answerableQuestions = await generateAnswerableQuestions(
    opts.filename,
    [caption, keyFacts.join('\n'), ocrText].filter(Boolean).join('\n'),
    llm,
  );

  return { text: ocrText, summary, imageMeta, answerableQuestions };
}

/** Shape we use from the optional `canvas` package. Typed inline so typecheck
 *  doesn't require the native module to be installed. */
type CanvasMod = {
  DOMMatrix: unknown;
  ImageData: unknown;
  createCanvas: (w: number, h: number) => {
    width: number;
    height: number;
    getContext: (kind: '2d') => unknown;
    toBuffer: (mime: string) => Buffer;
  };
};

/** Render the first page of a PDF to a PNG buffer using pdfjs-dist + canvas. */
async function renderPdfFirstPage(filePath: string): Promise<Buffer | null> {
  try {
    // Upgrade the DOMMatrix + ImageData stubs to real canvas implementations.
    const canvasMod = (await import('canvas' as string)) as CanvasMod;
    const g = globalThis as Record<string, unknown>;
    g['DOMMatrix'] = canvasMod.DOMMatrix;
    g['ImageData'] = canvasMod.ImageData;

    // Patch the canvas context prototype once so every context handles our
    // Path2DImpl in fill / stroke / clip.
    const probe = canvasMod.createCanvas(1, 1).getContext('2d');
    patchCanvasPrototype(probe);

    // pdfjs-dist's default NodeCanvasFactory requires @napi-rs/canvas (not
    // installed). Pass our own CanvasFactory class (capital C — pdfjs-dist
    // instantiates it with `new`) that uses the `canvas` package instead.
     
    class NodeCanvasFactoryImpl {
       
      create(width: number, height: number): any {
        const c = canvasMod.createCanvas(width, height);
        return { canvas: c, context: c.getContext('2d') };
      }
       
      reset(cc: any, width: number, height: number): void {
        cc.canvas.width = width;
        cc.canvas.height = height;
      }
       
      destroy(cc: any): void {
        cc.canvas.width = 0;
        cc.canvas.height = 0;
      }
    }

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = await readBlob(filePath);
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(data),
       
      CanvasFactory: NodeCanvasFactoryImpl as any,
    }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
     
    await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;
    await pdf.destroy();
    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.warn('PDF page render failed', { err });
    return null;
  }
}

/**
 * Postgres `text` cannot hold U+0000 — the driver raises `22021 invalid byte
 * sequence for encoding "UTF8": 0x00` — and PDF text layers produce them
 * routinely (five prod receipts and invoices in one afternoon). The throw
 * lands in the indexing catch, so the file ends up with no text, no summary,
 * no chunks and no FTS row, and the recovery pass retries it forever.
 *
 * Stripped at extraction rather than at the write: a NUL is noise from the
 * decoder in every consumer — the summary prompt, the chunker, the classifier
 * — not just the one that happens to raise. Other C0 controls are left alone;
 * they store fine and a form feed is real page structure.
 */
export const stripNulls = (s: string): string => s.replace(/\0/g, '');

export async function extractAndSummarize(opts: {
  path: string;
  mimeType: string;
  filename: string;
  /** Whose model reads this file - the uploader's own key if they have one (ADR 0257). */
  llm: LlmService;
}): Promise<ExtractResult> {
  if (isImage(opts.mimeType, opts.filename)) {
    return extractImageViaVision(opts);
  }
  const isPdf = opts.mimeType === 'application/pdf' || opts.filename.toLowerCase().endsWith('.pdf');
  let text = '';
  // ADR 0310 - Word, Excel, PowerPoint, OpenDocument and RTF are read as text
  // too, so they are searchable and reach the auto-filers like a PDF.
  const format = fileFormat(opts.mimeType, opts.filename);
  const officeFormat = format && OFFICE_TEXT_FORMATS.has(format) ? (format as OfficeTextFormat) : null;
  try {
    if (officeFormat) {
      text = extractOfficeText(await readBlob(opts.path), officeFormat);
    } else if (looksTexty(opts.mimeType, opts.filename)) {
      text = decodeText(await readBlob(opts.path));
      // ADR 0268 — an HTML file is read as it renders, not as its markup.
      if (/^text\/html\b/i.test(opts.mimeType) || /\.x?html?$/i.test(opts.filename)) text = htmlToText(text);
    } else if (isPdf) {
      text = await extractPdfText(opts.path);
    }
  } catch (err) {
    logger.warn(`extract failed for ${opts.filename}`, { err });
  }

  // Image-only PDF (screenshot, scan): render page 1 for vision classification.
  if (!text && isPdf) {
    const pageImage = await renderPdfFirstPage(opts.path);
    if (pageImage) {
      logger.info(`${opts.filename}: no text layer — rendered page 1 for vision`);
      return { text: '', pageImage };
    }
    return { text: '' };
  }
  text = stripInvisible(stripNulls(text));
  if (!text) return { text: '' };

  text = text.slice(0, MAX_TEXT_CHARS);

  let summary: string | undefined;
  try {
    summary = await opts.llm.complete(
      [
        {
          role: 'system',
          content:
            'You summarise user-uploaded documents for a family/group chat assistant. ' +
            'Produce a concise bullet-style summary capturing dates, IDs, names, and key facts. ' +
            'For travel documents list EVERY flight leg separately (e.g. "Leg 1: EWR→BZN UA297 Jul 12 07:39; Leg 2: BZN→EWR UA298 Jul 19 11:00"). ' +
            'Never collapse multiple legs into one line. Omit greetings and meta-commentary.',
        },
        {
          role: 'user',
          content: `File: ${opts.filename}\n\n---\n${text.slice(0, 12_000)}\n---`,
        },
      ],
      { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.2 },
    );
  } catch (err) {
    logger.warn(`summarise failed for ${opts.filename}`, { err });
  }

  const answerableQuestions = await generateAnswerableQuestions(
    opts.filename,
    summary ? `${summary}\n\n${text}` : text,
    opts.llm,
  );

  return { text, summary, answerableQuestions };
}
