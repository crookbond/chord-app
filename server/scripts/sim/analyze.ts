/**
 * Post-run analyzer for sim JSONL logs. Groups @Chord results by prompt
 * template and prints a per-prompt failure breakdown so it's obvious
 * which scenarios are unreliable. Usage:
 *
 *   tsx server/scripts/sim/analyze.ts logs/sim-<ts>.jsonl
 */
import { readFileSync } from 'node:fs';

interface ChordPrompt {
  ts: string;
  messageId: string;
  prompt: string;
  expectTool: string;
}
interface ChordResult {
  ts: string;
  messageId: string;
  ok: boolean;
  failures: Array<{ code: string; [k: string]: unknown }>;
  tools: Array<{ name: string; status: string; summary: string }>;
  cards: Array<{ kind: string; title: string; url?: string }>;
  durationMs: number | null;
  timedOut: boolean;
}

function loadJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx server/scripts/sim/analyze.ts <logfile>');
    process.exit(1);
  }
  const records = loadJsonl(path) as Array<{ kind: string; [k: string]: unknown }>;

  const prompts = new Map<string, ChordPrompt>();
  const results = new Map<string, ChordResult>();
  for (const r of records) {
    if (r.kind === 'sim.chord-prompt') {
      const p = r as unknown as ChordPrompt;
      prompts.set(p.messageId, p);
    } else if (r.kind === 'sim.chord-result') {
      const c = r as unknown as ChordResult;
      results.set(c.messageId, c);
    }
  }

  // Group by expectTool (= scenario template). For
  // `suggest_external_action` we further split by the URL host on the
  // resulting card so Find My / Maps / OpenTable / DoorDash show up as
  // separate buckets — they all share one tool name but represent
  // different routing decisions worth measuring independently.
  const byTool = new Map<
    string,
    {
      prompt: string;
      total: number;
      passed: number;
      /** Turns that fired ANY tool (not just the expected one). */
      anyToolFired: number;
      /** Turns that fired the expected tool. Independent of card/URL checks. */
      expectedToolFired: number;
      /** Turns that produced a card with a non-empty URL. */
      withCardUrl: number;
      failures: Map<string, number>;
      sampleFails: Array<{
        prompt: string;
        codes: string[];
        toolsGot: string[];
        cardsGot: string[];
      }>;
    }
  >();

  function classifyExternalAction(prompt: string, cards: ChordResult['cards']): string {
    const url = cards.find((c) => c.kind === 'action')?.url ?? '';
    if (/icloud\.com\/find/i.test(url)) return 'suggest_external_action[find_person]';
    if (/google\.com\/maps/i.test(url)) return 'suggest_external_action[map]';
    if (/opentable/i.test(url)) return 'suggest_external_action[restaurant]';
    if (/doordash/i.test(url)) return 'suggest_external_action[takeout]';
    if (/allrecipes/i.test(url)) return 'suggest_external_action[recipe]';
    if (/google\.com\/travel\/flights/i.test(url)) return 'suggest_external_action[flight]';
    if (/expedia|booking|hotels\.com/i.test(url)) return 'suggest_external_action[hotel]';
    if (/viator/i.test(url)) return 'suggest_external_action[activity]';
    // No card → fall back to bucketing by prompt phrasing.
    if (/where (is|'s)|find\s|locate\s|directions to|on the map/i.test(prompt)) {
      return 'suggest_external_action[where-is, no-card]';
    }
    return 'suggest_external_action[other]';
  }

  for (const [messageId, p] of prompts) {
    const r = results.get(messageId);
    if (!r) continue;
    const bucketKey =
      p.expectTool === 'suggest_external_action'
        ? classifyExternalAction(p.prompt, r.cards)
        : p.expectTool;
    let bucket = byTool.get(bucketKey);
    if (!bucket) {
      bucket = {
        prompt: p.prompt,
        total: 0,
        passed: 0,
        anyToolFired: 0,
        expectedToolFired: 0,
        withCardUrl: 0,
        failures: new Map(),
        sampleFails: [],
      };
      byTool.set(bucketKey, bucket);
    }
    bucket.total++;
    if (r.tools.length > 0) bucket.anyToolFired++;
    if (r.tools.some((t) => t.name === p.expectTool)) bucket.expectedToolFired++;
    if (r.cards.some((c) => !!c.url)) bucket.withCardUrl++;
    if (r.ok) {
      bucket.passed++;
    } else {
      // missing-card is a derived failure when no tool fired — drop it
      // so we don't double-count the same root cause.
      let codes = r.failures.map((f) => f.code);
      if (codes.includes('no-tool-call') && codes.includes('missing-card')) {
        codes = codes.filter((c) => c !== 'missing-card');
      }
      for (const code of codes) {
        bucket.failures.set(code, (bucket.failures.get(code) ?? 0) + 1);
      }
      if (bucket.sampleFails.length < 3) {
        bucket.sampleFails.push({
          prompt: p.prompt,
          codes,
          toolsGot: r.tools.map((t) => t.name),
          cardsGot: r.cards.map((c) => `${c.kind}${c.url ? `(${c.url.slice(0, 40)}…)` : ''}`),
        });
      }
    }
  }

  console.log(`\nAnalyzed ${prompts.size} prompts → ${results.size} results from ${path}\n`);
  const rows = [...byTool.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  );
  for (const [tool, b] of rows) {
    const pct = b.total ? Math.round((100 * b.passed) / b.total) : 0;
    const toolPct = b.total ? Math.round((100 * b.expectedToolFired) / b.total) : 0;
    const cardPct = b.total ? Math.round((100 * b.withCardUrl) / b.total) : 0;
    const fails = [...b.failures.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(
      `▸ ${tool}: ${b.passed}/${b.total} pass (${pct}%) · ${b.expectedToolFired}/${b.total} fired-expected (${toolPct}%) · ${b.withCardUrl}/${b.total} had-card-url (${cardPct}%)`,
    );
    if (fails) console.log(`    failures: ${fails}`);
    for (const s of b.sampleFails) {
      console.log(
        `    ✗ "${s.prompt.slice(0, 70)}" → tools=[${s.toolsGot.join(',')}] cards=[${s.cardsGot.join(',')}] codes=${s.codes.join(',')}`,
      );
    }
  }

  // Cross-cutting: which non-expected tools got picked instead?
  const wrongToolRoutes = new Map<string, number>();
  for (const [messageId, p] of prompts) {
    const r = results.get(messageId);
    if (!r) continue;
    const wrong = r.failures.find((f) => f.code === 'wrong-tool');
    if (!wrong) continue;
    const got = (wrong as { got?: string[] }).got ?? [];
    for (const g of got) {
      if (g === p.expectTool) continue;
      const key = `${p.expectTool} → ${g}`;
      wrongToolRoutes.set(key, (wrongToolRoutes.get(key) ?? 0) + 1);
    }
  }
  if (wrongToolRoutes.size > 0) {
    console.log('\nWrong-tool routes (expected → actual):');
    for (const [k, v] of [...wrongToolRoutes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
  }

  // ── Setup scenarios (form-fill, screenshot) ──────────────────────
  // These ride on the same SSE turn capture but log under different
  // event kinds, so the per-tool grouping above misses them.
  const setupPrompts = new Map<
    string,
    { ts: string; messageId: string; scenarioId: string; prompt: string; expectTool: string }
  >();
  const setupResults = new Map<
    string,
    { ts: string; messageId: string; scenarioId: string; ok: boolean; failures: Array<{ code: string }>; tools: Array<{ name: string }> }
  >();
  const postChecks: Array<{ scenarioId: string; ok: boolean; skipped?: boolean; reason?: string }> = [];
  for (const r of records) {
    if (r.kind === 'sim.setup-prompt') {
      const p = r as unknown as {
        messageId: string;
        scenarioId: string;
        prompt: string;
        expectTool: string;
        ts: string;
      };
      setupPrompts.set(p.messageId, p);
    } else if (r.kind === 'sim.setup-result') {
      const c = r as unknown as {
        messageId: string;
        scenarioId: string;
        ok: boolean;
        failures: Array<{ code: string }>;
        tools: Array<{ name: string }>;
        ts: string;
      };
      setupResults.set(c.messageId, c);
    } else if (r.kind === 'sim.setup-postcheck') {
      const pc = r as unknown as {
        scenarioId: string;
        ok: boolean;
        skipped?: boolean;
        reason?: string;
      };
      postChecks.push(pc);
    }
  }

  if (setupPrompts.size > 0 || postChecks.length > 0) {
    console.log('\n── Setup scenarios (form-fill, screenshot) ──');
    const byScenario = new Map<
      string,
      { total: number; passed: number; failures: Map<string, number> }
    >();
    for (const [mid, p] of setupPrompts) {
      const r = setupResults.get(mid);
      if (!r) continue;
      let bucket = byScenario.get(p.scenarioId);
      if (!bucket) {
        bucket = { total: 0, passed: 0, failures: new Map() };
        byScenario.set(p.scenarioId, bucket);
      }
      bucket.total++;
      if (r.ok) bucket.passed++;
      else {
        for (const f of r.failures) {
          const code = f.code;
          bucket.failures.set(code, (bucket.failures.get(code) ?? 0) + 1);
        }
      }
    }
    for (const [scenarioId, b] of byScenario) {
      const pct = b.total ? Math.round((100 * b.passed) / b.total) : 0;
      const fails = [...b.failures.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`▸ ${scenarioId}: ${b.passed}/${b.total} (${pct}%)`);
      if (fails) console.log(`    failures: ${fails}`);
    }
    if (postChecks.length > 0) {
      const byPost = new Map<
        string,
        { total: number; passed: number; failed: number; skipped: number }
      >();
      for (const pc of postChecks) {
        let bucket = byPost.get(pc.scenarioId);
        if (!bucket) {
          bucket = { total: 0, passed: 0, failed: 0, skipped: 0 };
          byPost.set(pc.scenarioId, bucket);
        }
        bucket.total++;
        if (pc.skipped) bucket.skipped++;
        else if (pc.ok) bucket.passed++;
        else bucket.failed++;
      }
      console.log('\n  postChecks:');
      for (const [scenarioId, b] of byPost) {
        const evaluated = b.total - b.skipped;
        const pct = evaluated ? Math.round((100 * b.passed) / evaluated) : 0;
        const skippedTail = b.skipped > 0 ? `, ${b.skipped} skipped` : '';
        // pass% is computed against EVALUATED runs only (skipped ones are
        // N/A — counting them as denominator would understate the score).
        console.log(
          `  ▸ ${scenarioId}: ${b.passed} ok, ${b.failed} failed${skippedTail} — ${pct}% of evaluated (n=${b.total})`,
        );
      }
    }
  }
}

main();
