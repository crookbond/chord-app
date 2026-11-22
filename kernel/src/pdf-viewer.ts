/**
 * Which files open in Chord's own PDF viewer (`mobile/app/file-viewer.tsx`).
 *
 * A sender's mail client often labels a PDF `application/octet-stream`, so
 * the type alone misses many real PDFs; a `.pdf` name under a generic type
 * counts too. A named type that is something else (`text/html`) never does,
 * whatever the name says.
 */
const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/acrobat']);
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/download', 'application/force-download']);

export function opensInPdfViewer(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
  const m = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (PDF_TYPES.has(m)) return true;
  if (!GENERIC_TYPES.has(m)) return false;
  return /\.pdf$/i.test((filename ?? '').trim());
}

/**
 * True when the bytes start like a PDF. The web viewer relabels the file as
 * `application/pdf` before showing it, so this is checked first: a file that
 * only CLAIMS to be a PDF is downloaded instead. The spec lets `%PDF-` sit
 * anywhere in the first 1024 bytes.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 1024) - 5;
  for (let i = 0; i <= end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}
