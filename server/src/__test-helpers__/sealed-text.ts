/**
 * Strip the random parts of every sealed envelope (`enc1.<owner>.<ctx>.<payload>`,
 * ADR 0201) before a test searches stored text for leaked plaintext. Base64url
 * ciphertext and nanoid owner ids are random letters, so a short needle like
 * "IAD" or "UA" turns up inside them by chance and the test fails although
 * nothing leaked. The column label (`ctx`) is kept; anything outside an
 * envelope is left exactly as stored.
 */
const ENVELOPE = /enc1\.[A-Za-z0-9_-]+\.([^.\s"'|]+)\.[A-Za-z0-9_-]+/g;

export function withoutSealedPayloads(text: string): string {
  return text.replace(ENVELOPE, 'enc1.$1.…');
}
