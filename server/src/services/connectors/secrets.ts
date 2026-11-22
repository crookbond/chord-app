/**
 * Connector-token encryption (ADR 0025). Thin wrapper around the
 * existing AES-256-GCM helper used for Google refresh tokens, so we
 * have one place to swap key derivation if MASTER_KEY usage ever
 * diverges.
 */
import { sealToken, openToken, type SealedToken } from '../../utils/crypto-tokens';

export type EncryptedConnectorToken = SealedToken;

export function sealConnectorToken(plaintext: string): EncryptedConnectorToken {
  return sealToken(plaintext);
}

export function openConnectorToken(sealed: EncryptedConnectorToken): string {
  return openToken(sealed);
}
