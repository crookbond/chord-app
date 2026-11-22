/**
 * A Word or Excel attachment is read like a PDF (ADR 0310): its text is
 * stored and indexed, and it reaches the auto-filer that turns documents
 * into action cards. Before, an Office file had no text at all, so a school
 * schedule sent as .docx or .xlsx produced nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoFile = vi.hoisted(() => vi.fn(async (_db: unknown, _opts: { extractedText: string }) => false));
vi.mock('@/services/bot/trip_classifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bot/trip_classifier.js')>()),
  classifyAndAutoFileAttachment: autoFile,
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getAttachment, saveFile } from '@/services/attachments.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  autoFile.mockClear();
});
afterEach(async () => {
  await closeTestDb(db);
  await fs.rm(path.join(env.FILES_DIR, 'group', groupId), { recursive: true, force: true });
});

function docx(paragraphs: string[]): Buffer {
  const z = new AdmZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  z.addFile(
    'word/document.xml',
    Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  );
  return z.toBuffer();
}

describe('Office attachments', () => {
  it('a .docx sent as octet-stream is read, stored and handed to the auto-filer', async () => {
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId },
      uploadedBy: userId,
      filename: 'Field trip letter.docx',
      mimeType: 'application/octet-stream',
      buffer: docx(['Field trip to the aquarium on Friday, November 14.', 'Permission slip due Wednesday.']),
      awaitExtraction: true,
    });
    const row = await getAttachment(db, att.id);
    expect(row?.extractedText).toContain('Field trip to the aquarium on Friday, November 14.');
    expect(autoFile).toHaveBeenCalledTimes(1);
    expect(autoFile.mock.calls[0]![1].extractedText).toContain('Permission slip due Wednesday.');
  });

  it('a damaged .docx is stored with no text and never reaches the auto-filer', async () => {
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId },
      uploadedBy: userId,
      filename: 'broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('<html><body>not really a docx</body></html>'),
      awaitExtraction: true,
    });
    const row = await getAttachment(db, att.id);
    expect(row?.extractedText ?? '').toBe('');
    expect(autoFile).not.toHaveBeenCalled();
  });
});
