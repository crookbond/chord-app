/**
 * Backfill verified phone numbers from WhatsApp identities (ADR 0064).
 *
 *   npm run backfill:phones --workspace=server
 *
 * WhatsApp-linked users already proved their number to WhatsApp, so we mark it
 * verified. Idempotent — safe to re-run.
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import { backfillWhatsappPhones } from '../services/phone/backfill.js';

async function main(): Promise<void> {
  ensureDataDirs();
  const db = openDb();
  try {
    const result = await backfillWhatsappPhones(db);
    console.log('whatsapp phone backfill:', result);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
