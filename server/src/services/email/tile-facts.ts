/**
 * ADR 0087 — fail-closed tile facts: timeline from dates we already have;
 * state/ledger from subject+snippet heuristics. Never invent an amount.
 */
import {
  flightAwareUrl,
  type EmailFlightRef,
  type EmailLedgerFact,
  type EmailStateFact,
  type EmailStateStatus,
  type EmailTileFacts,
  type EmailTimelineFact,
} from '@chord/kernel';

import { instantInZoneMs, isAllDayValue, offsetForLocalDatetime, zonedDayStartUtc } from '../../utils/tz.js';
import { trackingUrl } from './tracking.js';

export const FACTS_PER_TILE = 6;

/** `email_threads.flight_json` as stored by the magics pass (ADR 0138). */
export interface StoredFlight {
  iata?: string | null;
  number?: string | null;
  ident?: string | null;
  airline?: string | null;
  departAt?: string | null;
  arriveAt?: string | null;
  origin?: string | null;
  destination?: string | null;
  status?: string | null;
}

/** Arrival if the mail gave one, else departure — when this stops being news. */
function flightWhen(f?: StoredFlight | null): string | null {
  return f?.arriveAt ?? f?.departAt ?? null;
}

/**
 * The render-time flight ref. Like `trackingUrl`, the URL is rebuilt from the
 * ident rather than stored, so a FlightAware template that changes cannot
 * strand old rows.
 */
export function flightRef(f?: StoredFlight | null): EmailFlightRef | null {
  if (!f?.iata || !f.number) return null;
  return {
    iata: f.iata,
    number: f.number,
    airline: f.airline ?? null,
    ident: f.ident ?? null,
    url: f.ident ? flightAwareUrl(f.ident) : null,
  };
}

/** What the mail said the flight was doing, as a board status. */
export function flightStateStatus(f?: StoredFlight | null): EmailStateStatus | null {
  if (!f?.iata) return null;
  switch (f.status) {
    case 'delayed':
      return 'delayed';
    case 'boarding':
      return 'boarding';
    case 'check_in':
      return 'check_in';
    case 'cancelled':
      return 'cancelled';
    default:
      // A flight we know about and have heard nothing alarming about is
      // still worth a row — it is the thing you are about to have to do.
      return 'scheduled';
  }
}

const LANDED =
  /\b(delivered|has arrived|arrived at|left at|was delivered|package delivered)\b/i;
const STATUS_PATTERNS: Array<{ re: RegExp; status: EmailStateStatus }> = [
  { re: /\bout\s+for\s+delivery\b/i, status: 'out_for_delivery' },
  { re: /\bdelayed\b/i, status: 'delayed' },
  { re: /\bboarding\b/i, status: 'boarding' },
  { re: /\bcheck[-\s]?in\b/i, status: 'check_in' },
  { re: /\bin\s+transit\b|\bon\s+the\s+way\b/i, status: 'in_transit' },
  { re: /\bshipped\b/i, status: 'shipped' },
];

const PAID_NOISE =
  /\b(receipt|payment received|thank you for your (order|payment)|paid in full)\b/i;
const HAS_DUE = /\bdue\b/i;
// The grouped branch must come first AND require a separator: `\d{1,3}` would
// otherwise win on `$1240` and report 124.
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?`;
const AMOUNT_RE = new RegExp(`(?:\\$\\s*|usd\\s*)(${NUMBER})|(${NUMBER})\\s*usd`, 'i');
/** `-$119.90`, `($119.90)` and `+$5` — the sign sits OUTSIDE `AMOUNT_RE`. */
const SIGNED_AMOUNT_RE = new RegExp(`([-+(])?\\s*(?:\\$\\s*|usd\\s*)(${NUMBER})`, 'i');
/** Words that make a statement line a credit even with no sign on the number. */
const CREDIT_WORDS = /\b(refund(ed)?|credit(ed)?|reimburse(d|ment)?|cash\s?back)\b/i;

/** Landed rows are dropped (resolution rule). Null = no status claim. */
export function extractStateStatus(subject: string, snippet: string): EmailStateStatus | null {
  const hay = `${subject} ${snippet}`;
  if (LANDED.test(hay)) return null;
  for (const p of STATUS_PATTERNS) {
    if (p.re.test(hay)) return p.status;
  }
  return null;
}

export function parseAmount(text: string): number | null {
  const m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').replace(/,/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Which way the money went.
 *
 * Three signals in falling order of trust: a sign on the number (`-$119.90`,
 * or `($119.90)` in accounting style), an explicit amount due, then the
 * wording around it ("a merchant credit was issued").
 *
 * "Due" has to outrank the wording. A statement that mentions a refund and
 * then states a balance — "Your refund was applied. Balance due $200.00" — is
 * money owed, and a bare keyword search calls the whole line a credit. The
 * keyword only decides when nothing firmer is on offer, which is exactly the
 * Amex case: no sign on the figure Gmail put in the snippet, no due date, just
 * "your account has been credited".
 */
export function parseDirection(text: string): 'debit' | 'credit' {
  const m = SIGNED_AMOUNT_RE.exec(text);
  const sign = m?.[1];
  if (sign === '-' || sign === '(') return 'credit';
  if (sign === '+') return 'debit';
  if (HAS_DUE.test(text)) return 'debit';
  return CREDIT_WORDS.test(text) ? 'credit' : 'debit';
}

/**
 * The merchant a card-issuer notification is ABOUT, not the issuer that sent it.
 *
 * Amex, and issuers generally, lay a statement line out as the merchant on its
 * own line directly above the figure:
 *
 *     REI #133 EAST HANOVE
 *
 *     -$119.90
 *
 * Without this every Amex row in the ledger read "American Express", which is
 * the one merchant the email is definitely not about, and made the whole tile
 * useless for telling charges apart.
 *
 * Deliberately narrow: the line has to sit immediately above the amount, be
 * short, and read like a label rather than prose. Anything else falls back to
 * the sender, so a layout this does not recognise degrades to today's
 * behaviour instead of inventing a merchant.
 */
export function merchantFromBody(snippet: string): string | null {
  const lines = snippet
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const amountAt = lines.findIndex((l) => SIGNED_AMOUNT_RE.test(l) && l.length <= 24);
  if (amountAt < 1) return null;
  const candidate = lines[amountAt - 1]!;
  if (candidate.length > 48) return null;
  // Prose, not a label: a sentence, a question, or an address-shaped line.
  if (/[.!?:;]$/.test(candidate)) return null;
  if (/\s(is|was|are|were|has|have|will|you|your|the)\s/i.test(candidate)) return null;
  if (SIGNED_AMOUNT_RE.test(candidate)) return null;
  return candidate.slice(0, 80);
}

function merchantFrom(fromName: string | null, fromEmail: string | null, subject: string): string {
  const name = (fromName ?? '').trim();
  if (name && !/@/.test(name)) return name.slice(0, 80);
  const email = (fromEmail ?? '').trim();
  if (email.includes('@')) {
    const domain = email.split('@')[1] ?? '';
    const host = domain.split('.')[0] ?? domain;
    if (host) return host.slice(0, 80);
  }
  return (subject || 'Charge').slice(0, 80);
}

/** ADR 0074 — a bare date carries the owner's offset, never a silent UTC noon,
 *  or the line renders a day off for zones past ±12h. */
/**
 * `tz` (the reader's IANA zone, when known) resolves this specific due date's
 * own DST side; `utcOffset` — a flat "now" snapshot — is the fallback for
 * whichever caller has no zone name. Without this, a bill due months out
 * silently inherited whatever DST side was in effect when the mail was
 * classified rather than the due date's own.
 */
function parseDueAt(text: string, utcOffset: string, tz?: string | null): string | null {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);
  if (!iso) return null;
  const local = `${iso[1]}T12:00:00`;
  return `${local}${tz ? offsetForLocalDatetime(tz, local) : utcOffset}`;
}

/**
 * Ledger line or null. Receipts/thank-yous without "due" are treated as
 * already settled - not shown as amounts owed.
 */
export function extractLedgerFact(
  subject: string,
  snippet: string,
  fromName: string | null,
  fromEmail: string | null,
  threadId: string,
  utcOffset = '+00:00',
  tz?: string | null,
): EmailLedgerFact | null {
  const hay = `${subject} ${snippet}`;
  if (PAID_NOISE.test(hay) && !HAS_DUE.test(hay)) return null;
  const amount = parseAmount(hay);
  if (amount === null) return null;
  return {
    merchant: merchantFromBody(snippet) ?? merchantFrom(fromName, fromEmail, subject),
    amount,
    direction: parseDirection(hay),
    dueAt: parseDueAt(hay, utcOffset, tz),
    threadId,
  };
}

/** Optional magics JSON `{ kind: 'ledger', amount, merchant?, dueAt? }` - ignored unless amount parses. */
export function ledgerFromArgs(args: unknown, threadId: string, fallbackMerchant: string): EmailLedgerFact | null {
  if (!args || typeof args !== 'object') return null;
  const o = args as Record<string, unknown>;
  if (o.kind !== 'ledger') return null;
  const amount = typeof o.amount === 'number' ? o.amount : parseAmount(String(o.amount ?? ''));
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const merchant =
    typeof o.merchant === 'string' && o.merchant.trim() ? o.merchant.trim().slice(0, 80) : fallbackMerchant;
  const dueAt = typeof o.dueAt === 'string' && Date.parse(o.dueAt) ? o.dueAt : null;
  const direction = o.direction === 'credit' ? 'credit' : 'debit';
  return { merchant, amount, direction, dueAt, threadId };
}

/** `email_threads.receipt_json` as stored by the magics pass (ADR 0160). */
export interface StoredReceipt {
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  purchasedAt?: string | null;
  orderNumber?: string | null;
}

/**
 * A receipt is settled, never owed — `direction: 'paid'` so it never reads
 * like a bill (`debit`) or a refund (`credit`), and never carries a `dueAt`:
 * there is nothing left to do about a purchase already complete.
 */
export function receiptToLedgerFact(
  r: StoredReceipt | null | undefined,
  threadId: string,
  fallbackMerchant: string,
): EmailLedgerFact | null {
  if (!r || typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount <= 0) return null;
  const merchant = r.merchant?.trim() ? r.merchant.trim().slice(0, 80) : fallbackMerchant;
  return { merchant, amount: r.amount, direction: 'paid', dueAt: null, threadId };
}

/** ISO instant, or NaN. Offsets mean these can never be compared as strings. */
function instant(iso: string): number {
  return Date.parse(iso);
}

/**
 * Has this time not gone by yet? A floating value is wall time in `tz`, and a
 * date or all-day value lasts until the end of its day there.
 */
export function stillAhead(iso: string, nowMs: number, tz: string | null = null): boolean {
  const t = instantInZoneMs(iso, tz);
  if (!Number.isFinite(t)) return false;
  if (isAllDayValue(iso)) {
    const day = iso.slice(0, 10);
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return zonedDayStartUtc(next.toISOString().slice(0, 10), tz).getTime() > nowMs;
  }
  return t >= nowMs;
}

export function dropPastTimeline(
  items: EmailTimelineFact[],
  nowMs = Date.now(),
  tz: string | null = null,
): EmailTimelineFact[] {
  return items.filter((i) => stillAhead(i.at, nowMs, tz));
}

/** Exceptions first, so a truncated board still shows the row you'd act on. */
const STATUS_RANK: Record<EmailStateStatus, number> = {
  cancelled: 0,
  delayed: 1,
  out_for_delivery: 2,
  check_in: 3,
  boarding: 4,
  in_transit: 5,
  shipped: 6,
  scheduled: 7,
};

/** ADR 0160 — owed, then coming back, then settled and done. */
const LEDGER_RANK: Record<'debit' | 'credit' | 'paid', number> = {
  debit: 0,
  credit: 1,
  paid: 2,
};

/**
 * Order then truncate. The reads behind these facts have no ORDER BY, so
 * without a total order the same tile could show different lines per refresh.
 */
export function capFacts(facts: EmailTileFacts, cap = FACTS_PER_TILE): EmailTileFacts {
  if (facts.kind === 'timeline') {
    const items = [...facts.items]
      .sort((a, b) => instant(a.at) - instant(b.at) || a.threadId.localeCompare(b.threadId))
      .slice(0, cap);
    return { kind: 'timeline', items };
  }
  if (facts.kind === 'state_board') {
    const items = [...facts.items]
      .sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.threadId.localeCompare(b.threadId),
      )
      .slice(0, cap);
    return { kind: 'state_board', items };
  }
  const items = [...facts.items]
    .sort(
      (a, b) =>
        // Money owed outranks money coming back outranks a settled receipt
        // (ADR 0160) — nothing to do about a `paid` row, whatever its size, so
        // it never takes the top of the tile from a bill that is due.
        LEDGER_RANK[a.direction ?? 'debit'] - LEDGER_RANK[b.direction ?? 'debit'] ||
        (a.dueAt ? instant(a.dueAt) : Infinity) - (b.dueAt ? instant(b.dueAt) : Infinity) ||
        b.amount - a.amount ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, cap);
  return { kind: 'ledger', items };
}

/**
 * One line per (thread, instant): a thread announcing two dates keeps both,
 * while the confirmed event and the proposal that produced it collapse to the
 * confirmed copy.
 */
export function dedupeTimeline(items: EmailTimelineFact[]): EmailTimelineFact[] {
  const bySlot = new Map<string, EmailTimelineFact>();
  for (const item of items) {
    const key = `${item.threadId}|${instant(item.at)}`;
    const prev = bySlot.get(key);
    if (!prev || (!item.proposalId && prev.proposalId)) bySlot.set(key, item);
  }
  return [...bySlot.values()];
}

export function mergeTimeline(a: EmailTimelineFact[], b: EmailTimelineFact[]): EmailTimelineFact[] {
  return dedupeTimeline([...a, ...b]);
}

export function buildStateFact(
  title: string,
  status: EmailStateStatus,
  threadId: string,
  delivery?: { etaAt?: string | null; carrier?: string | null; trackingNumber?: string | null } | null,
  flight?: StoredFlight | null,
): EmailStateFact {
  const carrier = delivery?.carrier;
  const number = delivery?.trackingNumber;
  const url = carrier && number ? trackingUrl(carrier, number) : null;
  const ref = flightRef(flight);
  // A flight's own clock is its arrival, which is what stops the row being
  // news — the same thing an ETA does for a parcel. So it reuses the field and
  // the drop rule rather than growing a second one. A delivery date wins: it
  // is the older meaning of the field, and no row is both.
  const etaAt = delivery?.etaAt ?? (ref ? flightWhen(flight) : null);
  return {
    title: title || 'Package',
    status,
    threadId,
    ...(ref ? { flight: ref } : {}),
    // Present only when known. A shipping update we learned nothing extra about
    // keeps exactly the shape it had before ADR 0135, so nothing downstream has
    // to tell "no arrival date" apart from "this predates the field".
    ...(etaAt ? { etaAt } : {}),
    // Rebuilt from carrier+number rather than stored, so a URL template that
    // changes does not leave old rows pointing at a dead page.
    ...(carrier && number && url ? { tracking: { carrier, number, url } } : {}),
  };
}

/**
 * ADR 0135 — a delivery stops being news once its arrival has passed, and
 * ADR 0138 — so does a flight once it has landed.
 *
 * The same rule `dropPastTimeline` applies to dated items, and it is the only
 * exit these rows have: `extractStateStatus` drops a thread that says
 * "delivered", but plenty of parcels simply arrive and nobody emails about it,
 * and nobody at all emails to say a flight landed. A row with no arrival time
 * is kept — we know nothing that says it is over.
 */
export function dropLandedRows(
  items: EmailStateFact[],
  nowMs = Date.now(),
  tz: string | null = null,
): EmailStateFact[] {
  return items.filter((i) => {
    if (!i.etaAt) return true;
    if (!Number.isFinite(instantInZoneMs(i.etaAt, tz))) return true;
    return stillAhead(i.etaAt, nowMs, tz);
  });
}
