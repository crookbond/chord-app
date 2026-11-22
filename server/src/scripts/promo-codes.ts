/**
 * ADR 0231 — make and inspect single-use promo codes ("a free month if you
 * subscribe"). A code is burned when the subscription it was applied to
 * actually starts.
 *
 * Usage:
 *   npm run promo:codes --workspace=server -- generate --count 20 [--days 30] [--expires 2026-12-31] [--note "friends"]
 *   npm run promo:codes --workspace=server -- list [--unused]
 */
import { openDb } from '../db/index.js';
import { ensureDataDirs } from '../db/paths.js';
import { DEFAULT_PROMO_TRIAL_DAYS, generatePromoCodes } from '../services/promo.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  ensureDataDirs();
  const db = openDb();
  try {
    const cmd = process.argv[2];
    if (cmd === 'generate') {
      const count = Number.parseInt(arg('--count') ?? '', 10);
      if (!Number.isFinite(count) || count < 1 || count > 1000) {
        console.error('--count must be 1..1000');
        process.exitCode = 1;
        return;
      }
      const expires = arg('--expires');
      const codes = await generatePromoCodes(db, {
        count,
        trialDays: Number.parseInt(arg('--days') ?? '', 10) || DEFAULT_PROMO_TRIAL_DAYS,
        expiresAt: expires ? new Date(expires).toISOString() : null,
        note: arg('--note') ?? null,
      });
      console.log(codes.join('\n'));
      return;
    }
    if (cmd === 'list') {
      let q = db.selectFrom('promo_codes').selectAll().orderBy('created_at', 'desc');
      if (process.argv.includes('--unused')) q = q.where('redeemed_at', 'is', null);
      for (const r of await q.execute()) {
        const state = r.redeemed_at ? `used ${r.redeemed_at} by ${r.redeemed_by ?? '?'}` : 'unused';
        console.log(`${r.code}  ${r.trial_days}d  ${state}${r.note ? `  (${r.note})` : ''}`);
      }
      return;
    }
    console.error('usage: generate --count N [--days D] [--expires DATE] [--note TEXT]   |   list [--unused]');
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
