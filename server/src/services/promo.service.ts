/**
 * ADR 0231 — single-use promo codes: generate, check, burn.
 *
 * A code gives a NEW subscriber a free first period — it becomes a trial on
 * the Stripe subscription, so the card is taken at checkout and charged when
 * the free month ends ("free as long as you subscribe, then charges you").
 * It is burned when the subscription actually starts (`checkout.session
 * .completed`), NOT when it is typed in: an abandoned checkout must not cost
 * a code. The burn is one conditional UPDATE, so two checkouts racing on the
 * same code can't both win it.
 *
 * Web only. The App Store can't honor a code of ours — iOS uses Apple's own
 * offer codes, generated in App Store Connect and redeemed through StoreKit.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { newInviteCode } from '../utils/ids.js';

export const DEFAULT_PROMO_TRIAL_DAYS = 30;

export type PromoFailure = 'invalid_code' | 'code_used' | 'code_expired';

/** `CHORD-ABCD-EFGH` — typed on a phone, so no look-alike characters
 *  (the alphabet is the invite one: no 0/O/1/I/L). */
function newPromoCode(): string {
  return `CHORD-${newInviteCode().slice(0, 4)}-${newInviteCode().slice(0, 4)}`;
}

/** Whatever a person typed → the stored form. Tolerates case, spaces and a
 *  missing/extra dash ("chord abcd efgh", "CHORDABCDEFGH"). */
export function normalizePromoCode(raw: string): string {
  const flat = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = flat.startsWith('CHORD') ? flat.slice(5) : flat;
  return body.length === 8 ? `CHORD-${body.slice(0, 4)}-${body.slice(4)}` : raw.trim().toUpperCase();
}

export async function generatePromoCodes(
  db: Kysely<DB>,
  opts: { count: number; trialDays?: number; expiresAt?: string | null; note?: string | null },
): Promise<string[]> {
  const codes: string[] = [];
  const now = new Date().toISOString();
  while (codes.length < opts.count) {
    const code = newPromoCode();
    // A collision is ~1 in 10^12; the PRIMARY KEY makes it a no-op, so retry.
    const res = await db
      .insertInto('promo_codes')
      .values({
        code,
        kind: 'free_month',
        trial_days: opts.trialDays ?? DEFAULT_PROMO_TRIAL_DAYS,
        note: opts.note ?? null,
        created_at: now,
        expires_at: opts.expiresAt ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) codes.push(code);
  }
  return codes;
}

export async function checkPromoCode(
  db: Kysely<DB>,
  raw: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; code: string; trialDays: number } | { ok: false; reason: PromoFailure }> {
  const code = normalizePromoCode(raw);
  const row = await db.selectFrom('promo_codes').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) return { ok: false, reason: 'invalid_code' };
  if (row.redeemed_at) return { ok: false, reason: 'code_used' };
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return { ok: false, reason: 'code_expired' };
  return { ok: true, code, trialDays: row.trial_days };
}

/** Burn a code for a user. True only for the call that won it. */
export async function redeemPromoCode(db: Kysely<DB>, raw: string, userId: string): Promise<boolean> {
  const res = await db
    .updateTable('promo_codes')
    .set({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
    .where('code', '=', normalizePromoCode(raw))
    .where('redeemed_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}
