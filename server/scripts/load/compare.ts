/**
 * Compare runs side by side at the same load level.
 *
 *   tsx scripts/load/compare.ts <think-ms> <run> [<run> ...]
 *
 * <run> is a directory name under logs-load/ (i1, i2, ...). Prints throughput
 * and the p95 / avg of the operations people feel, plus the server's queue
 * signals, so a change shows up as a row-to-row difference.
 */
import fs from 'node:fs';
import path from 'node:path';

const [think, ...runs] = process.argv.slice(2);
if (!think || runs.length === 0) throw new Error('usage: compare.ts <think-ms> <run> [<run> ...]');
const root = path.resolve(process.cwd(), '../logs-load');

const OPS = [
  'chat_msg',
  'sse_fanout',
  'task_add',
  'todo_item_add',
  'save_add',
  'event_add',
  'event_del',
  'hub_read',
  'calendar_view',
  'mail_sync',
  'mail_threads',
  'mail_tiles',
  'search',
  'bot_to_start',
  'bot_turn_total',
];

const loaded = runs.map((run) => {
  const dir = path.join(root, run);
  const f = fs.readdirSync(dir).find((x) => new RegExp(`^level-\\d+-think${think}\\.json$`).test(x));
  if (!f) return { run, r: null };
  return { run, r: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
});

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log('think', think, 'ms/user');
console.log('metric'.padEnd(24) + loaded.map((l) => pad(l.run, 18)).join(''));
const row = (label: string, get: (r: any) => string) =>
  console.log(label.padEnd(24) + loaded.map((l) => pad(l.r ? get(l.r) : '-', 18)).join(''));
row('ops/s achieved', (r) => String(r.achievedOpsPerSec));
for (const op of OPS) {
  row(`${op} p95/avg`, (r) => (r.client[op] ? `${r.client[op].p95}/${r.client[op].avg}` : '-'));
}
row('errors (all ops)', (r) => String(Object.values(r.client).reduce((n: number, s: any) => n + s.errors, 0)));
row('queries total', (r) => String(r.server.queryTotals.count));
row('db ms total', (r) => String(Math.round(r.server.queryTotals.totalMs)));
row('pool waiting max', (r) => String(r.server.pool.waiting));
row('event loop p99 ms', (r) => String(r.server.eventLoopMs.p99));
row('cores: server', (r) => String(r.server.serverCores ?? '-'));
row('cores: machine busy', (r) => String(r.cpu?.machineCoresBusy ?? '-'));
row('cores: postgres+other', (r) => String(r.cpu?.postgresAndOtherCores ?? '-'));
row('cores: driver', (r) => String(r.cpu?.driverCores ?? '-'));
row('rss MB', (r) => String(r.server.rssMb));
