/**
 * Server-side instrumentation for the load harness. Nothing here is imported
 * by the app: the load server (server.ts) wires it around the real Express app
 * and hands `kyselyLog` to `openDb`, so production code carries no tracing.
 *
 * Three views of where time goes:
 *   - per route: latency histogram, plus queries-per-request and DB time per
 *     request (an N+1 shows up as a high queries/request on a cheap route)
 *   - per SQL statement: count, total and max time, keyed by the statement text
 *   - process: event-loop delay, pool saturation, heap
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import type { NextFunction, Request, Response } from 'express';
import type { LogEvent } from 'kysely';
import type pg from 'pg';

interface ReqCtx {
  queries: number;
  dbMs: number;
  req: Request;
}

const als = new AsyncLocalStorage<ReqCtx>();

class Samples {
  values: number[] = [];
  total = 0;
  max = 0;
  add(v: number): void {
    this.total += v;
    if (v > this.max) this.max = v;
    if (this.values.length < 200_000) this.values.push(v);
  }
  summary() {
    const v = [...this.values].sort((a, b) => a - b);
    const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : 0);
    return {
      count: v.length,
      totalMs: round(this.total),
      avgMs: round(v.length ? this.total / v.length : 0),
      p50: round(q(0.5)),
      p95: round(q(0.95)),
      p99: round(q(0.99)),
      maxMs: round(this.max),
    };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

interface RouteStat {
  ms: Samples;
  queriesPerReq: Samples;
  dbMsPerReq: Samples;
  status: Record<string, number>;
}

let routes = new Map<string, RouteStat>();
let queries = new Map<string, { ms: Samples }>();
let errors = new Map<string, number>();
// route -> statement -> how many times it ran while serving that route
let routeSql = new Map<string, Map<string, { n: number; ms: number }>>();
let poolMax = { waiting: 0, total: 0, idle: 0 };
let heapMax = 0;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const pools: { name: string; pool: pg.Pool }[] = [];
export function watchPool(name: string, pool: pg.Pool): void {
  pools.push({ name, pool });
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').slice(0, 260);
}

/** Pass as `openDb({ log })`. */
export function kyselyLog(event: LogEvent): void {
  if (event.level === 'error') {
    const k = String((event.error as Error)?.message ?? event.error).slice(0, 160);
    errors.set(k, (errors.get(k) ?? 0) + 1);
    return;
  }
  const ms = event.queryDurationMillis;
  const key = normalizeSql(event.query.sql);
  let q = queries.get(key);
  if (!q) queries.set(key, (q = { ms: new Samples() }));
  q.ms.add(ms);
  const ctx = als.getStore();
  if (ctx) {
    ctx.queries += 1;
    ctx.dbMs += ms;
    // `req.route` is set once routing matches, so queries run by middleware
    // ahead of the matched handler (auth, membership) show up under the
    // route too, which is what "what does this request cost" means.
    const route = `${ctx.req.method} ${ctx.req.route?.path ?? '(pre-route)'}`;
    let per = routeSql.get(route);
    if (!per) routeSql.set(route, (per = new Map()));
    const e = per.get(key) ?? { n: 0, ms: 0 };
    e.n += 1;
    e.ms += ms;
    per.set(key, e);
  }
}

/** Mount first, before any body parsing, so it times the whole request. */
export function timingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const t0 = performance.now();
  const ctx: ReqCtx = { queries: 0, dbMs: 0, req };
  res.on('finish', () => {
    const route = `${req.method} ${req.route?.path ?? req.baseUrl + '(unmatched)'}`;
    let s = routes.get(route);
    if (!s) {
      routes.set(
        route,
        (s = { ms: new Samples(), queriesPerReq: new Samples(), dbMsPerReq: new Samples(), status: {} }),
      );
    }
    s.ms.add(performance.now() - t0);
    s.queriesPerReq.add(ctx.queries);
    s.dbMsPerReq.add(ctx.dbMs);
    const code = String(res.statusCode);
    s.status[code] = (s.status[code] ?? 0) + 1;
  });
  als.run(ctx, next);
}

let sampler: NodeJS.Timeout | undefined;
export function startSampler(): void {
  if (sampler) return;
  sampler = setInterval(() => {
    for (const { pool } of pools) {
      poolMax.waiting = Math.max(poolMax.waiting, pool.waitingCount);
      poolMax.total = Math.max(poolMax.total, pool.totalCount);
      poolMax.idle = Math.max(poolMax.idle, pool.idleCount);
    }
    heapMax = Math.max(heapMax, process.memoryUsage().heapUsed);
  }, 200);
  sampler.unref();
}

let cpuAtReset = process.cpuUsage();
let cpuResetAt = Date.now();

export function reset(): void {
  cpuAtReset = process.cpuUsage();
  cpuResetAt = Date.now();
  routes = new Map();
  queries = new Map();
  errors = new Map();
  routeSql = new Map();
  poolMax = { waiting: 0, total: 0, idle: 0 };
  heapMax = 0;
  loop.reset();
}

export function report(top = 40) {
  const routeRows = [...routes.entries()]
    .map(([route, s]) => ({
      route,
      ...s.ms.summary(),
      queriesPerReqAvg: round(s.queriesPerReq.summary().avgMs),
      queriesPerReqMax: s.queriesPerReq.summary().maxMs,
      dbMsPerReqAvg: round(s.dbMsPerReq.summary().avgMs),
      status: s.status,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const queryRows = [...queries.entries()]
    .map(([sql, q]) => ({ sql, ...q.ms.summary() }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, top);
  // Per matched route: its statements by count. Queries that ran before the
  // route matched are folded into a "(pre-route)" bucket per method.
  const routeCount = new Map(routeRows.map((r) => [r.route, r.count]));
  const sqlByRoute: Record<string, { sql: string; perReq: number; avgMs: number }[]> = {};
  for (const [route, per] of routeSql) {
    const n = routeCount.get(route) ?? 1;
    sqlByRoute[route] = [...per.entries()]
      .map(([sql, e]) => ({ sql, perReq: round(e.n / n), avgMs: round(e.ms / e.n) }))
      .sort((a, b) => b.perReq * b.avgMs - a.perReq * a.avgMs)
      .slice(0, 40);
  }
  return {
    sqlByRoute,
    routes: routeRows,
    queries: queryRows,
    queryTotals: {
      distinct: queries.size,
      count: [...queries.values()].reduce((n, q) => n + q.ms.values.length, 0),
      totalMs: round([...queries.values()].reduce((n, q) => n + q.ms.total, 0)),
    },
    queryErrors: Object.fromEntries(errors),
    eventLoopMs: {
      mean: round(loop.mean / 1e6),
      p50: round(loop.percentile(50) / 1e6),
      p99: round(loop.percentile(99) / 1e6),
      max: round(loop.max / 1e6),
    },
    pool: poolMax,
    // This (server) process's own CPU since the last reset, as average cores.
    serverCores: (() => {
      const u = process.cpuUsage(cpuAtReset);
      const secs = (Date.now() - cpuResetAt) / 1000;
      return secs > 0 ? Math.round(((u.user + u.system) / 1e6 / secs) * 100) / 100 : 0;
    })(),
    heapMaxMb: Math.round(heapMax / 1048576),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}
