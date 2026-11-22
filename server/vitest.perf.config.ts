import { defineConfig } from 'vitest/config';

import base from './vitest.config.ts';

// The timing tests (sealed against plaintext, sync throughput, key cache).
// They seed thousands of rows and compare latencies, so they need a database
// and a CPU that are not shared with 4 other workers: run in the parallel
// suite they measure the neighbours, not the code, and fail for that reason.
// Serial, one worker, and two retries: a real regression fails every attempt,
// a scheduling pause does not.
//
//   npm run test:perf --workspace=server
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/__tests__/**/*perf*.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    retry: 2,
    maxWorkers: 1,
  },
});
