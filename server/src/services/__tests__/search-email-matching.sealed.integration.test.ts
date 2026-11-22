/**
 * The email matching scenarios again, against mail that was written through the
 * real sync path with content encryption ON and the legacy plaintext index OFF.
 * Every expectation is the one the plaintext run holds, so a difference here is
 * the blind index changing what search finds.
 */
import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import { defineEmailMatchingSuite } from '@/__test-helpers__/email-matching-suite.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';
import { afterEach } from 'vitest';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const original = env.CONTENT_LEGACY_TSV;
afterEach(() => {
  legacy.CONTENT_LEGACY_TSV = original;
});

defineEmailMatchingSuite({
  setup() {
    setContentEncryption(true);
    legacy.CONTENT_LEGACY_TSV = false;
  },
  seed: seedSyncedMail,
});
