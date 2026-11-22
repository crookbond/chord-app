/**
 * The token-sealing master key, kept behind Cloud KMS (ADR 0210).
 *
 * `MASTER_KEY` seals refresh tokens, IMAP app passwords, BYOK keys and connector credentials.
 * Left in `.env` it sits next to the database it protects. Here the same 32 bytes are stored
 * only WRAPPED by a KMS key (`MASTER_KEY_WRAPPED`), and the process unwraps them once at boot,
 * so a copy of `.env` no longer opens a single stored token. The key VALUE does not change, so
 * every blob already sealed under it stays readable.
 */
import { timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { assertCryptoReady, installMasterKey } from '../../utils/crypto-tokens.js';
import { GcpKmsKeyProvider, KeyProviderError, type KeyProvider } from './key-provider.js';

// MASTER_KEY* are read from process.env at use, not from `env` (parsed once at
// import), so tests can swap them (same rule as utils/crypto-tokens.ts).

/** The KMS key that wraps the master key. Defaults to the content key; a separate key can be named. */
export function masterKeyKmsName(): string {
  return process.env.MASTER_KEY_KMS_KEY || env.GCP_KMS_KEY_NAME || '';
}

/** Unwrap `MASTER_KEY_WRAPPED` and install it. Throws a message that says which setting is wrong. */
export async function unwrapMasterKey(provider?: KeyProvider): Promise<void> {
  const wrapped = process.env.MASTER_KEY_WRAPPED ?? '';
  if (!wrapped) throw new Error('MASTER_KEY_WRAPPED is not set');
  let p = provider;
  if (!p) {
    const name = masterKeyKmsName();
    if (!name) {
      throw new KeyProviderError('MASTER_KEY_WRAPPED needs MASTER_KEY_KMS_KEY (or GCP_KMS_KEY_NAME) to unwrap it');
    }
    p = new GcpKmsKeyProvider(name);
  }
  let key: Buffer;
  try {
    key = await p.unwrap(Buffer.from(wrapped, 'base64'));
  } catch (err) {
    throw new KeyProviderError(
      `could not unwrap MASTER_KEY_WRAPPED (wrong MASTER_KEY_KMS_KEY, wrong value, or the service account lost access to the key): ${(err as Error).message}`,
    );
  }
  installMasterKey(key);
}

/**
 * Startup step for every entrypoint, in place of the old synchronous check. Same rule as before
 * (only AUTH_MODE=google deployments need a key); it now also unwraps a KMS-held one.
 */
export async function bootCrypto(provider?: KeyProvider): Promise<void> {
  if (env.AUTH_MODE !== 'google') return;
  if (process.env.MASTER_KEY_WRAPPED) {
    await unwrapMasterKey(provider);
    logger.info('token master key unwrapped from Cloud KMS');
    return;
  }
  assertCryptoReady();
}

/** For the wrap CLI: wrap a plain master key and prove the result unwraps to the same bytes. */
export async function wrapMasterKey(plain: Buffer, provider: KeyProvider): Promise<string> {
  const wrapped = await provider.wrap(plain);
  const back = await provider.unwrap(wrapped);
  if (back.length !== plain.length || !timingSafeEqual(back, plain)) {
    throw new KeyProviderError('the wrapped key did not unwrap to the same bytes; not printing it');
  }
  return wrapped.toString('base64');
}
