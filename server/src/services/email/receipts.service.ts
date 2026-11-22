/**
 * Receipts the user's mail has produced (ADR 0160), as answers (ADR 0246).
 *
 * `receipt_json` is sealed at rest (ADR 0201), so nothing here can be summed
 * or grouped in SQL: the rows are read (the read plugin opens them) and worked
 * in memory, per user, under a row cap.
 *
 * Coverage is partial by construction and every caller has to say so: a
 * receipt exists only for mail the suggestion pass read after ADR 0160
 * shipped, and each thread is read once.
 */
import type { Kysely } from 'kysely';

import type { EmailReceiptsOverview } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { sealField, sealJsonField } from '../../db/crypto/index.js';
import { textInstant } from '../../db/text-instant.js';
import { newId } from '../../utils/ids.js';
import { tzToOffsetMinutes } from '../../utils/tz.js';

/** Rows read per request. Above this the oldest receipts are left out. */
const MAX_ROWS = 2000;
const DAY = 86_400_000;
/** Shown when the email named no currency; never merged with a real one. */
export const UNKNOWN_CURRENCY = 'unspecified';

export interface StoredReceipt {
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  purchasedAt?: string | null;
  orderNumber?: string | null;
  paymentMethod?: string | null;
}

/**
 * "Visa ending in 1234" -> "Visa ••1234"; "PayPal" stays "PayPal". Whatever
 * the model returned, at most the last four digits of a number are kept, so
 * a card number pasted whole into the reply is cut down before it is stored.
 */
export function normalizePaymentMethod(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, 80);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  const words = s
    .replace(/[\d*•#]+/g, ' ')
    .replace(/\b[xX]{2,}\b/g, ' ')
    .replace(/\b(ending|ends|in|with|card|number|no|last|digits?)\b/gi, ' ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  if (digits.length >= 4) return `${words || 'Card'} ••${digits.slice(-4)}`;
  return words || null;
}

/**
 * Keep a copy of a thread's receipt apart from the thread (ADR 0249): the
 * thread row goes when the mail is deleted, and a total should not drop
 * because the user cleaned up their inbox. One row per provider thread; a
 * second read of the same email replaces the fact.
 */
export async function keepReceipt(db: Kysely<DB>, threadRowId: string, fact: StoredReceipt): Promise<void> {
  const t = await db
    .selectFrom('email_threads')
    .select(['user_id', 'gmail_thread_id', 'from_name', 'from_email', 'last_message_at', 'account_id'])
    .where('id', '=', threadRowId)
    .executeTakeFirst();
  if (!t) return;
  const mailbox = t.account_id
    ? (await db.selectFrom('email_accounts').select('email_address').where('id', '=', t.account_id).executeTakeFirst())
        ?.email_address
    : (await db.selectFrom('users').select('email').where('id', '=', t.user_id).executeTakeFirst())?.email;
  const now = new Date().toISOString();
  const receiptJson = (await sealJsonField(t.user_id, 'email_receipts:receipt_json', JSON.stringify(fact)))!;
  const fromName = await sealField(t.user_id, 'email_receipts:from_name', t.from_name);
  await db
    .insertInto('email_receipts')
    .values({
      id: newId('rcpt'),
      user_id: t.user_id,
      gmail_thread_id: t.gmail_thread_id,
      receipt_json: receiptJson,
      from_name: fromName,
      from_email: t.from_email,
      account_id: t.account_id ?? null,
      mailbox: mailbox ?? null,
      email_at: t.last_message_at,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'gmail_thread_id']).doUpdateSet({ receipt_json: receiptJson, from_name: fromName }),
    )
    .execute();
}

export interface Receipt {
  /** The email it came from, or null once that email is gone. */
  threadId: string | null;
  merchant: string;
  /** Lowercased, punctuation dropped: what two spellings of a shop share. */
  merchantKey: string;
  amount: number;
  currency: string;
  /** When it was bought if the email said, else when the email arrived. */
  at: string;
  orderNumber: string | null;
  /** How it was paid ("Visa ••1234", "PayPal"), when the email said. */
  paymentMethod: string | null;
  /** The mailbox it arrived in. */
  mailbox: string | null;
}

export interface ReceiptFilter {
  /** Substring of the merchant name. */
  merchant?: string;
  /** ISO instants, inclusive / exclusive. */
  after?: string;
  before?: string;
}

export function merchantKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|com)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cents = (n: number) => Math.round(n * 100) / 100;

function instantOr(value: string | null | undefined, fallback: string): string {
  if (value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

/**
 * One purchase often produces several emails (order placed, payment taken,
 * shipped), each mined into its own receipt. Counting them all triples a
 * total, so later copies of the same order, or of the same amount at the same
 * shop on the same day, are dropped.
 */
export function dedupeReceipts(receipts: Receipt[]): Receipt[] {
  const seen = new Set<string>();
  const out: Receipt[] = [];
  for (const r of [...receipts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const base = `${r.merchantKey}|${r.currency}`;
    const byOrder = r.orderNumber ? `${base}|o:${r.orderNumber.toLowerCase()}` : null;
    const byDay = `${base}|d:${r.at.slice(0, 10)}|${r.amount.toFixed(2)}`;
    if ((byOrder && seen.has(byOrder)) || seen.has(byDay)) continue;
    if (byOrder) seen.add(byOrder);
    seen.add(byDay);
    out.push(r);
  }
  return out.reverse();
}

/** The user's receipts, newest first, one per purchase. */
export async function listReceipts(
  db: Kysely<DB>,
  userId: string,
  filter: ReceiptFilter = {},
): Promise<{ receipts: Receipt[]; truncated: boolean }> {
  // ADR 0249 — read from the kept copies, so a receipt whose email was
  // trashed or deleted still counts. The thread is joined only for a link,
  // which is absent once the email is gone.
  const rows = await db
    .selectFrom('email_receipts as r')
    .leftJoin('email_threads as t', (j) =>
      j.onRef('t.user_id', '=', 'r.user_id').onRef('t.gmail_thread_id', '=', 'r.gmail_thread_id'),
    )
    .select([
      't.id as threadId',
      'r.receipt_json as receipt_json',
      'r.from_name as from_name',
      'r.from_email as from_email',
      'r.email_at as email_at',
      'r.mailbox as mailbox',
    ])
    .where('r.user_id', '=', userId)
    .orderBy(textInstant('r.email_at', null), 'desc')
    .limit(MAX_ROWS + 1)
    .execute();
  const truncated = rows.length > MAX_ROWS;

  const all: Receipt[] = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    const r = row.receipt_json as unknown as StoredReceipt | string | null;
    // A value the key could not open comes back as its stored string.
    if (!r || typeof r !== 'object') continue;
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount <= 0) continue;
    const merchant =
      r.merchant?.trim() || row.from_name?.trim() || row.from_email?.split('@')[1] || 'Unknown';
    all.push({
      threadId: row.threadId ?? null,
      merchant: merchant.slice(0, 80),
      merchantKey: merchantKeyOf(merchant),
      amount: r.amount,
      currency: r.currency?.trim().toUpperCase() || UNKNOWN_CURRENCY,
      at: instantOr(r.purchasedAt, row.email_at),
      orderNumber: r.orderNumber?.trim() || null,
      paymentMethod: normalizePaymentMethod(r.paymentMethod),
      mailbox: row.mailbox ?? null,
    });
  }

  const needle = filter.merchant ? merchantKeyOf(filter.merchant) : '';
  const afterMs = filter.after ? Date.parse(filter.after) : NaN;
  const beforeMs = filter.before ? Date.parse(filter.before) : NaN;
  const receipts = dedupeReceipts(all).filter((r) => {
    if (needle && !r.merchantKey.includes(needle)) return false;
    const t = Date.parse(r.at);
    if (Number.isFinite(afterMs) && t < afterMs) return false;
    if (Number.isFinite(beforeMs) && t >= beforeMs) return false;
    return true;
  });
  return { receipts, truncated };
}

export interface SpendingGroup {
  /** Merchant name, or `YYYY-MM`. */
  key: string;
  currency: string;
  total: number;
  count: number;
  lastAt: string;
}

/**
 * Totals by merchant or by month. One row per currency within a group:
 * dollars and euros are never added together.
 */
export function summarizeSpending(
  receipts: Receipt[],
  by: 'merchant' | 'month',
  /** Minutes east of UTC, so a month boundary is the user's, not the server's. */
  offsetMinutes = 0,
): SpendingGroup[] {
  const groups = new Map<string, SpendingGroup>();
  for (const r of receipts) {
    const local = new Date(Date.parse(r.at) + offsetMinutes * 60_000).toISOString();
    const key = by === 'month' ? local.slice(0, 7) : r.merchantKey;
    const id = `${key}|${r.currency}`;
    const g = groups.get(id);
    if (!g) {
      groups.set(id, {
        key: by === 'month' ? key : r.merchant,
        currency: r.currency,
        total: r.amount,
        count: 1,
        lastAt: r.at,
      });
      continue;
    }
    g.total += r.amount;
    g.count += 1;
    if (r.at > g.lastAt) g.lastAt = r.at;
  }
  const out = [...groups.values()].map((g) => ({ ...g, total: cents(g.total) }));
  return by === 'month'
    ? out.sort((a, b) => b.key.localeCompare(a.key) || b.total - a.total)
    : out.sort((a, b) => b.total - a.total);
}

/** How many individual receipts and months the Finance tab is handed. */
const OVERVIEW_RECEIPTS = 50;
const OVERVIEW_MONTHS = 12;

/** Everything the Finance tab shows, from one read of the receipts. */
export async function receiptsOverview(db: Kysely<DB>, userId: string): Promise<EmailReceiptsOverview> {
  const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  const offset = user?.last_tz ? (tzToOffsetMinutes(user.last_tz) ?? 0) : 0;
  const { receipts, truncated } = await listReceipts(db, userId);
  const months = summarizeSpending(receipts, 'month', offset);
  const shownMonths = [...new Set(months.map((m) => m.key))].slice(0, OVERVIEW_MONTHS);
  return {
    receipts: receipts.slice(0, OVERVIEW_RECEIPTS).map((r) => ({
      threadId: r.threadId,
      merchant: r.merchant,
      amount: r.amount,
      currency: r.currency,
      at: r.at,
      orderNumber: r.orderNumber,
      paymentMethod: r.paymentMethod,
      mailbox: r.mailbox,
    })),
    months: months
      .filter((m) => shownMonths.includes(m.key))
      .map((m) => ({ month: m.key, currency: m.currency, total: m.total, count: m.count })),
    recurring: detectRecurring(receipts),
    truncated,
  };
}

export type Cadence ='weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringCharge {
  merchant: string;
  currency: string;
  /** The most recent charge. */
  amount: number;
  cadence: Cadence;
  charges: number;
  lastAt: string;
  /** Last charge plus one period. A guess from the pattern, not a bill. */
  nextExpectedAt: string;
  /** The newest charge whose email is still there, else null. */
  threadId: string | null;
}

const CADENCES: Array<{ name: Cadence; days: number; slack: number }> = [
  { name: 'weekly', days: 7, slack: 2 },
  { name: 'monthly', days: 30.4, slack: 6 },
  { name: 'quarterly', days: 91, slack: 12 },
  { name: 'yearly', days: 365, slack: 30 },
];
/** Two charges are a coincidence; three at an even spacing are a pattern. */
const MIN_CHARGES = 3;
const AMOUNT_SPREAD = 0.15;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Charges that repeat: the same merchant, at an even spacing, for about the
 * same amount. Meant for "what am I paying for every month", so a pattern
 * that has already stopped (no charge for two periods) is left out.
 */
export function detectRecurring(receipts: Receipt[], nowMs = Date.now()): RecurringCharge[] {
  const byMerchant = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const id = `${r.merchantKey}|${r.currency}`;
    const list = byMerchant.get(id);
    if (list) list.push(r);
    else byMerchant.set(id, [r]);
  }

  const out: RecurringCharge[] = [];
  for (const list of byMerchant.values()) {
    if (list.length < MIN_CHARGES) continue;
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const gaps = sorted.slice(1).map((r, i) => (Date.parse(r.at) - Date.parse(sorted[i].at)) / DAY);
    const cadence = CADENCES.find((c) => gaps.every((g) => Math.abs(g - c.days) <= c.slack));
    if (!cadence) continue;
    const mid = median(sorted.map((r) => r.amount));
    if (sorted.some((r) => Math.abs(r.amount - mid) > mid * AMOUNT_SPREAD)) continue;

    const last = sorted[sorted.length - 1];
    const lastMs = Date.parse(last.at);
    if (nowMs - lastMs > 2 * cadence.days * DAY) continue;
    out.push({
      merchant: last.merchant,
      currency: last.currency,
      amount: last.amount,
      cadence: cadence.name,
      charges: sorted.length,
      lastAt: last.at,
      nextExpectedAt: new Date(lastMs + cadence.days * DAY).toISOString(),
      threadId: [...sorted].reverse().find((r) => r.threadId)?.threadId ?? null,
    });
  }
  return out.sort((a, b) => Date.parse(a.nextExpectedAt) - Date.parse(b.nextExpectedAt));
}
