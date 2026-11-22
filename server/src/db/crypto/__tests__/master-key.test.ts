import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetCryptoCacheForTests, openToken, sealToken } from '../../../utils/crypto-tokens.js';
import { KeyProviderError, LocalKeyProvider } from '../key-provider.js';
import { unwrapMasterKey, wrapMasterKey } from '../master-key.js';

const SAVED = {
  plain: process.env.MASTER_KEY,
  wrapped: process.env.MASTER_KEY_WRAPPED,
  kms: process.env.MASTER_KEY_KMS_KEY,
};

function setEnv(plain: string | undefined, wrapped: string | undefined): void {
  if (plain === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = plain;
  if (wrapped === undefined) delete process.env.MASTER_KEY_WRAPPED;
  else process.env.MASTER_KEY_WRAPPED = wrapped;
  _resetCryptoCacheForTests();
}

describe('master key behind KMS', () => {
  // A local provider stands in for Cloud KMS: same wrap/unwrap contract.
  const kms = new LocalKeyProvider(randomBytes(32));

  beforeEach(() => setEnv(undefined, undefined));
  afterEach(() => {
    setEnv(SAVED.plain, SAVED.wrapped);
    if (SAVED.kms === undefined) delete process.env.MASTER_KEY_KMS_KEY;
    else process.env.MASTER_KEY_KMS_KEY = SAVED.kms;
  });

  it('opens a token sealed under the plain key once only the wrapped key is configured', async () => {
    // Production today: a token sealed under the plain MASTER_KEY.
    const master = randomBytes(32);
    setEnv(master.toString('base64'), undefined);
    const sealed = sealToken('1//0g-refresh-token-sealed-before-the-move');

    // After the move: the plain key is gone from the environment, only the wrapped one remains.
    const wrapped = await wrapMasterKey(master, kms);
    setEnv(undefined, wrapped);
    await unwrapMasterKey(kms);

    expect(openToken(sealed)).toBe('1//0g-refresh-token-sealed-before-the-move');
  });

  it('prefers the wrapped key over a plain one that is still present', async () => {
    const plainKey = randomBytes(32);
    const wrappedKey = randomBytes(32);
    setEnv(plainKey.toString('base64'), await wrapMasterKey(wrappedKey, kms));
    await unwrapMasterKey(kms);
    const sealed = sealToken('payload');

    // Reading it back with ONLY the wrapped key's value as a plain key proves which one sealed it.
    setEnv(wrappedKey.toString('base64'), undefined);
    expect(openToken(sealed)).toBe('payload');
    setEnv(plainKey.toString('base64'), undefined);
    expect(() => openToken(sealed)).toThrow();
  });

  it('refuses to seal under the plain key while a wrapped key is configured but not yet unwrapped', async () => {
    setEnv(randomBytes(32).toString('base64'), await wrapMasterKey(randomBytes(32), kms));
    expect(() => sealToken('x')).toThrow(/MASTER_KEY_WRAPPED is set but has not been unwrapped/);
  });

  it('fails at boot, naming the setting, when the wrapped value belongs to a different KMS key', async () => {
    const wrapped = await wrapMasterKey(randomBytes(32), kms);
    setEnv(undefined, wrapped);
    const other = new LocalKeyProvider(randomBytes(32));
    await expect(unwrapMasterKey(other)).rejects.toThrow(/could not unwrap MASTER_KEY_WRAPPED/);
  });

  it('fails at boot when the wrapped value is not a wrapped key at all', async () => {
    setEnv(undefined, Buffer.from('not a wrapped key, just some text').toString('base64'));
    await expect(unwrapMasterKey(kms)).rejects.toBeInstanceOf(KeyProviderError);
  });

  it('rejects a wrapped key that unwraps to the wrong length', async () => {
    setEnv(undefined, (await kms.wrap(randomBytes(16))).toString('base64'));
    await expect(unwrapMasterKey(kms)).rejects.toThrow(/must decode to 32 bytes/);
  });

  it('asks for the KMS key name when none is configured and no provider is injected', async () => {
    delete process.env.MASTER_KEY_KMS_KEY;
    setEnv(undefined, (await kms.wrap(randomBytes(32))).toString('base64'));
    await expect(unwrapMasterKey()).rejects.toThrow(/MASTER_KEY_KMS_KEY|GCP_KMS_KEY_NAME/);
  });

  it('does not print or return anything but ciphertext from the wrap step, and checks it round-trips', async () => {
    const master = randomBytes(32);
    const out = await wrapMasterKey(master, kms);
    expect(out).not.toContain(master.toString('base64'));
    expect(Buffer.from(out, 'base64').length).toBeGreaterThan(master.length);
    const broken = { id: 'x', wrap: (b: Buffer) => kms.wrap(b), unwrap: async () => randomBytes(32) };
    await expect(wrapMasterKey(master, broken)).rejects.toThrow(/did not unwrap to the same bytes/);
  });
});
