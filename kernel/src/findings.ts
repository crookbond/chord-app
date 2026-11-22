/**
 * The questions the Findings tab offers (ADR 0249). Each one is sent to the
 * personal chat as if typed, where the ADR 0246 recipes answer it, so a
 * question here is only worth listing if a recipe covers it. Nothing that
 * needs the user's whole financial history: Chord sees only receipts that
 * came by email.
 */

const GENERAL = [
  'What am I paying for every month?',
  'Which mailing lists am I on?',
  'Who emails me the most?',
  'Who needs a reply?',
];

/** Shops the questions may name: the most frequent, cleanly spelled ones. */
const MAX_SHOPS = 3;

/**
 * General questions, then one about each of the user's top shops. `shops` is
 * most-frequent first; a name that would read badly inside a question (too
 * long, or not a name at all) is skipped.
 */
export function findingsQuestions(shops: string[]): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const raw of shops) {
    const name = raw.trim().replace(/\s+/g, ' ');
    const key = name.toLowerCase();
    if (!name || name.length > 30 || !/\p{L}/u.test(name) || key === 'unknown' || seen.has(key)) continue;
    seen.add(key);
    picked.push(name);
    if (picked.length >= MAX_SHOPS) break;
  }
  return [...GENERAL, ...picked.map((s) => `How many orders from ${s} last month?`)];
}

/** Shop names from receipts, most frequent first. */
export function topShops(receipts: Array<{ merchant: string }>): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of receipts) {
    const key = r.merchant.trim().toLowerCase();
    if (!key) continue;
    const held = counts.get(key);
    if (held) held.n += 1;
    else counts.set(key, { name: r.merchant.trim(), n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.name);
}
