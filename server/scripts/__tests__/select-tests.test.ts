import { describe, expect, it } from 'vitest';

import { ALWAYS, selectTests } from '../ci/select-tests.mjs';

const ALL_TESTS = [
  ...ALWAYS,
  'src/services/email/__tests__/compose-reply.integration.test.ts',
  'src/services/email/__tests__/compose-reply-asked-day.integration.test.ts',
  'src/services/email/__tests__/thread-summary.integration.test.ts',
  'src/services/email/__tests__/composer.test.ts',
  'src/services/trips/__tests__/chain.test.ts',
  'src/__tests__/email-heading-style.test.ts',
  'scripts/__tests__/select-tests.test.ts',
];

describe('selectTests', () => {
  it('runs the tests named after a changed source file, plus the guards', () => {
    expect(selectTests(['server/src/services/email/compose-reply.service.ts'], ALL_TESTS)).toEqual(
      [
        ...ALWAYS,
        'src/services/email/__tests__/compose-reply-asked-day.integration.test.ts',
        'src/services/email/__tests__/compose-reply.integration.test.ts',
      ].sort(),
    );
  });

  it('does not take a test whose name only starts the same way', () => {
    const picked = selectTests(['server/src/services/email/compose-reply.service.ts'], ALL_TESTS);
    expect(picked).not.toContain('src/services/email/__tests__/composer.test.ts');
  });

  it('falls back to the tests next to a file that no test is named after', () => {
    const picked = selectTests(['server/src/services/trips/regroup.service.ts'], ALL_TESTS);
    expect(picked).toContain('src/services/trips/__tests__/chain.test.ts');
    expect(picked).not.toContain('src/services/email/__tests__/composer.test.ts');
  });

  it('finds a kernel file by the test named after it, wherever it lives', () => {
    expect(selectTests(['kernel/src/email-heading-style.ts'], ALL_TESTS)).toContain(
      'src/__tests__/email-heading-style.test.ts',
    );
  });

  it('runs a changed test itself', () => {
    expect(
      selectTests(['server/src/services/email/__tests__/composer.test.ts'], ALL_TESTS),
    ).toContain('src/services/email/__tests__/composer.test.ts');
  });

  it('runs only the guards for a mobile or docs change', () => {
    expect(selectTests(['mobile/app/email/index.tsx', 'docs/notes/x.md'], ALL_TESTS)).toEqual(
      [...ALWAYS].sort(),
    );
  });

  it('runs everything when something every test reads changes', () => {
    for (const p of [
      'package-lock.json',
      'server/package.json',
      'server/vitest.config.ts',
      'server/src/__test-helpers__/db.ts',
      'example.env',
      '.github/workflows/ci.yml',
    ]) {
      expect(selectTests([p], ALL_TESTS)).toBe('ALL');
    }
  });

  it('never picks a timing test', () => {
    const tests = [...ALL_TESTS, 'src/services/email/__tests__/compose-reply-perf.test.ts'];
    expect(selectTests(['server/src/services/email/compose-reply.service.ts'], tests)).not.toContain(
      'src/services/email/__tests__/compose-reply-perf.test.ts',
    );
  });
});
