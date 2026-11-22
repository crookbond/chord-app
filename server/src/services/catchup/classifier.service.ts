/**
 * ADR 0019 — Catchup folder classifier.
 *
 * Returns a single one-word folder name for a freshly-created entity.
 * Regex-only for now (deterministic, free, mock-safe). The ADR allows
 * an LLM fallback for ambiguous cases; we route everything through regex
 * today and route to `other` when nothing matches. Wiring an LLM call is
 * straightforward later — the function signature already accepts the
 * full (entity, currentFolderNames) tuple the prompt would need.
 */

export type EntityType = 'task' | 'list' | 'save' | 'trip';

export interface ClassifierEntity {
  type: EntityType;
  /** Primary text — task title, list name, save title, trip name. */
  primary: string;
  /** Optional secondary signal — list items, save url/note, trip destination. */
  secondary?: string;
}

interface RegexRule {
  folder: string;
  pattern: RegExp;
}

const RULES: RegexRule[] = [
  // Shopping — grocery and big-box runs.
  { folder: 'shopping', pattern: /\b(costco|target|walmart|trader\s?joe'?s?|whole\s?foods|safeway|kroger|aldi|instacart|amazon\s+fresh)\b/i },
  { folder: 'shopping', pattern: /\b(grocer(y|ies)|shopping\s+list|supplies?|stock\s+up)\b/i },
  // Recipes.
  { folder: 'recipes', pattern: /\b(recipe|allrecipes|nyt\s?cooking|seriouseats|bon\s?app[eé]tit|food\s?network|smitten\s?kitchen|cooking)\b/i },
  // School / kids.
  { folder: 'school', pattern: /\b(school|homework|teacher|classroom|pta|parent[-\s]?teacher|field\s+trip|report\s+card|spelling)\b/i },
  // Health / appointments.
  { folder: 'health', pattern: /\b(doctor|dentist|pediatrician|appointment|prescription|pharmacy|refill|annual\s+(physical|checkup))\b/i },
  // Home maintenance.
  { folder: 'home', pattern: /\b(plumber|electrician|hvac|repair|fix\s+the|leak|filter|battery|smoke\s+detector)\b/i },
  // Bills / finance.
  { folder: 'bills', pattern: /\b(bill|invoice|tax(es)?|insurance|premium|due\s+by|payment|renewal)\b/i },
];

/**
 * Map an entity to a suggested folder name. Returns the folder name
 * (always lowercase one-word). If nothing matches, returns `null`
 * meaning "no opinion" — caller should bucket into `other`.
 *
 * Trips always map to the `trips` seed bucket.
 */
export function classifyEntity(entity: ClassifierEntity): string | null {
  if (entity.type === 'trip') return 'trips';

  const haystack = `${entity.primary} ${entity.secondary ?? ''}`;
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.folder;
  }
  return null;
}

/**
 * Default folder for an entity type when the classifier has no opinion.
 * Tasks → `tasks` (the seed), everything else → `other`. Lists are nuanced:
 * a "Costco list" should land in `shopping`, but a generic "Things to do"
 * list belongs in `lists`. The classifier handles the shopping case; this
 * fallback is only hit for the generic case.
 */
export function defaultFolderForType(type: EntityType): string {
  if (type === 'task') return 'tasks';
  if (type === 'list') return 'lists';
  if (type === 'trip') return 'trips';
  return 'other';
}
