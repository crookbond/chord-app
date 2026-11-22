/**
 * Carrier + tracking URL from the number alone (ADR 0135, narrowed by 0133).
 *
 * A tracking number identifies its own carrier by shape, so this is a parser
 * rather than a model call — and the carrier's tracking page is a template, so
 * "Track this" stops being an instruction and becomes a link.
 *
 * We only ever RENDER the link. Chord never fetches a carrier page: that would
 * be a per-user request to a company we have no relationship with, and it buys
 * nothing, because the email already states the date.
 */

export interface TrackingRef {
  carrier: string;
  number: string;
  url: string;
}

interface CarrierRule {
  carrier: string;
  re: RegExp;
  url: (n: string) => string;
  /** Sender domains that settle an ambiguous shape. */
  domains: string[];
  /**
   * True when the shape is a bare run of digits, which an order number, an
   * invoice number or a phone number match just as well. Such a number is only
   * a tracking number with corroboration (ADR 0133).
   */
  ambiguous?: boolean;
  /** A check the shape alone cannot express (the S10 check digit). */
  valid?: (n: string) => boolean;
}

/**
 * UPU S10 check digit: two letters, eight serial digits, one check digit, a
 * country code. The check digit is what lets an international number stand
 * alone — without it `AB123456789US` is just a reference code.
 */
function s10Valid(n: string): boolean {
  const d = n.slice(2, 11);
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 10) check = 0;
  else if (check === 11) check = 5;
  return check === Number(d[8]);
}

const usps = (n: string) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;

/**
 * Shapes are checked longest-first: a USPS number is 20-22 digits and a FedEx
 * one is 20, so testing FedEx first would claim half the USPS numbers.
 */
const CARRIERS: CarrierRule[] = [
  {
    carrier: 'UPS',
    // The one unmistakable shape - nothing else starts 1Z.
    re: /\b1Z[0-9A-Z]{16}\b/i,
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
    domains: ['ups.com'],
  },
  {
    carrier: 'Amazon',
    // Amazon Logistics: TBA + 12 digits, trackable only on Amazon's own page.
    re: /\bTBA\d{12}\b/i,
    url: (n) => `https://track.amazon.com/tracking/${n}`,
    domains: ['amazon.com'],
  },
  {
    carrier: 'USPS',
    // IMpb: the 9[1-5] prefix is assigned, so this one names itself.
    re: /\b9[1-5]\d{20}\b/,
    url: usps,
    domains: ['usps.com'],
  },
  {
    carrier: 'USPS',
    // International (S10) mail handed to USPS, e.g. from a foreign seller.
    re: /\b[A-Z]{2}\d{9}US\b/,
    url: usps,
    domains: ['usps.com'],
    valid: s10Valid,
  },
  {
    carrier: 'Canada Post',
    re: /\b[A-Z]{2}\d{9}CA\b/,
    url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en/search?searchFor=${n}`,
    domains: ['canadapost.ca', 'canadapost-postescanada.ca'],
    valid: s10Valid,
  },
  {
    carrier: 'Royal Mail',
    re: /\b[A-Z]{2}\d{9}GB\b/,
    url: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
    domains: ['royalmail.com'],
    valid: s10Valid,
  },
  {
    carrier: 'USPS',
    re: /\b(?:\d{20}|\d{22})\b/,
    url: usps,
    domains: ['usps.com'],
    ambiguous: true,
  },
  {
    carrier: 'FedEx',
    // 20 is real (Ground / SmartPost) and collides with USPS, which is why
    // USPS is listed first and why the sender tiebreak exists at all.
    re: /\b(?:\d{12}|\d{15}|\d{20})\b/,
    url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
    domains: ['fedex.com'],
    ambiguous: true,
  },
  {
    carrier: 'DHL',
    re: /\b\d{10}\b/,
    url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
    domains: ['dhl.com'],
    ambiguous: true,
  },
];

/**
 * What a shipping email says immediately before the number.
 *
 * Real shipping mail labels its number — that is the whole point of printing
 * it. An order confirmation says "Order", which is deliberately absent here.
 */
const CUE_BEFORE =
  /(track(ing)?(\s*(number|num|no\.?|#))?|awb|waybill|label|shipment|consignment|parcel|package)\W{0,12}$/i;

/** How far back to look for the cue: enough for "Tracking number: ", not a sentence. */
const CUE_WINDOW = 40;

function mentionsCarrier(text: string, carrier: string): boolean {
  return new RegExp(`\\b${carrier}\\b`, 'i').test(text);
}

/**
 * Is this bare number actually a tracking number?
 *
 * Any of three things settles it: the sender is that carrier, the carrier is
 * named in the text, or the number is labelled as a tracking number where it
 * appears. Without one of those, a 12-digit run is far more likely to be an
 * order number — and a wrong carrier link is worse than no link, because it
 * looks like an answer.
 */
function corroborated(
  rule: CarrierRule,
  text: string,
  at: number,
  senderCarrier: string | null,
): boolean {
  if (senderCarrier === rule.carrier) return true;
  if (mentionsCarrier(text, rule.carrier)) return true;
  return CUE_BEFORE.test(text.slice(Math.max(0, at - CUE_WINDOW), at));
}

/**
 * The first tracking number in the text, with the carrier it belongs to.
 *
 * `fromEmail` breaks ties: a 20-digit number is both a valid USPS and a valid
 * FedEx label, and the sender knows which. It is only a tiebreak, not a
 * requirement — most shipping mail comes from the retailer, not the carrier.
 */
export function findTracking(text: string, fromEmail?: string | null): TrackingRef | null {
  if (!text) return null;
  const domain = fromEmail?.split('@')[1]?.toLowerCase() ?? '';
  const senderCarrier = domain
    ? (CARRIERS.find((c) => c.domains.some((d) => domain === d || domain.endsWith(`.${d}`)))
        ?.carrier ?? null)
    : null;
  const ordered = senderCarrier
    ? [
        ...CARRIERS.filter((c) => c.carrier === senderCarrier),
        ...CARRIERS.filter((c) => c.carrier !== senderCarrier),
      ]
    : CARRIERS;

  for (const c of ordered) {
    const m = c.re.exec(text);
    if (!m) continue;
    if (c.valid && !c.valid(m[0].toUpperCase())) continue;
    if (c.ambiguous && !corroborated(c, text, m.index, senderCarrier)) continue;
    const number = m[0].toUpperCase();
    return { carrier: c.carrier, number, url: c.url(number) };
  }
  return null;
}

export type StatedTracking =
  | { ok: true; ref: TrackingRef }
  /** The shape fits more than one carrier (20 digits: USPS or FedEx). */
  | { ok: false; reason: 'ambiguous'; carriers: string[] }
  /** No carrier we can build a page for has this shape, or the named carrier
   *  is not one we know. */
  | { ok: false; reason: 'unrecognized' };

const CARRIER_ALIASES: Record<string, string> = {
  ups: 'UPS',
  usps: 'USPS',
  'us postal service': 'USPS',
  'postal service': 'USPS',
  'us mail': 'USPS',
  'the post office': 'USPS',
  'post office': 'USPS',
  fedex: 'FedEx',
  'fed ex': 'FedEx',
  'federal express': 'FedEx',
  dhl: 'DHL',
  'dhl express': 'DHL',
  amazon: 'Amazon',
  'amazon logistics': 'Amazon',
  'canada post': 'Canada Post',
  'royal mail': 'Royal Mail',
};

function canonicalCarrier(name: string): string | null {
  const key = name.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return CARRIER_ALIASES[key] ?? null;
}

/**
 * A number the USER hands over ("track 1Z999…", "where's my FedEx package
 * 1234…"), as opposed to one found in an email.
 *
 * Saying "track this" is itself the label ADR 0133 asks a bare number to
 * carry, so an ambiguous shape needs no further corroboration here. What it
 * still cannot do is pick between two carriers: a 20-digit number is a valid
 * USPS and FedEx label, and guessing yields somebody's "not found" page, so
 * that case asks. A carrier the user NAMES is taken at their word even when
 * the shape is unfamiliar — carriers issue more formats than this table
 * knows, and the choice is then theirs rather than Chord's guess.
 */
export function trackingForStatedNumber(raw: string, carrier?: string | null): StatedTracking {
  // People copy numbers with the spacing the label prints ("1Z 999 AA1 …").
  const number = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8,40}$/.test(number)) return { ok: false, reason: 'unrecognized' };

  if (carrier?.trim()) {
    const named = canonicalCarrier(carrier);
    const rule = named && CARRIERS.find((c) => c.carrier === named);
    if (!rule) return { ok: false, reason: 'unrecognized' };
    return { ok: true, ref: { carrier: rule.carrier, number, url: rule.url(number) } };
  }

  const fits = CARRIERS.filter((c) => {
    const m = c.re.exec(number);
    return m !== null && m[0].toUpperCase() === number && (!c.valid || c.valid(number));
  });
  const carriers = [...new Set(fits.map((c) => c.carrier))];
  if (carriers.length === 0) return { ok: false, reason: 'unrecognized' };
  if (carriers.length > 1) return { ok: false, reason: 'ambiguous', carriers };
  const rule = fits[0];
  return { ok: true, ref: { carrier: rule.carrier, number, url: rule.url(number) } };
}

/** Rebuild the link for a stored carrier+number, so a persisted delivery does
 *  not have to store a URL that might change shape. */
export function trackingUrl(carrier: string, number: string): string | null {
  const c = CARRIERS.find((x) => x.carrier.toLowerCase() === carrier.toLowerCase());
  return c ? c.url(number) : null;
}
