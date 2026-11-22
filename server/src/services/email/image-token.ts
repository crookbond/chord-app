/**
 * The capability that lets a rendered <img> reach our image proxy (ADR 0136).
 *
 * An image inside an email body cannot send the session header — that is the
 * whole reason this exists, and why attachments (which render through RN's
 * `<Image source={{headers}}>`) never needed it.
 *
 * So the URL authenticates itself, carrying a sealed `{u, exp}` rather than the
 * session token: a session credential in a query string ends up in every access
 * log on the way, whereas this is encrypted (the user id is not readable by
 * whoever holds the URL), expires on its own, and unlocks nothing but the
 * proxy.
 */
import { logger } from '../../config/logging.js';
import { openToken, sealToken } from '../../utils/crypto-tokens.js';

/** Long enough to read a mailbox without re-minting, short enough that a
 *  token copied out of a log is worthless by the time anyone reads it. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** `iv.tag.ciphertext`, base64url so it survives a query string untouched. */
function pack(iv: Buffer, tag: Buffer, ct: Buffer): string {
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function mintImageToken(userId: string, now = Date.now()): string {
  const { iv, tag, ciphertext } = sealToken(JSON.stringify({ u: userId, exp: now + TTL_MS }));
  return pack(iv, tag, ciphertext);
}

/**
 * The same, for the read path, where failing is not an option.
 *
 * `MASTER_KEY` is only asserted at boot when AUTH_MODE is google, so a
 * deployment without one reaches here — and being unable to show images must
 * not stop someone reading their mail. Returning null falls the reader back to
 * ADR 0120's blocking, which is a working mailbox.
 *
 * Logged at warn rather than swallowed: images silently never loading is
 * indistinguishable from a rendering bug from the outside.
 */
export function tryMintImageToken(userId: string): string | null {
  try {
    return mintImageToken(userId);
  } catch (err) {
    logger.warn('cannot mint an email image token — remote images stay blocked', { err });
    return null;
  }
}

/** The user this token was minted for, or null if it is malformed, tampered
 *  with, sealed under a different key, or expired. One null for every failure:
 *  the caller has the same response for all of them. */
export function readImageToken(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
    const payload = JSON.parse(openToken({ iv, tag, ciphertext })) as {
      u?: unknown;
      exp?: unknown;
    };
    if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= now) return null;
    return payload.u;
  } catch {
    return null;
  }
}
