/**
 * An attachment row can outlive its blob (pre-DATA_DIR uploads lost in a
 * storage move). The download route must answer 410, stamp the row, and log —
 * and search must stop surfacing files that can't open, while the Attachments
 * listing keeps them visible (flagged) so the user knows what to re-upload.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { listAttachmentsForUser, markBlobMissing } from '@/services/attachments.service.js';
import { createGroup } from '@/services/groups.service.js';
import { searchEverything } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

async function seedGhostAttachment(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; filename: string; text: string },
): Promise<string> {
  const id = newId('a');
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: opts.groupId,
      uploaded_by: opts.userId,
      filename: opts.filename,
      mime_type: 'application/pdf',
      size: opts.text.length,
      // Deliberately points at nothing on disk — the row outlived its blob.
      path: `files/group/${opts.groupId}/${id}/${opts.filename}`,
      summary: null,
      extracted_text: opts.text,
      image_meta: null,
      pinned: 0,
      indexed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
  await indexAttachmentChunks(db, id);
  return id;
}

describe('blob-missing attachments', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('download answers 410 BLOB_MISSING and stamps the row', async () => {
    const userId = await createUser(db, 'ghost-owner');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId });
    const attId = await seedGhostAttachment(db, {
      groupId: group.id,
      userId,
      filename: 'immunization_record.pdf',
      text: 'immunization record for nolan',
    });
    const tok = await mintToken(db, userId);

    const res = await fetch(`${base}${API.attachment(attId)}`, {
      headers: { [SESSION_HEADER]: tok },
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'BLOB_MISSING' });

    // Stamp is written async after the response — poll briefly.
    let stamped: string | null | undefined;
    for (let i = 0; i < 20 && !stamped; i++) {
      await new Promise((r) => setTimeout(r, 25));
      stamped = (
        await db
          .selectFrom('attachments')
          .select('blob_missing_at')
          .where('id', '=', attId)
          .executeTakeFirstOrThrow()
      ).blob_missing_at;
    }
    expect(stamped).toBeTruthy();
  });

  it('search skips stamped rows; the Attachments listing keeps them, flagged', async () => {
    const userId = await createUser(db, 'ghost-search');
    const personal = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId });
    const attId = await seedGhostAttachment(db, {
      groupId: personal.id,
      userId,
      filename: 'passport.pdf',
      text: 'passport expires 2028',
    });

    const before = await searchEverything(db, {
      userId,
      groupId: personal.id,
      crossGroup: true,
      query: 'passport',
    });
    expect(before.files.map((f) => f.id)).toContain(attId);

    await markBlobMissing(db, attId);

    const after = await searchEverything(db, {
      userId,
      groupId: personal.id,
      crossGroup: true,
      query: 'passport',
    });
    expect(after.files.map((f) => f.id)).not.toContain(attId);

    const listed = await listAttachmentsForUser(db, userId);
    const row = listed.find((a) => a.id === attId);
    expect(row?.blobMissing).toBe(true);
  });

  it('same filename in the same group: only the newest copy surfaces in search', async () => {
    const userId = await createUser(db, 'ghost-latest');
    const personal = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId });
    const oldId = await seedGhostAttachment(db, {
      groupId: personal.id,
      userId,
      filename: 'schedule.pdf',
      text: 'soccer schedule spring',
    });
    await db
      .updateTable('attachments')
      .set({ created_at: new Date(Date.now() - 86_400_000).toISOString() })
      .where('id', '=', oldId)
      .execute();
    const newId2 = await seedGhostAttachment(db, {
      groupId: personal.id,
      userId,
      filename: 'schedule.pdf',
      text: 'soccer schedule fall updated',
    });

    const res = await searchEverything(db, {
      userId,
      groupId: personal.id,
      crossGroup: true,
      query: 'schedule',
    });
    const ids = res.files.map((f) => f.id);
    expect(ids).toContain(newId2);
    expect(ids).not.toContain(oldId);
  });
});
