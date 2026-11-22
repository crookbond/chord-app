/**
 * The colour and emoji on an AI-view heading (Feed and Cards). Picked from
 * the category's own words, so "School" looks like school on every device;
 * a title no rule knows gets a neutral envelope and a colour fixed by its
 * name, so it does not change between visits.
 */

export interface HeadingStyle {
  emoji: string;
  /** Tint behind the heading. */
  bg: string;
  /** Heading text and accent. */
  fg: string;
}

const PALETTE = {
  blue: { bg: '#DBEAFE', fg: '#1D4ED8' },
  pink: { bg: '#FCE7F3', fg: '#BE185D' },
  green: { bg: '#DCFCE7', fg: '#15803D' },
  amber: { bg: '#FEF3C7', fg: '#B45309' },
  teal: { bg: '#CCFBF1', fg: '#0F766E' },
  red: { bg: '#FEE2E2', fg: '#B91C1C' },
  sky: { bg: '#E0F2FE', fg: '#0369A1' },
  violet: { bg: '#EDE9FE', fg: '#6D28D9' },
  orange: { bg: '#FFEDD5', fg: '#C2410C' },
} as const;
type Tint = keyof typeof PALETTE;

/** Same hues for dark mode: a deep tint behind light text. */
const DARK_PALETTE: Record<Tint, { bg: string; fg: string }> = {
  blue: { bg: '#172554', fg: '#93C5FD' },
  pink: { bg: '#4A1530', fg: '#F9A8D4' },
  green: { bg: '#14321F', fg: '#86EFAC' },
  amber: { bg: '#3B2A0B', fg: '#FCD34D' },
  teal: { bg: '#0F302C', fg: '#5EEAD4' },
  red: { bg: '#3F1515', fg: '#FCA5A5' },
  sky: { bg: '#0B2A3D', fg: '#7DD3FC' },
  violet: { bg: '#2A1B4A', fg: '#C4B5FD' },
  orange: { bg: '#3D1F0B', fg: '#FDBA74' },
};

/** First match wins, so the narrower words come before the broad ones. */
const RULES: Array<{ re: RegExp; emoji: string; tint: Tint }> = [
  { re: /\b(flights?|airlines?|boarding)\b/, emoji: '✈️', tint: 'sky' },
  { re: /\b(hotels?|stays?|lodging|airbnb)\b/, emoji: '🏨', tint: 'sky' },
  { re: /\b(travel|trips?|itinerar(y|ies)|vacations?)\b/, emoji: '🧳', tint: 'sky' },
  { re: /\b(deliver(y|ies)|shipping|shipments?|packages?|parcels?)\b/, emoji: '📦', tint: 'orange' },
  { re: /\b(orders?|shopping|purchases?)\b/, emoji: '🛍️', tint: 'orange' },
  { re: /\b(receipts?)\b/, emoji: '🧾', tint: 'amber' },
  { re: /\b(coupons?|deals?|sales?|promotions?|offers?)\b/, emoji: '🏷️', tint: 'amber' },
  { re: /\b(bills?|invoices?|payments?|bank(ing)?|finance|financial|money|tax(es)?|insurance)\b/, emoji: '💳', tint: 'green' },
  { re: /\b(school|class(es)?|teachers?|homework|pta|education|kids?)\b/, emoji: '🎒', tint: 'blue' },
  { re: /\b(sports?|soccer|practice|games?|team|swim)\b/, emoji: '⚽', tint: 'green' },
  { re: /\b(health|medical|doctors?|dentist|appointments?|pharmacy)\b/, emoji: '🩺', tint: 'red' },
  { re: /\b(events?|invites?|invitations?|parties|party|rsvp)\b/, emoji: '🎉', tint: 'pink' },
  { re: /\b(family|home|household)\b/, emoji: '🏠', tint: 'pink' },
  { re: /\b(work|jobs?|professional|career)\b/, emoji: '💼', tint: 'violet' },
  { re: /\b(social|friends)\b/, emoji: '💬', tint: 'violet' },
  { re: /\b(recipes?|food|dining|restaurants?)\b/, emoji: '🍽️', tint: 'orange' },
  { re: /\b(newsletters?|news|reading)\b/, emoji: '📰', tint: 'teal' },
  { re: /\b(accounts?|security|password)\b/, emoji: '🔐', tint: 'teal' },
  // The AI view's own kind headings (ADR 0146/0147).
  { re: /\b(to-?dos?|tasks?)\b/, emoji: '✅', tint: 'green' },
  { re: /\b(lists?)\b/, emoji: '📝', tint: 'amber' },
  { re: /\b(recent|mail|inbox)\b/, emoji: '📬', tint: 'blue' },
];

const FALLBACK_ORDER: Tint[] = ['blue', 'pink', 'green', 'amber', 'teal', 'violet', 'sky', 'orange'];

export function emailHeadingStyle(title: string, scheme: 'light' | 'dark' = 'light'): HeadingStyle {
  const tints = scheme === 'dark' ? DARK_PALETTE : PALETTE;
  const t = title.toLowerCase();
  const rule = RULES.find((r) => r.re.test(t));
  if (rule) return { emoji: rule.emoji, ...tints[rule.tint] };
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
  return { emoji: '✉️', ...tints[FALLBACK_ORDER[hash % FALLBACK_ORDER.length]] };
}
