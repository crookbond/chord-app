/** Types for test-shards.mjs (plain JS so CI can run it with bare node). */
export const TARGET_SECONDS_PER_SHARD: number;
export const DEFAULT_FILE_SECONDS: number;
export const FILE_OVERHEAD_SECONDS: number;
export function planShards(
  tests: string[],
  timings: Record<string, number>,
  opts: { maxShards: number; targetSeconds?: number },
): { shards: string[][]; seconds: number[] };
export function overlappingPaths(tests: string[]): [string, string][];
export function timingsFromReport(
  report: { testResults?: { name: string; startTime?: number; endTime?: number }[] },
  serverDir: string,
): Record<string, number>;
export function mergeTimings(
  old: Record<string, number>,
  fresh: Record<string, number>[],
  existing: string[],
): Record<string, number>;
