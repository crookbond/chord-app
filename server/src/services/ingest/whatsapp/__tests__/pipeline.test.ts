import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { importWhatsAppZip } from '@/services/ingest/whatsapp/pipeline.js';
import { MockLlmService } from '@/services/llm/mock.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const SAMPLE_CHAT = [
  '[14/03/2024, 09:16:00] Alice: hey crew, booking flights',
  '[14/03/2024, 09:17:00] Bob: I can drive us to the airport',
  '[14/03/2024, 09:18:00] Alice: IMG-20240314-WA0001.jpg (file attached)',
  '[14/03/2024, 09:18:30] Alice: nice shot of the terminal',
  '[14/03/2024, 09:19:00] Bob: cool',
  '',
].join('\n');

async function seedUploader(db: Kysely<DB>): Promise<string> {
  const id = newId('u');
  await db
    .insertInto('users')
    .values({
      id,
      username: 'uploader',
      display_name: 'Uploader',
      created_at: new Date().toISOString(),
      shadow: 0,
    })
    .execute();
  return id;
}

function buildFixtureZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from(SAMPLE_CHAT, 'utf-8'));
  zip.addFile('IMG-20240314-WA0001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return zip.toBuffer();
}

describe('importWhatsAppZip', () => {
  let tmpData: string;
  let prevDataDir: string | undefined;
  let prevFilesDir: string | undefined;

  beforeEach(() => {
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-import-test-'));
    prevDataDir = process.env.DATA_DIR;
    prevFilesDir = process.env.FILES_DIR;
    process.env.DATA_DIR = tmpData;
    process.env.FILES_DIR = path.join(tmpData, 'files');
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevFilesDir === undefined) delete process.env.FILES_DIR;
    else process.env.FILES_DIR = prevFilesDir;
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('creates a group, shadow users for non-uploader senders, and inserts backdated messages', async () => {
    const db = await openTestDb();
    const uploaderId = await seedUploader(db);

    const result = await importWhatsAppZip(db, {
      zipBuffer: buildFixtureZip(),
      uploaderId,
      groupName: 'Travel Crew',
      skipExtraction: true,
    });

    expect(result.messagesInserted).toBe(5);
    expect(result.attachmentsUploaded).toBe(1);
    expect(result.attachmentsLinked).toBe(1);
    expect(result.shadowUsersCreated).toBe(2); // Alice + Bob

    const group = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', result.groupId)
      .executeTakeFirstOrThrow();
    expect(group.name).toBe('Travel Crew');
    expect(group.kind).toBe('group');
    expect(group.created_by).toBe(uploaderId);

    const members = await db
      .selectFrom('group_members')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .execute();
    expect(members).toHaveLength(3); // uploader + Alice + Bob

    const messages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .orderBy('created_at', 'asc')
      .execute();
    expect(messages).toHaveLength(5);
    expect(messages.every((m) => m.source === 'import')).toBe(true);
    expect(messages[0].created_at.startsWith('2024-03-14T')).toBe(true);

    const fileMsg = messages.find((m) => m.kind === 'file');
    expect(fileMsg).toBeDefined();
    expect(fileMsg!.attachment_id).not.toBeNull();

    const attachments = await db
      .selectFrom('attachments')
      .selectAll()
      .where('scope_id', '=', result.groupId)
      .execute();
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('IMG-20240314-WA0001.jpg');
    expect(attachments[0].indexed_at).toBeNull(); // index=false
    await closeTestDb(db);
  });

  it('attributes messages from a sender whose display name matches the uploader to the uploader account', async () => {
    const db = await openTestDb();

    const id = newId('u');
    await db
      .insertInto('users')
      .values({
        id,
        username: 'alice',
        display_name: 'Alice',
        created_at: new Date().toISOString(),
        shadow: 0,
      })
      .execute();

    const result = await importWhatsAppZip(db, {
      zipBuffer: buildFixtureZip(),
      uploaderId: id,
      groupName: 'Match test',
      skipExtraction: true,
    });

    expect(result.shadowUsersCreated).toBe(1); // only Bob
    const aliceMsgs = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .where('sender_id', '=', id)
      .execute();
    expect(aliceMsgs.length).toBeGreaterThan(0);
    await closeTestDb(db);
  });

  it('runs windowed extraction via the mock LLM and materialises at least one entity', async () => {
    const db = await openTestDb();
    const uploaderId = await seedUploader(db);

    const richChat = [
      '[14/03/2024, 09:16:00] Alice: hey crew',
      "[14/03/2024, 09:17:00] Bob: remind me to confirm the car rental by Friday",
      '[14/03/2024, 09:18:00] Alice: costco run this week — need milk, bread, eggs, sunscreen',
      '[14/03/2024, 09:19:00] Bob: https://expedia.com/itin/XYZ',
      '',
    ].join('\n');

    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from(richChat, 'utf-8'));

    const result = await importWhatsAppZip(db, {
      zipBuffer: zip.toBuffer(),
      uploaderId,
      groupName: 'Extraction test',
      llm: new MockLlmService(),
    });

    expect(result.entitiesExtracted).toBeGreaterThan(0);

    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .execute();
    const lists = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .execute();
    const saves = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', result.groupId)
      .execute();

    expect(tasks.some((t) => /confirm the car rental/i.test(t.title))).toBe(true);
    expect(tasks[0].source_raw_context).toContain('car rental');
    expect(tasks[0].created_by).toBe(uploaderId);

    // Round-trip: listTasks surfaces sourceRawContext on the domain object.
    const { listTasks } = await import('@/services/tasks.service.js');
    const live = await listTasks(db, result.groupId);
    expect(live[0].sourceRawContext).toContain('car rental');
    expect(lists.some((l) => l.name.toLowerCase() === 'costco')).toBe(true);
    expect(saves.some((s) => s.url?.includes('expedia.com'))).toBe(true);
    await closeTestDb(db);
  });

  it('throws when the zip does not contain _chat.txt', async () => {
    const db = await openTestDb();
    const uploaderId = await seedUploader(db);

    const zip = new AdmZip();
    zip.addFile('random.txt', Buffer.from('nothing interesting'));

    await expect(
      importWhatsAppZip(db, {
        zipBuffer: zip.toBuffer(),
        uploaderId,
        skipExtraction: true,
      }),
    ).rejects.toThrow(/_chat\.txt/);
    await closeTestDb(db);
  });
});
