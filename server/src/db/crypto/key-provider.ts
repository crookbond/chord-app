/**
 * Key-encryption-key providers (ADR 0201).
 *
 * A provider does exactly one thing: wrap and unwrap a 32-byte data key. The
 * data keys themselves are per owner and live (wrapped) in `content_keys`;
 * the provider is where the key that protects them lives. `local` keeps that
 * key in process configuration, which is right for dev/tests and a stopgap
 * otherwise. `gcp-kms` keeps it in Cloud KMS, so a person with database or
 * shell access cannot unwrap anything: only the service account can, and
 * every unwrap is in the KMS audit log.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyProvider {
  /** Recorded next to each wrapped key so a mixed fleet can be told apart. */
  readonly id: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

export class KeyProviderError extends Error {}

/** AES-256-GCM under a configured 32-byte key. Wire form: iv | ct | tag. */
export class LocalKeyProvider implements KeyProvider {
  readonly id = 'local';
  private readonly kek: Buffer;

  constructor(kek: Buffer) {
    if (kek.length !== 32) {
      throw new KeyProviderError(`CONTENT_KEK must decode to 32 bytes; got ${kek.length}`);
    }
    this.kek = kek;
  }

  static fromBase64(b64: string): LocalKeyProvider {
    return new LocalKeyProvider(Buffer.from(b64, 'base64'));
  }

  wrap(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Promise.resolve(Buffer.concat([iv, ct, cipher.getAuthTag()]));
  }

  unwrap(wrapped: Buffer): Promise<Buffer> {
    if (wrapped.length < IV_BYTES + TAG_BYTES + 1) {
      return Promise.reject(new KeyProviderError('wrapped key is too short'));
    }
    try {
      const iv = wrapped.subarray(0, IV_BYTES);
      const tag = wrapped.subarray(wrapped.length - TAG_BYTES);
      const ct = wrapped.subarray(IV_BYTES, wrapped.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(ct), decipher.final()]));
    } catch {
      return Promise.reject(new KeyProviderError('could not unwrap data key (wrong CONTENT_KEK?)'));
    }
  }
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Cloud KMS over REST, authenticated as the VM's service account through the
 * metadata server. No SDK: two calls, and the SDK would pull in a gRPC stack
 * for them. The key name is bound as additional authenticated data so a
 * wrapped key cannot be replayed against a different key.
 */
export class GcpKmsKeyProvider implements KeyProvider {
  readonly id = 'gcp-kms';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly keyName: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {
    if (!keyName) throw new KeyProviderError('GCP_KMS_KEY_NAME is required for gcp-kms');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const res = await this.fetchImpl(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!res.ok) throw new KeyProviderError(`metadata token request failed (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new KeyProviderError('metadata token response had no access_token');
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 300) * 1000,
    };
    return this.token.value;
  }

  private async call(op: 'encrypt' | 'decrypt', payload: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        additionalAuthenticatedData: Buffer.from(this.keyName).toString('base64'),
      }),
    });
    if (!res.ok) {
      // The body can carry key names and error detail; the status is enough
      // to act on, and the KMS audit log has the rest.
      throw new KeyProviderError(`Cloud KMS ${op} failed (${res.status})`);
    }
    return (await res.json()) as Record<string, string>;
  }

  async wrap(dek: Buffer): Promise<Buffer> {
    const out = await this.call('encrypt', { plaintext: dek.toString('base64') });
    if (!out.ciphertext) throw new KeyProviderError('Cloud KMS encrypt returned no ciphertext');
    return Buffer.from(out.ciphertext, 'base64');
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const out = await this.call('decrypt', { ciphertext: wrapped.toString('base64') });
    if (!out.plaintext) throw new KeyProviderError('Cloud KMS decrypt returned no plaintext');
    return Buffer.from(out.plaintext, 'base64');
  }
}

export interface ProviderConfig {
  provider: string;
  kek: string;
  gcpKeyName: string;
  nodeEnv: string;
}

/** Choose a provider from configuration. Unknown values are an error, never a silent fallback. */
export function providerFromConfig(cfg: ProviderConfig): KeyProvider {
  if (cfg.provider === 'gcp-kms') return new GcpKmsKeyProvider(cfg.gcpKeyName);
  if (cfg.provider !== 'local') {
    throw new KeyProviderError(`CONTENT_KEY_PROVIDER must be "local" or "gcp-kms"; got "${cfg.provider}"`);
  }
  if (cfg.kek) return LocalKeyProvider.fromBase64(cfg.kek);
  if (cfg.nodeEnv === 'production') {
    throw new KeyProviderError('CONTENT_KEK is required for the local key provider in production');
  }
  // Dev and tests: a fixed key so data written in one process reads in another.
  // It protects nothing, and production refuses to start on it.
  return new LocalKeyProvider(Buffer.alloc(32, 7));
}
