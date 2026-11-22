import path from 'node:path';

export type WhatsAppMediaType =
  | 'image'
  | 'video'
  | 'audio'
  | 'gif'
  | 'sticker'
  | 'document';

export interface ClassifiedMedia {
  mediaType: WhatsAppMediaType;
  mimeType: string;
}

const PREFIX_MAP: ReadonlyArray<readonly [string, WhatsAppMediaType]> = [
  ['IMG-', 'image'],
  ['VID-', 'video'],
  ['PTT-', 'audio'],
  ['AUD-', 'audio'],
  ['GIF-', 'gif'],
  ['STK-', 'sticker'],
  ['DOC-', 'document'],
];

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

export function classifyWhatsAppFilename(basename: string): ClassifiedMedia | null {
  let mediaType: WhatsAppMediaType | null = null;
  for (const [prefix, type] of PREFIX_MAP) {
    if (basename.startsWith(prefix)) {
      mediaType = type;
      break;
    }
  }
  if (!mediaType) return null;

  const ext = path.extname(basename).toLowerCase();
  const mimeType = EXT_MIME[ext] ?? 'application/octet-stream';
  return { mediaType, mimeType };
}
