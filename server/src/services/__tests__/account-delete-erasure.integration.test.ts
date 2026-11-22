/**
 * Deleting an account destroys the data keys behind what it owned (ADR 0201).
 * The rows and files are already removed by ADR 0043; the key is what makes a
 * COPY that outlives the deletion, a restored dump or a disk snapshot,
 * unreadable. The point of the test is the copy: it is taken before the
 * deletion and must not open after it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import {
  contentCrypto,
  isSealedFile,
  KeyDestroyedError,
  openFile,
  readBlob,
  setContentEncryption,
} from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { deleteAccount } from '@/services/account.service.js';
import { absolutePathFor, saveFile } from '@/services/attachments.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
const dirs: string[] = [];

beforeEach(async () => {
  db = await openTestDb();
  setContentEncryption(true);
});
afterEach(async () => {
  await closeTestDb(db);
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const keyRow = (owner: string) =>
  db.selectFrom('content_keys').selectAll().where('owner', '=', owner).executeTakeFirst();

describe('deleteAccount and the data keys', () => {
  it("a copy of the deleted user's sealed file can no longer be opened", async () => {
    const alice = await createUser(db, 'alice');
    const personal = await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: alice });
    dirs.push(path.join(env.FILES_DIR, 'group', personal.id), path.join(env.FILES_DIR, 'user', alice));
    const inGroup = await saveFile(db, {
      scope: { kind: 'group', groupId: personal.id },
      uploadedBy: alice,
      filename: 'passport.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('passport number X1234567'),
      index: false,
    });
    const mine = await saveFile(db, {
      scope: { kind: 'user', userId: alice },
      uploadedBy: alice,
      filename: 'ssn.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('ssn 078-05-1120'),
      index: false,
    });
    // What a snapshot taken before the deletion would hold.
    const snapshotA = await fs.readFile(absolutePathFor(inGroup));
    const snapshotB = await fs.readFile(absolutePathFor(mine));
    expect(isSealedFile(snapshotA) && isSealedFile(snapshotB)).toBe(true);

    await deleteAccount(db, alice);

    const { store, keys } = contentCrypto();
    store.clearCache();
    await expect(openFile(store, keys, snapshotA)).rejects.toThrow(KeyDestroyedError);
    await expect(openFile(store, keys, snapshotB)).rejects.toThrow(KeyDestroyedError);
    expect((await keyRow(alice))?.destroyed_at).not.toBeNull();
    expect((await keyRow(personal.id))?.destroyed_at).not.toBeNull();
    expect((await keyRow(alice))?.wrapped_dek).toBeNull();
  });

  it('leaves a group that survives, and its files, readable for the remaining members', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const shared = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    await addMember(db, shared.id, bob, 'member');
    dirs.push(path.join(env.FILES_DIR, 'group', shared.id));
    const file = await saveFile(db, {
      scope: { kind: 'group', groupId: shared.id },
      uploadedBy: alice,
      filename: 'plan.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('family plan'),
      index: false,
    });

    await deleteAccount(db, alice);

    contentCrypto().store.clearCache();
    expect((await readBlob(absolutePathFor(file))).toString()).toBe('family plan');
    expect((await keyRow(shared.id))?.destroyed_at).toBeNull();
  });

  it('does not touch anyone else’s key', async () => {
    const alice = await createUser(db, 'alice');
    const carol = await createUser(db, 'carol');
    const { store, keys } = contentCrypto();
    await store.getDek(keys, carol);

    await deleteAccount(db, alice);

    expect((await keyRow(carol))?.destroyed_at).toBeNull();
  });

  it('still deletes cleanly when encryption was never used', async () => {
    setContentEncryption(false);
    const alice = await createUser(db, 'alice');
    await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: alice });

    await expect(deleteAccount(db, alice)).resolves.toBeDefined();
    expect(await db.selectFrom('users').select('id').where('id', '=', alice).executeTakeFirst()).toBeUndefined();
  });
});
