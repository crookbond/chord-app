/**
 * `suggest_external_action` kind `package_tracking`: decide which parcel and
 * which carrier before a URL is built, or say why not.
 *
 * Two ways in. A number the user gave is identified by shape
 * (`trackingForStatedNumber`). No number means "the package I'm waiting on",
 * answered from the carrier + number the magics pass already read out of the
 * user's shipping mail (ADR 0135) — personal 1:1 only, because that is mail
 * (ADR 0084). Every failure comes back as an instruction to ASK, never as a
 * guessed carrier: a wrong carrier link is worse than none (ADR 0133).
 */
import type { Kysely } from 'kysely';

import type { DB } from '@/db/schema.js';
import { findDeliveriesForUser, type DeliveryHit } from '@/services/email/delivery-lookup.js';
import { trackingForStatedNumber } from '@/services/email/tracking.js';
import { localWhenOrNull } from '@/utils/tz.js';
import type { ExternalActionQuery } from './external-actions.js';

export type PackageResolution =
  | { ok: true; query: ExternalActionQuery }
  | { ok: false; reason: string; instruction: string; candidates?: object[] };

const NO_URL =
  'Do NOT write a tracking URL yourself, and do NOT claim you produced a card or a link.';

function candidateView(h: DeliveryHit, tz: string | null | undefined) {
  // `arriving` is already the user's own day and weekday; the raw etaAt
  // would leave the model to derive both.
  return {
    from: h.from,
    subject: h.subject.slice(0, 120),
    carrier: h.carrier,
    arriving: localWhenOrNull(h.etaAt, tz),
  };
}

export async function resolvePackageTracking(
  db: Kysely<DB>,
  ctx: { userId: string | null; isPersonal: boolean; tz?: string | null },
  query: ExternalActionQuery,
): Promise<PackageResolution> {
  const number = query.trackingNumber?.trim();
  if (number) {
    const r = trackingForStatedNumber(number, query.carrier);
    if (r.ok) return { ok: true, query: { ...query, trackingNumber: r.ref.number, carrier: r.ref.carrier } };
    if (r.reason === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous_carrier',
        candidates: r.carriers.map((carrier) => ({ carrier })),
        instruction: `That number is a valid format for more than one carrier (${r.carriers.join(' or ')}). Ask the user which carrier it is, then call suggest_external_action again with the same query.trackingNumber and query.carrier set. ${NO_URL}`,
      };
    }
    return {
      ok: false,
      reason: query.carrier?.trim() ? 'unknown_carrier' : 'unrecognized_number',
      instruction: query.carrier?.trim()
        ? `Chord can build tracking links for UPS, USPS, FedEx, DHL, Amazon, Canada Post and Royal Mail, not "${query.carrier.trim()}". Say so and suggest the user open that carrier's site or app with their number. ${NO_URL}`
        : `That does not look like a UPS, USPS, FedEx, DHL, Amazon, Canada Post or Royal Mail tracking number. Ask the user which carrier it is (and to double-check the number), then call again with query.carrier set. ${NO_URL}`,
    };
  }

  if (!ctx.isPersonal || !ctx.userId) {
    return {
      ok: false,
      reason: 'needs_personal_chat',
      instruction: `Finding a package without its number means reading the user's own shipping email, which Chord only does in their personal chat with Chord. Ask for the tracking number (and carrier, if they know it), or suggest they ask in their personal chat. ${NO_URL}`,
    };
  }

  const hits = await findDeliveriesForUser(db, ctx.userId, query.q);
  if (hits.length === 1) {
    return { ok: true, query: { ...query, trackingNumber: hits[0].number, carrier: hits[0].carrier } };
  }
  if (hits.length === 0) {
    return {
      ok: false,
      reason: 'no_package_found',
      instruction: `No shipping email with a tracking number${query.q ? ` matching "${query.q}"` : ''} from the last 45 days. Say so plainly and ask the user for the tracking number. ${NO_URL}`,
    };
  }
  return {
    ok: false,
    reason: 'several_packages',
    candidates: hits.slice(0, 5).map((h) => candidateView(h, ctx.tz)),
    instruction: `Several packages are on the way. List them briefly (sender and expected date) and ask which one. When the user answers, call suggest_external_action again with query.q naming that sender — do not copy a tracking number from here into a later turn. ${NO_URL}`,
  };
}
