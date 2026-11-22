/**
 * A `Content-Disposition` value for any filename.
 *
 * Node refuses a header value holding a character above U+00FF, so a file
 * called "Menu – final.pdf" made the download throw rather than download.
 * The plain `filename=` gets an ASCII stand-in every client understands, and
 * `filename*=` (RFC 5987) carries the real name for the ones that read it.
 */
export function attachmentDisposition(filename: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const clean = filename.replace(/[\r\n]+/g, ' ').trim() || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  if (ascii === clean) return `${kind}; filename="${ascii}"`;
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Types a browser shows in place without running anything from the file. */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

const PASSIVE_TEXT = new Set(['text/plain', 'text/csv', 'text/calendar']);

/**
 * True for a type a browser would render as a document that can run script
 * on our origin: HTML/XHTML, SVG, XML, JavaScript, and any `text/*` beyond
 * plain/csv/calendar. An empty or unparseable type counts, since a browser
 * would sniff it.
 */
export function isActiveContentType(mimeType: string | null | undefined): boolean {
  const m = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!m || !m.includes('/')) return true;
  if (/(html|xml|svg|javascript|ecmascript)/.test(m)) return true;
  if (m.startsWith('text/') && !PASSIVE_TEXT.has(m)) return true;
  return false;
}

/**
 * Headers for serving a file someone ELSE chose the type of — an uploader, an
 * email sender (ADR 0269). Shown inline only for images (not SVG) and PDF, and
 * only when the caller wants that; everything else downloads. An active type
 * is served as `application/octet-stream`, so even a direct navigation cannot
 * render it as a page on our origin. `nosniff` stops a browser guessing back.
 */
export function safeFileHeaders(
  mimeType: string | null | undefined,
  filename: string,
  opts: { inline?: boolean } = {},
): Record<string, string> {
  const m = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const inline = !!opts.inline && INLINE_SAFE.has(m);
  const headers: Record<string, string> = {
    'content-type': isActiveContentType(m) ? 'application/octet-stream' : mimeType!,
    'content-disposition': attachmentDisposition(filename, inline ? 'inline' : 'attachment'),
    'x-content-type-options': 'nosniff',
  };
  // Anything that downloads also gets a sandbox CSP, belt and braces should a
  // browser render it anyway. Not on inline: those are only images and PDF,
  // and some viewers refuse to draw either under `default-src 'none'`.
  if (!inline) headers['content-security-policy'] = "default-src 'none'; sandbox";
  return headers;
}
