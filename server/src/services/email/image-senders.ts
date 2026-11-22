/**
 * Senders whose remote images the reader has agreed to load (ADR 0120).
 *
 * An allow list, not a block list. Remote images in mail are a read receipt by
 * default — a unique URL per recipient tells the sender the address is live,
 * when it was opened and roughly from where — so the safe state is the empty
 * table, and every row is an exception someone chose.
 *
 * Keyed on the address rather than the thread: agreeing to see one
 * newsletter's images is a decision about that sender, which is what the
 * reader thinks they are agreeing to.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

/** Addresses are compared lowercased; senders are inconsistent about case and
 *  a reader who allowed `News@x.com` means `news@x.com` too. */
const norm = (email: string): string => email.trim().toLowerCase();

export async function allowImagesFrom(
  db: Kysely<DB>,
  userId: string,
  email: string,
): Promise<void> {
  await db
    .insertInto('email_image_senders')
    .values({
      user_id: userId,
      sender_email: norm(email),
      created_at: new Date().toISOString(),
    })
    // Allowing twice is the same as allowing once.
    .onConflict((oc) => oc.columns(['user_id', 'sender_email']).doNothing())
    .execute();
}

export async function blockImagesFrom(
  db: Kysely<DB>,
  userId: string,
  email: string,
): Promise<void> {
  await db
    .deleteFrom('email_image_senders')
    .where('user_id', '=', userId)
    .where('sender_email', '=', norm(email))
    .execute();
}

export async function imagesAllowedFor(
  db: Kysely<DB>,
  userId: string,
  email: string | null,
): Promise<boolean> {
  // A message with no parseable sender has nobody to have trusted.
  if (!email) return false;
  const row = await db
    .selectFrom('email_image_senders')
    .select('sender_email')
    .where('user_id', '=', userId)
    .where('sender_email', '=', norm(email))
    .executeTakeFirst();
  return !!row;
}

/**
 * Whether this reader loads remote images without being asked (ADR 0136).
 *
 * Independent of the allow list above rather than a row in it: this is one
 * answer for every sender, and folding it into the table would mean writing a
 * row per sender the first time each is seen.
 */
export async function autoLoadsImages(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('email_images_auto')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.email_images_auto === 1;
}

export async function listImageSenders(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('email_image_senders')
    .select('sender_email')
    .where('user_id', '=', userId)
    .orderBy('sender_email', 'asc')
    .execute();
  return rows.map((r) => r.sender_email);
}
