/**
 * Which files open inside Chord (`mobile/app/file-viewer.tsx`), and how (ADR 0310).
 *
 * A file's format comes from its type and name together. A sender's mail
 * client often labels a file `application/octet-stream` (or a Word file
 * `application/zip`), so under a generic type the name decides. A named
 * type that is something else (`text/html`) never opens, whatever the name
 * says. Before a file is shown its first bytes are checked against the
 * format (`bytesMatchFormat`); a file that only CLAIMS to be one is handed
 * to Share / Download instead.
 *
 * How it is drawn depends on the platform:
 * - `native`: the platform draws it itself. On iOS that is the web view,
 *   which renders Office and iWork files, RTF, images, audio and video from a
 *   local file; on web, the browser's own PDF/image/media viewer.
 * - `pdfjs`: Android's web view cannot draw a PDF, so pdf.js does.
 * - `docx` / `sheet` / `text` / `image`: Chord draws it in a page of its own
 *   (docx-preview, SheetJS, escaped text, an <img>), on the device.
 * Anything else (HTML, SVG, PowerPoint on Android) is not shown in Chord.
 */

import { looksLikePdf } from './pdf-viewer';

export type FileFormat =
  | 'pdf'
  | 'image'
  | 'heic'
  | 'text'
  | 'csv'
  | 'docx'
  | 'doc'
  | 'rtf'
  | 'odt'
  | 'xlsx'
  | 'xls'
  | 'ods'
  | 'pptx'
  | 'ppt'
  | 'odp'
  | 'pages'
  | 'numbers'
  | 'key'
  | 'audio'
  | 'video';

export type FileRenderer = 'native' | 'pdfjs' | 'docx' | 'sheet' | 'text' | 'image';

export type ViewerPlatform = 'ios' | 'android' | 'web';

export interface FileViewerPlan {
  format: FileFormat;
  renderer: FileRenderer;
}

const GENERIC_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
  'application/force-download',
  'application/x-download',
  'application/unknown',
  // Office files are zip archives and some clients say so.
  'application/zip',
  'application/x-zip-compressed',
]);

const TYPE_FORMATS: Record<string, FileFormat> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/acrobat': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/pjpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/x-markdown': 'text',
  'application/json': 'text',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.apple.pages': 'pages',
  'application/x-iwork-pages-sffpages': 'pages',
  'application/vnd.apple.numbers': 'numbers',
  'application/x-iwork-numbers-sffnumbers': 'numbers',
  'application/vnd.apple.keynote': 'key',
  'application/x-iwork-keynote-sffkey': 'key',
};

const EXT_FORMATS: Record<string, FileFormat> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  heic: 'heic',
  heif: 'heic',
  txt: 'text',
  text: 'text',
  md: 'text',
  markdown: 'text',
  json: 'text',
  log: 'text',
  yaml: 'text',
  yml: 'text',
  csv: 'csv',
  tsv: 'csv',
  docx: 'docx',
  doc: 'doc',
  rtf: 'rtf',
  odt: 'odt',
  xlsx: 'xlsx',
  xls: 'xls',
  ods: 'ods',
  pptx: 'pptx',
  ppt: 'ppt',
  odp: 'odp',
  pages: 'pages',
  numbers: 'numbers',
  key: 'key',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
};

/** Formats in the same family as a named type: `application/msword` on a
 *  `.docx`, `text/plain` on a `.csv`. The name is the finer answer there. */
const FAMILY: Record<FileFormat, string> = {
  pdf: 'pdf',
  image: 'image',
  heic: 'image',
  text: 'text',
  csv: 'text',
  docx: 'word',
  doc: 'word',
  rtf: 'word',
  odt: 'word',
  xlsx: 'sheet',
  xls: 'sheet',
  ods: 'sheet',
  pptx: 'slides',
  ppt: 'slides',
  odp: 'slides',
  pages: 'word',
  numbers: 'sheet',
  key: 'slides',
  audio: 'audio',
  video: 'video',
};

/** A CSV is text and a spreadsheet: Windows labels one `application/vnd.ms-excel`. */
function sameFamily(a: FileFormat, b: FileFormat): boolean {
  if (FAMILY[a] === FAMILY[b]) return true;
  return (a === 'csv' && FAMILY[b] === 'sheet') || (b === 'csv' && FAMILY[a] === 'sheet');
}

function baseType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
}

function extFormat(filename: string | null | undefined): FileFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec((filename ?? '').trim());
  return m ? (EXT_FORMATS[m[1]!.toLowerCase()] ?? null) : null;
}

/** The file's format, or null when Chord does not know it (or will not show it). */
export function fileFormat(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): FileFormat | null {
  const t = baseType(mimeType);
  const byExt = extFormat(filename);
  if (GENERIC_TYPES.has(t)) return byExt;
  let byType: FileFormat | null = TYPE_FORMATS[t] ?? null;
  if (!byType && t.startsWith('audio/')) byType = 'audio';
  if (!byType && t.startsWith('video/')) byType = 'video';
  if (!byType) return null;
  if (byExt && sameFamily(byExt, byType)) return byExt;
  return byType;
}

const RENDERERS: Record<ViewerPlatform, Partial<Record<FileFormat, FileRenderer>>> = {
  ios: {
    pdf: 'native',
    image: 'native',
    heic: 'native',
    // Our own page for text: the web view would render a `.txt` as text, but
    // a page that only ever escapes text cannot be talked into anything else.
    text: 'text',
    csv: 'sheet',
    docx: 'native',
    doc: 'native',
    rtf: 'native',
    xlsx: 'native',
    xls: 'native',
    ods: 'sheet',
    pptx: 'native',
    ppt: 'native',
    pages: 'native',
    numbers: 'native',
    key: 'native',
    audio: 'native',
    video: 'native',
  },
  android: {
    pdf: 'pdfjs',
    image: 'image',
    text: 'text',
    csv: 'sheet',
    docx: 'docx',
    xlsx: 'sheet',
    xls: 'sheet',
    ods: 'sheet',
  },
  web: {
    pdf: 'native',
    image: 'native',
    text: 'text',
    csv: 'sheet',
    docx: 'docx',
    xlsx: 'sheet',
    xls: 'sheet',
    ods: 'sheet',
    audio: 'native',
    video: 'native',
  },
};

/** How this file is shown inside Chord on this platform, or null to hand it
 *  to Share / Download / another app as before. */
export function fileViewerPlan(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
  platform: string,
): FileViewerPlan | null {
  const format = fileFormat(mimeType, filename);
  if (!format) return null;
  const table = RENDERERS[platform as ViewerPlatform];
  const renderer = table?.[format];
  return renderer ? { format, renderer } : null;
}

export function opensInFileViewer(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
  platform: string,
): boolean {
  return fileViewerPlan(mimeType, filename, platform) !== null;
}

/** The type a viewer hands the platform for this format. The web viewer
 *  relabels a fetched file with it, so only types a browser shows inertly
 *  are listed; null = keep the file's own (audio/video). */
export function viewerMimeType(format: FileFormat, filename?: string | null): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec((filename ?? '').trim())?.[1]?.toLowerCase();
  switch (format) {
    case 'pdf':
      return 'application/pdf';
    case 'image':
      if (ext === 'png') return 'image/png';
      if (ext === 'gif') return 'image/gif';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'bmp') return 'image/bmp';
      return 'image/jpeg';
    case 'heic':
      return 'image/heic';
    case 'audio':
      if (ext === 'mp3') return 'audio/mpeg';
      if (ext === 'wav') return 'audio/wav';
      if (ext === 'aac') return 'audio/aac';
      return 'audio/mp4';
    case 'video':
      return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
    default:
      return null;
  }
}

const FORMAT_EXTENSION: Partial<Record<FileFormat, string>> = {
  pdf: 'pdf',
  heic: 'heic',
  text: 'txt',
  csv: 'csv',
  docx: 'docx',
  doc: 'doc',
  rtf: 'rtf',
  odt: 'odt',
  xlsx: 'xlsx',
  xls: 'xls',
  ods: 'ods',
  pptx: 'pptx',
  ppt: 'ppt',
  odp: 'odp',
  pages: 'pages',
  numbers: 'numbers',
  key: 'key',
};

/**
 * The name a downloaded copy is saved under. iOS's web view picks how to draw
 * a local file by its extension, so a Word file named `letter` (its type said
 * what it was) is saved as `letter.docx`. A name already ending in one of the
 * format's extensions is left alone.
 */
export function viewerFileName(filename: string, format: FileFormat | null): string {
  const want = format ? FORMAT_EXTENSION[format] : undefined;
  if (!want) return filename;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext && EXT_FORMATS[ext] === format) return filename;
  return `${filename}.${want}`;
}

function startsWith(bytes: Uint8Array, at: number, sig: number[]): boolean {
  if (bytes.length < at + sig.length) return false;
  return sig.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * True when the first bytes (at least the first 1024 when the file is that
 * long) look like this format. Checked before showing, so a page whose name
 * says `.docx` but whose bytes are HTML is never drawn.
 */
export function bytesMatchFormat(format: FileFormat, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  switch (format) {
    case 'pdf':
      return looksLikePdf(bytes);
    case 'image':
      return (
        startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47]) ||
        startsWith(bytes, 0, [0xff, 0xd8, 0xff]) ||
        startsWith(bytes, 0, ascii('GIF8')) ||
        (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP'))) ||
        startsWith(bytes, 0, ascii('BM'))
      );
    case 'heic':
      return startsWith(bytes, 4, ascii('ftyp'));
    case 'text':
    case 'csv': {
      const end = Math.min(bytes.length, 1024);
      for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
      return true;
    }
    case 'rtf':
      return startsWith(bytes, 0, ascii('{\\rtf'));
    case 'doc':
    case 'xls':
    case 'ppt':
      return startsWith(bytes, 0, OLE);
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'odt':
    case 'ods':
    case 'odp':
    case 'pages':
    case 'numbers':
    case 'key':
      return startsWith(bytes, 0, ZIP);
    case 'audio':
    case 'video':
      // Drawn only by the platform's player under a media type, which never
      // runs a page whatever the bytes are.
      return true;
  }
}
