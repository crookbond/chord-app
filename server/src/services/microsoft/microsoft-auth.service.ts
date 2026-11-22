/**
 * Sign in with Microsoft (ADR 0293). The code is exchanged by the Outlook
 * mailbox exchange (`exchangeOutlookCode`), whose token response carries the
 * id_token read here. It arrived over TLS straight from Microsoft's token
 * endpoint in return for our single-use code, so its claims are checked, not
 * its signature (OIDC Core §3.1.3.7, the ADR 0156 reasoning).
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';

/** Personal Microsoft accounts (Outlook.com, Hotmail, Live) all sign in here. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Mailboxes Microsoft itself runs: for a personal account on one of these,
 *  the address IS the account, so it is proof of the mailbox. */
const MICROSOFT_CONSUMER_DOMAIN =
  /^(outlook|hotmail|live)\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$|^(msn|passport|windowslive)\.com$/;

/**
 * ADR 0293 addendum — carry the Microsoft login to the account a Google
 * connect re-pointed the session to, so the next Sign in with Microsoft lands
 * there. Only `users.microsoft_sub` moves: it is written by a real Microsoft
 * sign-in and nothing else, so an attached Outlook mailbox never travels as a
 * login. No-op when the source has none or the target already has one.
 */
export async function moveMicrosoftIdentityIn(
  trx: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<boolean> {
  const [from, to] = await Promise.all([
    trx.selectFrom('users').select('microsoft_sub').where('id', '=', fromUserId).executeTakeFirst(),
    trx.selectFrom('users').select('microsoft_sub').where('id', '=', toUserId).executeTakeFirst(),
  ]);
  if (!from?.microsoft_sub || !to || to.microsoft_sub) return false;
  // Clear first: microsoft_sub is unique.
  await trx.updateTable('users').set({ microsoft_sub: null }).where('id', '=', fromUserId).execute();
  await trx.updateTable('users').set({ microsoft_sub: from.microsoft_sub }).where('id', '=', toUserId).execute();
  return true;
}

export function microsoftSignInConfigured(): boolean {
  return (
    env.MICROSOFT_SIGN_IN_ENABLED &&
    env.AUTH_MODE === 'google' &&
    env.OUTLOOK_PROVIDER !== 'mock' &&
    !!env.MS_CLIENT_ID &&
    !!env.MS_CLIENT_SECRET
  );
}

export interface MicrosoftIdentity {
  /** `<tid>:<oid>` — the key stored in `users.microsoft_sub`. */
  sub: string;
  tenantId: string;
  email: string | null;
  /** True only when the email is proven to belong to this account. */
  emailProven: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
}

function claimString(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `xms_edov` comes as a boolean, or as "true"/"1" depending on the token. */
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function parseMicrosoftIdToken(idToken: string, nowMs: number = Date.now()): MicrosoftIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('microsoft id_token is not a JWT');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('microsoft id_token payload is not JSON');
  }
  const tid = claimString(claims, 'tid');
  const oid = claimString(claims, 'oid');
  if (!tid || !oid) throw new Error('microsoft id_token has no tid/oid');
  if (claims.aud !== env.MS_CLIENT_ID) throw new Error('microsoft id_token audience mismatch');
  if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
    throw new Error('microsoft id_token issuer mismatch');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < nowMs) {
    throw new Error('microsoft id_token expired');
  }

  const email = claimString(claims, 'email')?.toLowerCase() ?? null;
  const domain = email?.split('@')[1] ?? '';
  const emailProven =
    !!email &&
    (truthy(claims.xms_edov) || (tid === MICROSOFT_CONSUMER_TENANT && MICROSOFT_CONSUMER_DOMAIN.test(domain)));

  return {
    sub: `${tid}:${oid}`,
    tenantId: tid,
    email,
    emailProven,
    name: claimString(claims, 'name'),
    givenName: claimString(claims, 'given_name'),
    familyName: claimString(claims, 'family_name'),
  };
}
