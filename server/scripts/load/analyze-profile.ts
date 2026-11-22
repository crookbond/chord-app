/**
 * Summarise a V8 .cpuprofile: where the server's CPU went.
 *
 *   tsx scripts/load/analyze-profile.ts ../logs-load/i1/server.cpuprofile [topN]
 *
 * Self time by function, by source file, and by package — plus inclusive time
 * for app code, which is what says "this service is slow" rather than "this
 * library function is hot".
 */
import fs from 'node:fs';

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

const file = process.argv[2];
const topN = Number(process.argv[3] ?? 25);
if (!file) throw new Error('usage: analyze-profile.ts <file> [topN]');
const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;

const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) {
  self.set(p.samples[i]!, (self.get(p.samples[i]!) ?? 0) + (p.timeDeltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const ms = (us: number) => (us / 1000).toFixed(0);
const pct = (us: number) => ((us / total) * 100).toFixed(1) + '%';

const label = (n: Node) => {
  const u = n.callFrame.url
    .replace(/^file:\/\/\/.*?\/server\//, '')
    .replace(/^.*node_modules\//, 'node_modules/');
  return `${n.callFrame.functionName || '(anon)'}  ${u}:${n.callFrame.lineNumber + 1}`;
};
const fileOf = (n: Node) => {
  const u = n.callFrame.url;
  if (!u) return `(${n.callFrame.functionName || 'native'})`;
  if (u.startsWith('node:')) return 'node internals';
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(u);
  if (nm) return `pkg:${nm[1]}`;
  return u.replace(/^file:\/\/\/.*?\/server\//, '');
};

function table(title: string, rows: [string, number][]) {
  console.log(`\n== ${title} ==`);
  for (const [k, v] of rows.slice(0, topN)) console.log(`${ms(v).padStart(8)} ms ${pct(v).padStart(6)}  ${k}`);
}

const idle = [...self.entries()].filter(([id]) => byId.get(id)!.callFrame.functionName === '(idle)').reduce((a, [, v]) => a + v, 0);
console.log(`profile ${((p.endTime - p.startTime) / 1e6).toFixed(1)}s wall, ${ms(total)} ms sampled, idle ${pct(idle)}`);

const fn = new Map<string, number>();
const files = new Map<string, number>();
for (const [id, t] of self) {
  const n = byId.get(id)!;
  if (n.callFrame.functionName === '(idle)') continue;
  fn.set(label(n), (fn.get(label(n)) ?? 0) + t);
  files.set(fileOf(n), (files.get(fileOf(n)) ?? 0) + t);
}
table('self time by function', [...fn.entries()].sort((a, b) => b[1] - a[1]));
table('self time by file / package', [...files.entries()].sort((a, b) => b[1] - a[1]));

// Inclusive time for app code: a sample counts once for every distinct app
// function on its stack.
const incl = new Map<string, number>();
for (const [id, t] of self) {
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const n = byId.get(cur)!;
    if (!n.callFrame.url.includes('/src/') || n.callFrame.url.includes('node_modules')) continue;
    const k = label(n);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + t);
  }
}
table('inclusive time, app functions', [...incl.entries()].sort((a, b) => b[1] - a[1]));
