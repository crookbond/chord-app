import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

export interface UnzipResult {
  tempDir: string;
  entries: string[];
}

/**
 * Limits on what an uploaded export may unpack to (ADR 0269). The upload itself
 * is capped at 100 MB, but a zip is a promise about sizes, not a size: a few KB
 * can inflate to gigabytes. A real WhatsApp export is one `_chat.txt` plus its
 * media, which barely compresses, so these sit far above any real one.
 */
export const ZIP_MAX_ENTRIES = 10_000;
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export class ZipRejectedError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ZipRejectedError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: ZIP_MAX_ENTRIES, maxTotalBytes: ZIP_MAX_TOTAL_BYTES };

/** An entry name that stays inside the extraction folder once joined to it. */
function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false;
  return !norm.split('/').some((seg) => seg === '..');
}

/**
 * Checks every entry BEFORE anything is written: count, declared total size,
 * and names. adm-zip inflates an entry to at most its declared size, so the
 * declared total is a real bound — except for a declared size of 0, where it
 * applies no limit at all; a non-trivial compressed body claiming to be empty
 * is refused for that reason.
 */
function extractTo(zip: AdmZip, limits: ZipLimits): UnzipResult {
  const all = zip.getEntries();
  if (all.length > limits.maxEntries) {
    throw new ZipRejectedError(`zip has too many entries (${all.length}; limit ${limits.maxEntries})`);
  }
  let total = 0;
  for (const e of all) {
    if (!isSafeEntryName(e.entryName)) {
      throw new ZipRejectedError(`zip entry has an unsafe path: ${e.entryName.slice(0, 120)}`);
    }
    if (e.isDirectory) continue;
    if (e.header.size === 0 && e.header.compressedSize > 64) {
      throw new ZipRejectedError(`zip entry declares no size: ${e.entryName.slice(0, 120)}`);
    }
    total += e.header.size;
    if (total > limits.maxTotalBytes) {
      throw new ZipRejectedError(`zip unpacks to more than ${limits.maxTotalBytes} bytes`);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-whatsapp-'));
  const root = path.resolve(tempDir) + path.sep;
  const entries: string[] = [];
  try {
    for (const e of all) {
      if (e.isDirectory) continue;
      const dest = path.resolve(tempDir, e.entryName.replace(/\\/g, '/'));
      if (!dest.startsWith(root)) {
        throw new ZipRejectedError(`zip entry has an unsafe path: ${e.entryName.slice(0, 120)}`);
      }
      const data = e.getData();
      if (data.length > e.header.size && e.header.size > 0) {
        throw new ZipRejectedError(`zip entry larger than declared: ${e.entryName.slice(0, 120)}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      entries.push(e.entryName);
    }
  } catch (err) {
    cleanupTempDir(tempDir);
    throw err;
  }
  return { tempDir, entries };
}

export function extractZip(zipPath: string, limits: ZipLimits = DEFAULT_LIMITS): UnzipResult {
  return extractTo(new AdmZip(zipPath), limits);
}

export function extractZipFromBuffer(buffer: Buffer, limits: ZipLimits = DEFAULT_LIMITS): UnzipResult {
  return extractTo(new AdmZip(buffer), limits);
}

export function cleanupTempDir(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
