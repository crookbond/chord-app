/** What the timezone helpers cost per call. tsx scripts/load/bench-tz.ts */
import { performance } from 'node:perf_hooks';

import { svWall, tzToOffset } from '../../src/utils/tz.js';

const d = new Date();
const N = 100_000;
const time = (label: string, fn: () => void) => {
  const t = performance.now();
  for (let i = 0; i < N; i++) fn();
  console.log(`${label.padEnd(34)} ${(((performance.now() - t) / N) * 1000).toFixed(2)} us/call`);
};
time("toLocaleString('sv-SE', {timeZone})", () => d.toLocaleString('sv-SE', { timeZone: 'America/New_York' }));
time('svWall (cached formatter)', () => svWall(d, 'America/New_York'));
time('tzToOffset (uses svWall twice)', () => tzToOffset('America/New_York'));
