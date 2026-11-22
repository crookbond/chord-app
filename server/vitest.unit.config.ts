import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// For tests that need no database: same aliases as the main config, but no
// globalSetup (which rebuilds the Postgres template, ~2 minutes) and no
// worker DB guard. Pass the files explicitly, since some `*.test.ts` files
// in the tree do use a database.
//
//   npx vitest run --config vitest.unit.config.ts src/db/crypto/__tests__/envelope.test.ts
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test', LLM_PROVIDER: 'mock', LOG_LEVEL: 'warn' },
  },
  resolve: {
    alias: {
      '@chord/kernel': path.resolve(HERE, '../kernel/src/index.ts'),
      '@chord/kernel/': path.resolve(HERE, '../kernel/src/') + '/',
      '@': path.resolve(HERE, 'src'),
    },
  },
});
