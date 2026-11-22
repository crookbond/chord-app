/**
 * Addresses a mailbox may send as (ADR 0130).
 *
 * Gmail only, and not as a limitation we impose: `settings.sendAs` is the only
 * place any of our providers will tell us which addresses are *verified*, and
 * verification is the whole point. Graph needs a SendAs permission we do not
 * hold and cannot enumerate; IMAP has no concept of an alias at all. Parity is
 * what a mailbox can do (ADR 0116), and these mailboxes cannot do this.
 *
 * Covered by `gmail.modify`, which we already hold - no new consent.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { getGmailApi } from '../google/gmail-api.js';

export interface SendAsAddress {
  email: string;
  displayName?: string;
  /** True for the mailbox's own address, which is always available. */
  isPrimary: boolean;
}

/**
 * Only VERIFIED addresses are offered.
 *
 * Gmail silently rewrites the From header to the authenticated address when an
 * alias is unverified: the message goes out, from the wrong address, and the
 * API reports success. Offering one would be promising something that does not
 * happen - the ADR 0102 failure with a return code of 200.
 */
function usable(v: {
  sendAsEmail: string;
  isPrimary?: boolean;
  verificationStatus?: string;
}): boolean {
  if (!v.sendAsEmail?.includes('@')) return false;
  // The primary address needs no verification: it IS the authenticated one.
  if (v.isPrimary) return true;
  return v.verificationStatus === 'accepted';
}

/**
 * What this user may put in a From header.
 *
 * A failure is not an error here: the compose screen still works with the
 * mailbox's own address, which is what it had before this existed.
 */
export async function listSendAsAddresses(
  db: Kysely<DB>,
  userId: string,
): Promise<SendAsAddress[]> {
  try {
    const api = await getGmailApi(db, userId);
    return (await api.listSendAs())
      .filter(usable)
      .map((v) => ({
        email: v.sendAsEmail.toLowerCase(),
        ...(v.displayName ? { displayName: v.displayName } : {}),
        isPrimary: v.isPrimary === true,
      }))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.email.localeCompare(b.email));
  } catch (err) {
    logger.info('sendAs unavailable', { userId, err: (err as Error).message });
    return [];
  }
}

/**
 * Is this address one the user may actually send from?
 *
 * Checked server-side on every send: the client picked from a list we gave it,
 * but the request is a client's, and a From header is exactly the field worth
 * being strict about.
 */
export async function assertSendAsAllowed(
  db: Kysely<DB>,
  userId: string,
  from: string | undefined,
): Promise<string | null> {
  if (!from) return null;
  const wanted = from.trim().toLowerCase();
  const allowed = await listSendAsAddresses(db, userId);
  return allowed.some((a) => a.email === wanted) ? wanted : null;
}
