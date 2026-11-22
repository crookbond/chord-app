/**
 * Scores email search against the labelled corpus: hit@1, hit@3 and MRR per
 * query class, plus how often a query's known wrong answers (another person,
 * a billing robot when Bill was asked for) stay out of the top five.
 */
import type { EmailEvalQuery, EmailQueryClass } from './email-corpus.js';

export interface EmailQueryResult {
  query: EmailEvalQuery;
  ranked: string[];
}

export interface EmailEvalScore {
  n: number;
  hit1: number;
  hit3: number;
  mrr: number;
  /** Share of queries with a `wrong` list whose top five contain none of it. */
  clean5: number;
}

function score(results: EmailQueryResult[]): EmailEvalScore {
  let hit1 = 0;
  let hit3 = 0;
  let rr = 0;
  let cleanN = 0;
  let clean = 0;
  for (const { query, ranked } of results) {
    const first = ranked.findIndex((k) => query.relevant.includes(k));
    if (first === 0) hit1++;
    if (first >= 0 && first < 3) hit3++;
    if (first >= 0) rr += 1 / (first + 1);
    if (query.wrong?.length) {
      cleanN++;
      if (!ranked.slice(0, 5).some((k) => query.wrong!.includes(k))) clean++;
    }
  }
  const n = results.length || 1;
  return { n: results.length, hit1: hit1 / n, hit3: hit3 / n, mrr: rr / n, clean5: cleanN ? clean / cleanN : 1 };
}

export function scoreEmailEval(results: EmailQueryResult[]): {
  overall: EmailEvalScore;
  byClass: Record<EmailQueryClass, EmailEvalScore>;
} {
  const classes: EmailQueryClass[] = ['person', 'keyword', 'paraphrase', 'context'];
  const byClass = Object.fromEntries(
    classes.map((c) => [c, score(results.filter((r) => r.query.cls === c))]),
  ) as Record<EmailQueryClass, EmailEvalScore>;
  return { overall: score(results), byClass };
}

export function formatEmailEval(s: ReturnType<typeof scoreEmailEval>, misses: EmailQueryResult[]): string {
  const row = (name: string, x: EmailEvalScore) =>
    `${name.padEnd(11)} n=${String(x.n).padStart(2)}  hit@1 ${x.hit1.toFixed(2)}  hit@3 ${x.hit3.toFixed(2)}  MRR ${x.mrr.toFixed(2)}  clean@5 ${x.clean5.toFixed(2)}`;
  const lines = [row('overall', s.overall), ...Object.entries(s.byClass).map(([k, v]) => row(k, v))];
  for (const m of misses) lines.push(`  miss: "${m.query.query}" -> [${m.ranked.slice(0, 5).join(', ')}]`);
  return lines.join('\n');
}
