/**
 * Curated school-district → public ICS feed registry (ADR 0050).
 *
 * When a user asks Chord to "import the school calendar" by name (a county,
 * district, or school) instead of pasting a URL, we resolve it here. This is
 * deliberately a small, hand-maintained map — NOT a web search. Coverage is
 * whatever is seeded below; unknown names resolve to null and the bot asks the
 * user for the feed URL instead of guessing.
 *
 * To add a district: find its public iCal/ICS feed (most district calendar
 * pages expose a "Subscribe / iCal" link) and add an entry. Keep `aliases`
 * lowercase; the matcher normalizes the query the same way.
 */
export interface DistrictCalendar {
  /** Human label used in confirmations and the synthesized filename. */
  label: string;
  /** Public ICS / webcal feed URL. */
  url: string;
  /** Lowercase match terms (county, district, common short names). */
  aliases: string[];
}

const REGISTRY: DistrictCalendar[] = [
  // --- Seed entries (examples). Extend me. ---
  {
    label: 'Fairfax County Public Schools',
    url: 'https://www.fcps.edu/calendars/ical',
    aliases: ['fairfax', 'fairfax county', 'fcps', 'fairfax county public schools'],
  },
  {
    label: 'Montgomery County Public Schools (MD)',
    url: 'https://www.montgomeryschoolsmd.org/calendar/ical/',
    aliases: ['montgomery', 'montgomery county', 'mcps', 'montgomery county public schools'],
  },
  {
    label: 'Loudoun County Public Schools',
    url: 'https://www.lcps.org/site/handlers/icalfeed.ashx?MIID=1',
    aliases: ['loudoun', 'loudoun county', 'lcps', 'loudoun county public schools'],
  },
];

/**
 * Normalize a free-text district/school name for matching: lowercase, drop
 * punctuation, collapse whitespace, and strip filler words ("school",
 * "district", "public", "schools", "the") so "Fairfax County Public Schools",
 * "fairfax schools", and "FCPS" all reduce to the same comparable core.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|public|schools?|district|county|isd|usd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a county/district/school name to its calendar feed, or null when
 * the name isn't in the registry. Matching is alias-based: a query matches an
 * entry when its normalized form equals, or is contained by / contains, any
 * normalized alias. Conservative — abbreviations (FCPS) match exactly, longer
 * phrases match by substring, and an empty/garbage query returns null.
 */
export function resolveDistrictCalendar(query: string): DistrictCalendar | null {
  const q = normalize(query);
  if (!q) return null;
  for (const entry of REGISTRY) {
    for (const alias of entry.aliases) {
      const a = normalize(alias);
      if (!a) continue;
      // Exact alias hits (incl. short forms like "fcps" that normalize to themselves).
      if (alias.toLowerCase() === query.trim().toLowerCase()) return entry;
      if (a === q) return entry;
      // Phrase containment, but only for multi-char cores to avoid matching on
      // a stray "md" / single token.
      if (a.length >= 4 && (q.includes(a) || a.includes(q))) return entry;
    }
  }
  return null;
}
