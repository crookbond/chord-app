/**
 * Deterministic .ics parser (ADR 0013). Wraps `node-ical` and normalizes
 * VEVENT records into the shape `create_event` expects, dropping anything
 * we explicitly chose not to support (recurrence, attendees, VTODO, etc.).
 *
 * Output is ready to feed straight into `applyToolCall({ name: 'create_event', args })`.
 */
// node-ical is CJS. Node 24's ESM loader rejects named imports it can't see
// via static analysis (and node-ical's exports don't surface that way), and
// `import * as` wraps the module so `.sync` ends up undefined. `createRequire`
// loads it the CJS way and always works.
import { createRequire } from 'node:module';
import type { CalendarComponent, CalendarResponse } from 'node-ical';

import { decodeText } from '../../../utils/text-decode.js';

const require = createRequire(import.meta.url);
const ical = require('node-ical') as { parseICS: (s: string) => CalendarResponse };

export interface ParsedIcsEvent {
  /** UID from the VEVENT — used as `externalUid` for dedup. */
  uid: string;
  title: string;
  startsAt: string;   // ISO-8601 (timed) or floating local midnight (all-day)
  endsAt?: string;    // ISO-8601, timed events only (DTEND)
  /** Date-only DTSTART → a true all-day event (free, ADR 0040) — not a
   *  timed event at an arbitrary hour. */
  allDay?: boolean;
  location?: string;
  /** ORGANIZER address, for an iTIP REPLY (ADR 0104). The email sender is
   *  NOT a substitute — an invite can be relayed by a robot address. */
  organizer?: string;
}

// Soft sanity cap — guards against pathological calendars (decades of expanded
// recurrences, etc.) without limiting normal users. Most personal Google
// Takeout exports are <10k events. Multer's 100MB request cap is the real
// upper bound; bump this if a real user hits it.
const MAX_EVENTS = 10_000;

/**
 * ORGANIZER as a bare address. node-ical hands it back either as a string or
 * as `{ val: 'mailto:someone@example.com' }` depending on whether the property
 * carried parameters (CN=), so both shapes are unwrapped.
 */
function organizerEmail(item: unknown): string | undefined {
  const raw = (item as { organizer?: unknown }).organizer;
  const val =
    typeof raw === 'string'
      ? raw
      : typeof (raw as { val?: unknown })?.val === 'string'
        ? ((raw as { val: string }).val)
        : null;
  if (!val) return undefined;
  const addr = val.replace(/^mailto:/i, '').trim();
  return addr.includes('@') ? addr.slice(0, 200) : undefined;
}

/** Timed values → UTC instant (node-ical already resolved any TZID). */
function normalizeTimed(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString();
}

/**
 * The calendar date a date-only DTSTART names, independent of which zone
 * node-ical happened to construct the Date in: a UTC-midnight Date reads
 * cleanly via toISOString; anything else means local-midnight construction,
 * so the local getters hold the intended date.
 */
function dateOnlyString(d: Date): string {
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    return d.toISOString().slice(0, 10);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ParseIcsResult {
  events: ParsedIcsEvent[];
  /** iTIP METHOD of the calendar (REQUEST, CANCEL, REPLY…), null when absent. */
  method: string | null;
  /** UIDs this payload CANCELS: every VEVENT of a METHOD:CANCEL calendar,
   *  plus any VEVENT with STATUS:CANCELLED. Callers retract/cancel by UID. */
  cancelledUids: string[];
  /** ADR 0328 — a METHOD:REPLY's answers: who (the ATTENDEE) said what
   *  (PARTSTAT) about which event (UID). Empty for anything else. */
  replies: Array<{ uid: string; email: string; partstat: string }>;
  /** Counts so the caller can report back useful import stats. */
  totalVEvents: number;
  skippedRecurring: number;
  skippedCancelled: number;
  skippedMalformed: number;
  skippedOverCap: number;
}

/**
 * The answers in a METHOD:REPLY, read from the text itself: node-ical's
 * attendee shape varies with how many there are and drops nothing we need
 * here. Lines are unfolded first (RFC 5545 §3.1).
 */
function itipReplies(text: string): Array<{ uid: string; email: string; partstat: string }> {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const out: Array<{ uid: string; email: string; partstat: string }> = [];
  for (const block of unfolded.split(/^BEGIN:VEVENT\s*$/im).slice(1)) {
    const body = block.split(/^END:VEVENT\s*$/im)[0] ?? '';
    const uid = /^UID:(.+)$/im.exec(body)?.[1]?.trim();
    if (!uid) continue;
    for (const m of body.matchAll(/^ATTENDEE([^:\r\n]*):mailto:([^\s]+)\s*$/gim)) {
      const partstat = /;PARTSTAT=([A-Za-z-]+)/i.exec(m[1] ?? '')?.[1];
      if (partstat) out.push({ uid, email: m[2]!.trim().toLowerCase(), partstat: partstat.toUpperCase() });
    }
  }
  return out;
}

export function parseIcsBuffer(buf: Buffer): ParseIcsResult {
  const text = decodeText(buf);
  const parsed = ical.parseICS(text);
  // node-ical drops calendar-level props we need; METHOD is one line.
  const method = /^METHOD\s*[:;]\s*([A-Za-z-]+)/m.exec(text)?.[1]?.toUpperCase() ?? null;

  const events: ParsedIcsEvent[] = [];
  const cancelledUids: string[] = [];
  let totalVEvents = 0;
  let skippedRecurring = 0;
  let skippedCancelled = 0;
  let skippedMalformed = 0;
  let skippedOverCap = 0;

  for (const key of Object.keys(parsed)) {
    const item = parsed[key] as CalendarComponent;
    if (item.type !== 'VEVENT') continue;
    totalVEvents++;

    if (events.length >= MAX_EVENTS) {
      skippedOverCap++;
      continue;
    }

    // A METHOD:CANCEL payload cancels every VEVENT it carries (RFC 5546) —
    // whether or not the sender also stamped STATUS:CANCELLED on the VEVENT.
    // Never emit these as importable events; surface the UID instead.
    const cancelled =
      method === 'CANCEL' || (item as { status?: string }).status === 'CANCELLED';
    if (cancelled) {
      const uid = (item as { uid?: string }).uid;
      if (uid) cancelledUids.push(uid);
      skippedCancelled++;
      continue;
    }

    // Recurrence: per ADR 0013, import the master only and skip overrides.
    // node-ical surfaces overrides on `item.recurrences`; we ignore them.
    // The master itself imports normally — no skip needed for master VEVENTs
    // with RRULE; we just don't expand instances.
    const veventLike = item as unknown as {
      uid?: string;
      summary?: string | { val: string };
      start?: Date | string;
      end?: Date | string;
      location?: string;
      datetype?: string;
      type: string;
      recurrenceid?: unknown;
    };

    // Skip individual recurrence overrides — we don't expand the master.
    if (veventLike.recurrenceid) {
      skippedRecurring++;
      continue;
    }

    if (!veventLike.uid || !veventLike.start) {
      skippedMalformed++;
      continue;
    }

    const summary =
      typeof veventLike.summary === 'string'
        ? veventLike.summary
        : veventLike.summary?.val;
    if (!summary || !summary.trim()) {
      skippedMalformed++;
      continue;
    }

    const isDateOnly = veventLike.datetype === 'date';
    const startDate =
      veventLike.start instanceof Date ? veventLike.start : new Date(veventLike.start);
    events.push({
      uid: veventLike.uid,
      title: summary.trim().slice(0, 200),
      // All-day: floating local midnight + explicit flag (ADR 0040 free
      // convention) — never a timed event at an arbitrary hour.
      startsAt: isDateOnly
        ? `${dateOnlyString(startDate)}T00:00:00`
        : normalizeTimed(veventLike.start),
      ...(isDateOnly
        ? { allDay: true }
        : veventLike.end
          ? { endsAt: normalizeTimed(veventLike.end) }
          : {}),
      location:
        typeof veventLike.location === 'string' && veventLike.location.trim()
          ? veventLike.location.trim().slice(0, 200)
          : undefined,
      ...(organizerEmail(item) ? { organizer: organizerEmail(item) } : {}),
    });
  }

  return {
    events,
    method,
    cancelledUids,
    replies: method === 'REPLY' ? itipReplies(text) : [],
    totalVEvents,
    skippedRecurring,
    skippedCancelled,
    skippedMalformed,
    skippedOverCap,
  };
}
