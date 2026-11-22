/**
 * The morning briefing is one model-written part (the 🚨/⏰/📋 sections) and
 * several parts built in code (birthdays, weather, the weather-location
 * question, email, pending suggestions). The greeting belongs to the whole
 * message, so code writes it here, after every part is known: the model used
 * to write it, which put "Morning!" under the weather and birthdays, and its
 * "nothing needs attention" reply was printed above a full email section.
 */

import { normalizeText } from '@chord/kernel';

export const BRIEFING_GREETING = "Morning! Here's what's on your radar:";
export const BRIEFING_NOTHING = 'Morning! Nothing needs attention today.';

/** What the scan prompt tells the model to reply when it has nothing to say. */
export const SCAN_NOTHING_TOKEN = 'NOTHING';

const GREETING_LINE = /^\s*(?:good\s+)?morning\b[^\n]*(?:\n|$)/i;
const NOTHING_REPLY = new RegExp(
  String.raw`^\W*(?:${SCAN_NOTHING_TOKEN}|nothing (?:on the calendar )?needs attention(?: today)?)\W*$`,
  'i',
);

/**
 * The model's part with any greeting it wrote anyway removed. Empty string =
 * the model had nothing to report (a real answer, not a failure).
 */
export function cleanScanText(text: string): string {
  const body = text.replace(GREETING_LINE, '').trim();
  return NOTHING_REPLY.test(body) ? '' : body;
}

/**
 * Two titles that read the same — case, spacing and punctuation aside. Copies
 * of one to-do or event (group copies, a Google and a phone copy, a restated
 * email) are read back once. Only decides what a briefing says; nothing is
 * merged or written.
 */
export function sameWordsKey(title: string): string {
  return normalizeText(title.replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

/** The first of each group of items whose `key` is the same. */
export function firstOfEach<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface BriefingParts {
  celebrations?: string | null;
  weather?: string | null;
  /** cleanScanText output: '' when the model had nothing to report. */
  scan: string;
  /** ADR 0285 — the to-dos Chord took off the list, by name. */
  retired?: string | null;
  /** ADR 0346 — slots held in Chord while an invitation is on its way. */
  waiting?: string | null;
  weatherQuestion?: string | null;
  email?: string | null;
  proposals?: string | null;
}

export function composeBriefing(p: BriefingParts): string {
  // Weather and the weather-location question are not things that need
  // attention, so on their own they still read as a quiet morning.
  const hasNews = !!(p.celebrations || p.scan || p.retired || p.waiting || p.email || p.proposals);
  return [
    hasNews ? BRIEFING_GREETING : BRIEFING_NOTHING,
    p.weather,
    p.celebrations,
    p.scan,
    p.retired,
    p.waiting,
    p.weatherQuestion,
    p.email,
    p.proposals,
  ]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join('\n\n');
}
