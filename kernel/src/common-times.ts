/**
 * ADR 0346 phase 7 - several people each offer times: the times that suit
 * everyone who has answered, worked out in code.
 *
 * Each person's offers become intervals on their own clock (a time with no
 * end lasts the meeting's length; a day with no time is their working day),
 * minus what they said they cannot do. The common times are where every
 * answered person is free for at least the meeting's length. With none, the
 * best fallback is the stretch the most people can make, naming who it does
 * not suit. The user's own calendar is checked afterwards, by the same
 * verdicts the reply drafter already uses.
 */
import { instantOfWallTime } from './time-picker';
import type { SlotFact } from './scheduling';

export interface PersonOffer {
  /** The person's address, lowercased. */
  person: string;
  /** Display name when the mail gave one. */
  name?: string;
  offered: SlotFact[];
  unavailable: SlotFact[];
  /** When their newest message with times was sent. */
  at?: string;
}

export interface Span {
  startMs: number;
  endMs: number;
}

export interface CommonTimes {
  /** Stretches every answered person can make, soonest first. */
  windows: Span[];
  /** Who has offered or said what they cannot do. */
  answered: string[];
  /** Core people who have not answered yet. */
  waiting: string[];
  /** With no common time: the stretch most people can make. */
  best?: Span & { who: string[]; missing: string[] };
}

/** A day with no time: their working day. */
const DAY_START_MIN = 8 * 60;
const DAY_END_MIN = 18 * 60;

function at(day: string, minutes: number, zone: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const carry = Math.floor(minutes / 1440);
  const base = new Date(Date.UTC(y, m - 1, d + carry));
  const min = ((minutes % 1440) + 1440) % 1440;
  return instantOfWallTime(
    {
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
      hour: Math.floor(min / 60),
      minute: min % 60,
    },
    zone,
  ).getTime();
}

/** One slot as an interval; null when it has no readable day. */
export function slotSpan(s: SlotFact, userZone: string, durationMin: number, dayOnly: 'work' | 'whole' = 'work'): Span | null {
  if (!s.day) return null;
  const zone = s.timeZone ?? userZone;
  if (typeof s.minutes !== 'number') {
    return dayOnly === 'whole'
      ? { startMs: at(s.day, 0, zone), endMs: at(s.day, 1440, zone) }
      : { startMs: at(s.day, DAY_START_MIN, zone), endMs: at(s.day, DAY_END_MIN, zone) };
  }
  const end = s.endMinutes ?? s.minutes + durationMin;
  return { startMs: at(s.day, s.minutes, zone), endMs: at(s.day, end, zone) };
}

function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.endMs > s.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

function subtract(spans: Span[], cut: Span[]): Span[] {
  let out = spans;
  for (const c of merge(cut)) {
    const next: Span[] = [];
    for (const s of out) {
      if (c.endMs <= s.startMs || c.startMs >= s.endMs) {
        next.push(s);
        continue;
      }
      if (c.startMs > s.startMs) next.push({ startMs: s.startMs, endMs: c.startMs });
      if (c.endMs < s.endMs) next.push({ startMs: c.endMs, endMs: s.endMs });
    }
    out = next;
  }
  return out;
}

function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.startMs, y.startMs);
      const e = Math.min(x.endMs, y.endMs);
      if (e > s) out.push({ startMs: s, endMs: e });
    }
  }
  return merge(out);
}

/** A person's free stretches: what they offered, minus what they cannot do. */
export function personSpans(p: PersonOffer, userZone: string, durationMin: number): Span[] {
  const offered = merge(
    p.offered.map((s) => slotSpan(s, userZone, durationMin)).filter((s): s is Span => !!s),
  );
  const cannot = p.unavailable
    .map((s) => slotSpan(s, userZone, durationMin, 'whole'))
    .filter((s): s is Span => !!s);
  return subtract(offered, cannot);
}

export function commonTimes(
  offers: readonly PersonOffer[],
  opts: { userZone: string; durationMin?: number; corePeople?: readonly string[]; nowMs?: number },
): CommonTimes {
  const dur = (opts.durationMin ?? 60) * 60_000;
  const now = opts.nowMs ?? Date.now();
  const withTimes = offers.filter((o) => o.offered.length > 0);
  const answered = offers.map((o) => o.person);
  const waiting = (opts.corePeople ?? []).map((p) => p.toLowerCase()).filter((p) => !answered.includes(p));
  const per = withTimes.map((o) => ({
    person: o.person,
    spans: personSpans(o, opts.userZone, dur / 60_000)
      .map((s) => ({ startMs: Math.max(s.startMs, now), endMs: s.endMs }))
      .filter((s) => s.endMs - s.startMs >= dur),
  }));
  if (per.length === 0) return { windows: [], answered, waiting };

  let common = per[0]!.spans;
  for (const p of per.slice(1)) common = intersect(common, p.spans);
  // Someone who only said what they cannot do still narrows it.
  const refusals = offers
    .filter((o) => o.offered.length === 0)
    .flatMap((o) => o.unavailable.map((s) => slotSpan(s, opts.userZone, dur / 60_000, 'whole')))
    .filter((s): s is Span => !!s);
  common = subtract(common, refusals);
  const windows = common.filter((s) => s.endMs - s.startMs >= dur);
  if (windows.length > 0 || per.length < 2) return { windows, answered, waiting };

  // No time suits everyone: the stretch the most people can make.
  const edges = [...new Set(per.flatMap((p) => p.spans.flatMap((s) => [s.startMs, s.endMs])))].sort((a, b) => a - b);
  let best: CommonTimes['best'];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const seg = { startMs: edges[i]!, endMs: edges[i + 1]! };
    const who = per.filter((p) => p.spans.some((s) => s.startMs <= seg.startMs && s.endMs >= seg.endMs)).map((p) => p.person);
    if (who.length < 2) continue;
    const prev = best && best.who.length === who.length && best.who.every((w) => who.includes(w)) && best.endMs === seg.startMs;
    if (prev) {
      best!.endMs = seg.endMs;
      continue;
    }
    if (!best || who.length > best.who.length || (best.endMs - best.startMs < dur && seg.endMs - seg.startMs >= dur)) {
      best = { ...seg, who, missing: per.map((p) => p.person).filter((p) => !who.includes(p)) };
    }
  }
  if (best && best.endMs - best.startMs < dur) best = undefined;
  return { windows: [], answered, waiting, ...(best ? { best } : {}) };
}
