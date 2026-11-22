/**
 * Print the server-side half of one load level.
 *
 *   tsx scripts/load/show.ts <level.json|setup.json> [routes=22] [sql=25]
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: show.ts <file> [routes] [sql]');
const nRoutes = Number(process.argv[3] ?? 22);
const nSql = Number(process.argv[4] ?? 25);
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = r.server;

console.log(`routes by total time (${file}):`);
for (const x of s.routes.slice(0, nRoutes)) {
  console.log(
    x.route.slice(0, 44).padEnd(44),
    `n=${String(x.count).padStart(5)}`,
    `avg=${String(x.avgMs).padStart(7)}`,
    `p95=${String(x.p95).padStart(7)}`,
    `q/req=${String(x.queriesPerReqAvg).padStart(6)}`,
    `db/req=${String(x.dbMsPerReqAvg).padStart(6)}`,
  );
}
console.log('\nSQL by total time:');
for (const q of s.queries.slice(0, nSql)) {
  console.log(
    String(Math.round(q.totalMs)).padStart(8),
    `n=${String(q.count).padStart(6)}`,
    `avg=${String(q.avgMs).padStart(6)}`,
    `max=${String(q.maxMs).padStart(7)}`,
    q.sql.replace(/^\s+/, '').slice(0, 130),
  );
}
console.log('\ntotals:', JSON.stringify(s.queryTotals), 'errors:', JSON.stringify(s.queryErrors));
console.log('event loop ms:', JSON.stringify(s.eventLoopMs), 'pool:', JSON.stringify(s.pool), `rss ${s.rssMb}MB heap ${s.heapMaxMb}MB`);
console.log('google:', JSON.stringify(s.google));
