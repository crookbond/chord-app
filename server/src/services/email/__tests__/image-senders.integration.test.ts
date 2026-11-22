/**
 * Remote-image blocking (ADR 0120). A remote image in mail is a read receipt:
 * a unique URL per recipient tells the sender the address is live, when it was
 * opened and roughly from where. The tests that matter are the ones about what
 * still leaks.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  allowImagesFrom,
  blockImagesFrom,
  imagesAllowedFor,
  listImageSenders,
} from '@/services/email/image-senders.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('who is allowed to load images', () => {
  it('blocks by default', async () => {
    // The empty table is the safe state, which is why this is an allow list
    // rather than a block list.
    expect(await imagesAllowedFor(db, userId, 'news@example.com')).toBe(false);
  });

  it('remembers a sender the reader allowed', async () => {
    await allowImagesFrom(db, userId, 'news@example.com');

    expect(await imagesAllowedFor(db, userId, 'news@example.com')).toBe(true);
  });

  it('ignores case, because senders do not', async () => {
    // A reader who allowed News@Example.com meant news@example.com.
    await allowImagesFrom(db, userId, 'News@Example.com');

    expect(await imagesAllowedFor(db, userId, 'news@example.com')).toBe(true);
  });

  it('allowing twice is allowing once', async () => {
    await allowImagesFrom(db, userId, 'news@example.com');
    await allowImagesFrom(db, userId, 'news@example.com');

    expect(await listImageSenders(db, userId)).toEqual(['news@example.com']);
  });

  it('can be taken back', async () => {
    await allowImagesFrom(db, userId, 'news@example.com');
    await blockImagesFrom(db, userId, 'news@example.com');

    expect(await imagesAllowedFor(db, userId, 'news@example.com')).toBe(false);
  });

  it('blocks a message with no parseable sender', async () => {
    // Nobody to have trusted.
    expect(await imagesAllowedFor(db, userId, null)).toBe(false);
  });

  it('is one reader\'s decision, not everyone\'s', async () => {
    const bob = await createUser(db, 'bob');
    await allowImagesFrom(db, userId, 'news@example.com');

    expect(await imagesAllowedFor(db, bob, 'news@example.com')).toBe(false);
  });
});
