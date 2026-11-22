/**
 * "Track my REI package" with no number: the shipments ADR 0135 already read
 * out of the user's own mail, found by who sent them.
 *
 * Reads only the asker's own threads — mail is personal (ADR 0084), so the
 * caller must keep this to the personal 1:1. The URL is rebuilt from the
 * stored carrier + number, never stored (ADR 0135).
 */
import type { Kysely } from 'kysely';

import type { DB } from '@/db/schema.js';
import { trackingUrl } from './tracking.js';

export interface DeliveryHit {
  carrier: string;
  number: string;
  url: string;
  /** Who sent the shipping email: a retailer name or address. */
  from: string;
  subject: string;
  etaAt: string | null;
}

/** How far back a shipping email is still about a package in transit. */
const LOOKBACK_DAYS = 45;
const SCAN_LIMIT = 60;

/** Words that say "a package" without saying which one. */
const GENERIC = new Set([
  'my', 'the', 'a', 'an', 'from', 'package', 'packages', 'parcel', 'order',
  'orders', 'delivery', 'shipment', 'box', 'stuff', 'thing', 'item', 'items',
]);

function queryTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !GENERIC.has(t));
}

export async function findDeliveriesForUser(
  db: Kysely<DB>,
  userId: string,
  q?: string | null,
  now: Date = new Date(),
): Promise<DeliveryHit[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await db
    .selectFrom('email_threads')
    .select(['from_name', 'from_email', 'subject', 'delivery_json', 'last_message_at'])
    .where('user_id', '=', userId)
    .where('delivery_json', 'is not', null)
    .where('last_message_at', '>=', since)
    .orderBy('last_message_at', 'desc')
    .limit(SCAN_LIMIT)
    .execute();

  const tokens = q ? queryTokens(q) : [];
  const seen = new Set<string>();
  const hits: DeliveryHit[] = [];
  for (const r of rows) {
    const d = r.delivery_json;
    const carrier = d?.carrier ?? null;
    const number = d?.trackingNumber ?? null;
    if (!carrier || !number) continue;
    const url = trackingUrl(carrier, number);
    if (!url) continue;
    // One parcel draws several emails (shipped, out for delivery, delivered);
    // the newest is first, so the first seen wins.
    if (seen.has(number)) continue;
    const from = r.from_name?.trim() || r.from_email || '';
    const subject = r.subject ?? '';
    if (tokens.length) {
      const hay = `${from} ${r.from_email ?? ''} ${subject} ${carrier}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    seen.add(number);
    hits.push({ carrier, number, url, from, subject, etaAt: d?.etaAt ?? null });
  }
  return hits;
}
