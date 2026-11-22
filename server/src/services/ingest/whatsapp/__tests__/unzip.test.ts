import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDir, extractZipFromBuffer, ZipRejectedError } from '../unzip.js';

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    cleanupTempDir(d);
  }
});

describe('extractZipFromBuffer', () => {
  it('extracts all non-directory entries and lists their names', () => {
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from('[27/09/22, 11:27:35 PM] A: hi\n'));
    zip.addFile('IMG-20240314-WA0001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
    zip.addFile('nested/DOC-x.pdf', Buffer.from('%PDF-1.4'));
    const buf = zip.toBuffer();

    const { tempDir, entries } = extractZipFromBuffer(buf);
    createdDirs.push(tempDir);

    expect(entries).toContain('_chat.txt');
    expect(entries).toContain('IMG-20240314-WA0001.jpg');
    expect(entries).toContain('nested/DOC-x.pdf');
    expect(fs.existsSync(path.join(tempDir, '_chat.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'nested', 'DOC-x.pdf'))).toBe(true);
  });

  it('cleanupTempDir removes the extracted directory', () => {
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from('hi'));
    const { tempDir } = extractZipFromBuffer(zip.toBuffer());
    expect(fs.existsSync(tempDir)).toBe(true);
    cleanupTempDir(tempDir);
    expect(fs.existsSync(tempDir)).toBe(false);
  });
});

// ADR 0269 — an upload is capped at 100 MB, but nothing capped what it
// unpacked to, how many files it held, or where they landed.
describe('extractZipFromBuffer limits', () => {
  it('refuses a zip with more entries than the limit, writing nothing', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 6; i++) zip.addFile(`f${i}.txt`, Buffer.from('x'));
    expect(() => extractZipFromBuffer(zip.toBuffer(), { maxEntries: 5, maxTotalBytes: 1e9 })).toThrow(ZipRejectedError);
  });

  it('refuses a zip that unpacks past the size limit (a zip bomb)', () => {
    const zip = new AdmZip();
    // 4 MB of zeros compresses to a few KB.
    zip.addFile('_chat.txt', Buffer.alloc(4 * 1024 * 1024));
    const buf = zip.toBuffer();
    expect(buf.length).toBeLessThan(64 * 1024);
    expect(() => extractZipFromBuffer(buf, { maxEntries: 10, maxTotalBytes: 1024 * 1024 })).toThrow(/more than/);
  });

  it('refuses an entry that climbs out of the extraction folder', () => {
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from('hi'));
    zip.addFile('placeholder.txt', Buffer.from('owned'));
    // adm-zip normalises names on addFile; set the raw name the way a crafted
    // archive carries it.
    zip.getEntries()[1]!.entryName = '../../escaped.txt';
    expect(() => extractZipFromBuffer(zip.toBuffer())).toThrow(/unsafe path/);
  });

  it('a real export still unpacks under the default limits', () => {
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from('[27/09/22, 11:27:35 PM] A: hi\n'));
    zip.addFile('IMG-1.jpg', Buffer.alloc(200 * 1024, 7));
    const { tempDir, entries } = extractZipFromBuffer(zip.toBuffer());
    createdDirs.push(tempDir);
    expect(entries.sort()).toEqual(['IMG-1.jpg', '_chat.txt']);
  });
});
