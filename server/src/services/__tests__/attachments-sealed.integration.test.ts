/**
 * Attachment files sealed at rest (ADR 0201), end to end: what lands on disk,
 * everything that has to keep working when it is sealed (extraction, download,
 * sending as mail, copying to another group), and the backfill that seals what
 * predates it. The failure cases are the ones that matter: erased keys, missing
 * files, interrupted runs.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import {
  blobIsSealed,
  contentCrypto,
  isSealedFile,
  KeyDestroyedError,
  readBlob,
  setContentEncryption,
} from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import {
  absolutePathFor,
  copyAttachmentToGroup,
  getAttachment,
  saveFile,
} from '@/services/attachments.service.js';
import { loadOutgoingAttachments } from '@/services/email/outgoing-attachments.js';
import { sealExistingAttachments } from '@/services/encryption/backfill-files.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const MARKER = 'ZEBRA-CONFIRMATION-KX8QP2';
const PLAIN = Buffer.from(`Itinerary ${MARKER}\nFlight UA512 departs 09:40\n`);

let db: Kysely<DB>;
let userId: string;
let groupId: string;
const made: string[] = [];

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  made.push(groupId);
});
afterEach(async () => {
  await closeTestDb(db);
  for (const g of made.splice(0)) {
    await fs.rm(path.join(env.FILES_DIR, 'group', g), { recursive: true, force: true });
  }
  await fs.rm(path.join(env.FILES_DIR, 'user', userId), { recursive: true, force: true });
});

async function save(
  opts: { buffer?: Buffer; filename?: string; mimeType?: string; scope?: 'group' | 'user'; group?: string } = {},
) {
  return saveFile(db, {
    scope:
      opts.scope === 'user'
        ? { kind: 'user', userId }
        : { kind: 'group', groupId: opts.group ?? groupId },
    uploadedBy: userId,
    filename: opts.filename ?? 'itinerary.txt',
    mimeType: opts.mimeType ?? 'text/plain',
    buffer: opts.buffer ?? PLAIN,
    index: false,
  });
}

const onDisk = (att: { path: string }) => fs.readFile(path.join(env.DATA_DIR, att.path));

describe('what lands on disk', () => {
  it('a sealed file has no readable plaintext in it', async () => {
    setContentEncryption(true);
    const att = await save();

    const bytes = await onDisk(att);
    expect(isSealedFile(bytes)).toBe(true);
    expect(bytes.includes(Buffer.from(MARKER))).toBe(false);
    expect(bytes.includes(Buffer.from('UA512'))).toBe(false);
    expect(bytes.includes(Buffer.from('Itinerary'))).toBe(false);
    expect(att.size).toBe(PLAIN.length); // the row still reports the real size
  });

  it('with encryption off the file is written exactly as before', async () => {
    const att = await save();
    expect((await onDisk(att)).equals(PLAIN)).toBe(true);
    expect(await blobIsSealed(absolutePathFor(att))).toBe(false);
  });

  it('a group file is sealed under the group, a personal file under the user', async () => {
    setContentEncryption(true);
    const g = await save();
    const u = await save({ scope: 'user', filename: 'mine.txt' });

    expect((await onDisk(g)).includes(Buffer.from(groupId))).toBe(true);
    expect((await onDisk(u)).includes(Buffer.from(userId))).toBe(true);
    expect((await onDisk(g)).includes(Buffer.from(userId))).toBe(false);
  });

  it('reads back the exact bytes, sealed or not, whatever the flag says now', async () => {
    const plain = await save();
    setContentEncryption(true);
    const sealed = await save({ filename: 'b.txt' });

    for (const flag of [true, false]) {
      setContentEncryption(flag);
      expect((await readBlob(absolutePathFor(plain))).equals(PLAIN)).toBe(true);
      expect((await readBlob(absolutePathFor(sealed))).equals(PLAIN)).toBe(true);
    }
  });

  it('binary files survive byte for byte', async () => {
    setContentEncryption(true);
    const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const att = await save({ buffer: bin, filename: 'x.bin', mimeType: 'application/octet-stream' });
    expect((await readBlob(absolutePathFor(att))).equals(bin)).toBe(true);
  });
});

describe('everything that reads a file still works when it is sealed', () => {
  it('text extraction reads through the seal', async () => {
    setContentEncryption(true);
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId },
      uploadedBy: userId,
      filename: 'trip.txt',
      mimeType: 'text/plain',
      buffer: PLAIN,
      awaitExtraction: true,
    });

    const row = await getAttachment(db, att.id);
    expect(row?.extractedText).toContain(MARKER);
    expect((await onDisk(att)).includes(Buffer.from(MARKER))).toBe(false);
  });

  it('a mail attachment is sent as the real bytes', async () => {
    setContentEncryption(true);
    const att = await save({ filename: 'trip.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), PLAIN]) });

    const [out] = await loadOutgoingAttachments(db, userId, [att.id], 'gmail');

    expect(out!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out!.content.includes(Buffer.from(MARKER))).toBe(true);
    expect(out!.content.length).toBe(att.size);
  });

  it('a copy shared into another group opens for that group', async () => {
    setContentEncryption(true);
    const other = (await createGroup(db, { name: 'Trip', kind: 'group', createdBy: userId })).id;
    made.push(other);
    const src = await save();

    const copy = await copyAttachmentToGroup(db, src, other, userId);

    expect(copy.path).toBe(src.path);
    expect((await readBlob(absolutePathFor(copy))).equals(PLAIN)).toBe(true);
  });
});

describe('GET /attachments/:id', () => {
  let server: http.Server;
  let base: string;
  let token: string;

  async function mintToken(uid: string): Promise<string> {
    const t = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(t), user_id: uid, created_at: now, last_seen_at: now }).execute();
    return t;
  }
  const get = (id: string, tok = token) =>
    fetch(`${base}/api/v1/attachments/${id}`, { headers: { [SESSION_HEADER]: tok } });

  beforeEach(async () => {
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = await mintToken(userId);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the original bytes of a sealed file, with the right headers', async () => {
    setContentEncryption(true);
    const att = await save();

    const res = await get(att.id);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('itinerary.txt');
    expect(Number(res.headers.get('content-length'))).toBe(PLAIN.length);
    expect(Buffer.from(await res.arrayBuffer()).equals(PLAIN)).toBe(true);
  });

  it('still serves a file that was never sealed', async () => {
    const att = await save();
    const res = await get(att.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PLAIN)).toBe(true);
  });

  it('refuses someone who cannot read the file, and does not leak bytes in the error', async () => {
    setContentEncryption(true);
    const att = await save();
    const mallory = await createUser(db, 'mallory');

    const res = await get(att.id, await mintToken(mallory));

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('CHENC1');
  });

  it('answers 410 when the file is gone from disk, sealed or not', async () => {
    setContentEncryption(true);
    const att = await save();
    await fs.rm(absolutePathFor(att));
    const res = await get(att.id);
    expect(res.status).toBe(410);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'BLOB_MISSING' });
  });

  it('answers 410 CONTENT_ERASED once the owner key is destroyed, and never the bytes', async () => {
    setContentEncryption(true);
    const att = await save();
    const { store, raw } = contentCrypto();
    await store.destroy(raw, groupId);

    const res = await get(att.id);

    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).toContain('CONTENT_ERASED');
    expect(body).not.toContain(MARKER);
  });

  it('a different group keeps working after one group is erased', async () => {
    setContentEncryption(true);
    const other = (await createGroup(db, { name: 'Other', kind: 'group', createdBy: userId })).id;
    made.push(other);
    const keep = await save({ group: other, filename: 'keep.txt' });
    const drop = await save();
    const { store, raw } = contentCrypto();
    await store.destroy(raw, groupId);

    expect((await get(drop.id)).status).toBe(410);
    expect((await get(keep.id)).status).toBe(200);
  });
});

describe('erasing a key erases the files', () => {
  it('readBlob fails with KeyDestroyedError, from a cold cache too', async () => {
    setContentEncryption(true);
    const att = await save();
    const { store, raw } = contentCrypto();
    await store.destroy(raw, groupId);
    store.clearCache();

    await expect(readBlob(absolutePathFor(att))).rejects.toThrow(KeyDestroyedError);
  });

  it('a missing file rejects with ENOENT rather than pretending it is empty', async () => {
    await expect(readBlob(path.join(env.FILES_DIR, 'group', 'nope', 'nothing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('sealing what already exists', () => {
  async function plainFiles(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await save({ filename: `f${i}.txt`, buffer: Buffer.from(`file ${i} ${MARKER}`) }));
    }
    return out;
  }

  it('seals every plaintext file, byte for byte recoverable, rows untouched', async () => {
    const files = await plainFiles(5);
    const rowsBefore = await db.selectFrom('attachments').selectAll().orderBy('id').execute();
    setContentEncryption(true);

    const r = await sealExistingAttachments(db);

    expect(r).toMatchObject({ scanned: 5, sealed: 5, alreadySealed: 0, missing: 0, failed: 0 });
    for (const [i, f] of files.entries()) {
      const bytes = await onDisk(f);
      expect(isSealedFile(bytes)).toBe(true);
      expect(bytes.includes(Buffer.from(MARKER))).toBe(false);
      expect((await readBlob(absolutePathFor(f))).toString()).toBe(`file ${i} ${MARKER}`);
    }
    const rowsAfter = await db.selectFrom('attachments').selectAll().orderBy('id').execute();
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await plainFiles(3);
    setContentEncryption(true);
    await sealExistingAttachments(db);
    const snapshot = await Promise.all((await db.selectFrom('attachments').select('path').execute()).map((a) => onDisk(a)));

    const again = await sealExistingAttachments(db);

    expect(again).toMatchObject({ sealed: 0, alreadySealed: 3, failed: 0 });
    const after = await Promise.all((await db.selectFrom('attachments').select('path').execute()).map((a) => onDisk(a)));
    expect(after.map((b) => b.toString('hex')).sort()).toEqual(snapshot.map((b) => b.toString('hex')).sort());
  });

  it('a dry run reports the work and touches nothing', async () => {
    const files = await plainFiles(2);
    setContentEncryption(true);

    const r = await sealExistingAttachments(db, { dryRun: true });

    expect(r).toMatchObject({ sealed: 2, failed: 0 });
    for (const f of files) expect(isSealedFile(await onDisk(f))).toBe(false);
  });

  it('counts a file that is gone and carries on with the rest', async () => {
    const [a, b, c] = await plainFiles(3);
    await fs.rm(absolutePathFor(b!));
    setContentEncryption(true);

    const r = await sealExistingAttachments(db);

    expect(r).toMatchObject({ scanned: 3, sealed: 2, missing: 1, failed: 0 });
    expect(isSealedFile(await onDisk(a!))).toBe(true);
    expect(isSealedFile(await onDisk(c!))).toBe(true);
  });

  it('seals a blob shared by two rows once, and both rows still open it', async () => {
    const other = (await createGroup(db, { name: 'Other', kind: 'group', createdBy: userId })).id;
    made.push(other);
    const src = await save();
    const copy = await copyAttachmentToGroup(db, src, other, userId);
    setContentEncryption(true);

    const r = await sealExistingAttachments(db);

    expect(r.sealed).toBe(1);
    expect(r.scanned).toBe(2);
    expect((await readBlob(absolutePathFor(src))).equals(PLAIN)).toBe(true);
    expect((await readBlob(absolutePathFor(copy))).equals(PLAIN)).toBe(true);
  });

  it('pages through more rows than one batch holds', async () => {
    await plainFiles(7);
    setContentEncryption(true);

    const r = await sealExistingAttachments(db, { batch: 2 });

    expect(r).toMatchObject({ scanned: 7, sealed: 7, failed: 0 });
  });

  it('recovers from a crash that left a half-written temp file behind', async () => {
    const [f] = await plainFiles(1);
    const full = absolutePathFor(f!);
    await fs.writeFile(`${full}.sealing`, Buffer.from('partial garbage from a crashed run'));
    setContentEncryption(true);

    const r = await sealExistingAttachments(db);

    expect(r).toMatchObject({ sealed: 1, failed: 0 });
    expect((await readBlob(full)).toString()).toContain(MARKER);
    await expect(fs.stat(`${full}.sealing`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never leaves a plaintext file readable as sealed, or the reverse', async () => {
    const [f] = await plainFiles(1);
    expect(await blobIsSealed(absolutePathFor(f!))).toBe(false);
    setContentEncryption(true);
    await sealExistingAttachments(db);
    expect(await blobIsSealed(absolutePathFor(f!))).toBe(true);
  });

  it("seals a personal file under the user's key and a group file under the group's", async () => {
    setContentEncryption(false);
    const g = await save();
    const u = await save({ scope: 'user', filename: 'mine.txt' });
    setContentEncryption(true);
    await sealExistingAttachments(db);

    expect((await onDisk(g)).includes(Buffer.from(groupId))).toBe(true);
    expect((await onDisk(u)).includes(Buffer.from(userId))).toBe(true);
  });
});
