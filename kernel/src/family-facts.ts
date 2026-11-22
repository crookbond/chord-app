/**
 * Fact categories for the family-profile surface (design doc
 * `docs/tasks/family-profile-design.md`).
 *
 * Lives in kernel because both the server migration backfill and the client
 * render off the same map, and kernel is where the test harness is
 * (cf. ADR 0085 / 0120 — shared classification belongs here).
 */
export const FACT_CATEGORIES = [
  'health',
  'school',
  'contact',
  'sizes',
  'prefs',
  'logistics',
  'dates',
  'note',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/**
 * The subject a memory fact is about. 'person' (migration 082) is a private
 * `people` row — not yet shared into any group as a `persona` — and always
 * lives under the owner's personal group (memory.service.ts / people.service.ts).
 */
export type FactSubjectType = 'user' | 'persona' | 'household' | 'person';

/**
 * Best-effort category for a `memories.key` — the legacy key vocabulary
 * (`kid_school`, `allergy`, `spouse_name`, …) and anything an extractor emits.
 * Falls back to `note`, never throws.
 */
export function categoryForKey(key: string): FactCategory {
  const k = (key ?? '').trim().toLowerCase();
  if (/school|teacher|grade|classroom|\bterm\b|homeroom|principal/.test(k)) return 'school';
  if (/allerg|medical|health|doctor|pediatric|dentist|medication|\bdose\b|blood|immuni|vaccin|diagnos/.test(k)) {
    return 'health';
  }
  if (/address|wifi|vehicle|\bcar[_ ]|license|plate|emergency|insurance|garage|utilit/.test(k)) {
    return 'logistics';
  }
  if (/size|shoe|shirt|clothing|inseam|waist|jacket/.test(k)) return 'sizes';
  if (/birthday|anniversary|\bdate\b/.test(k)) return 'dates';
  if (/phone|email|\bcontact\b/.test(k) || /_name$/.test(k)) return 'contact';
  if (/hobby|likes?|dislikes?|favou?rite|prefer|diet|vegetarian|vegan|allergy_free|snack/.test(k)) {
    return 'prefs';
  }
  return 'note';
}
