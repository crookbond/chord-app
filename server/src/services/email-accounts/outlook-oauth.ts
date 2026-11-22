/**
 * Microsoft identity platform OAuth for Outlook.com + Microsoft 365 (ADR 0080).
 * One multi-tenant app via the /common endpoint; no SDK (mirrors the Google
 * oauth.service style). The refresh token ROTATES: Microsoft may issue a new
 * one on every refresh, so token acquisition reseals the rotated token onto
 * the account row.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { cachedAccessToken, type MintedAccessToken } from '../../utils/access-token-cache.js';
import {
  AccountAuthError,
  markAccountReconnect,
  openAuthBlob,
  sealAuthBlob,
  type AccountRow,
  type OutlookAuth,
} from './account-utils.js';

const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName';

/** Scopes the client requests at authorize time (shorthand = Graph resource).
 *  With calendars on (ADR 0228) it also asks for `Calendars.ReadWrite`. */
export const OUTLOOK_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];

interface MsTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function assertConfigured(): void {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
    throw new Error('Outlook OAuth not configured: set MS_CLIENT_ID and MS_CLIENT_SECRET');
  }
}

async function postToken(body: Record<string, string>): Promise<MsTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let parsed: MsTokenResponse;
  try {
    parsed = JSON.parse(text) as MsTokenResponse;
  } catch {
    throw new Error(`microsoft token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    // invalid_grant = dead/revoked refresh token or consumed code — the user
    // must re-attach. Everything else is treated as transient.
    const dead = parsed.error === 'invalid_grant';
    throw new AccountAuthError(
      `microsoft token endpoint ${res.status}: ${parsed.error ?? ''} ${parsed.error_description?.slice(0, 200) ?? ''}`,
      { needsReconnect: dead },
    );
  }
  return parsed;
}

export interface OutlookExchangeResult {
  refreshToken: string;
  emailAddress: string;
  displayName: string | null;
  grantedScopes: string;
  /** Present when `openid` was granted; the sign-in route reads it (ADR 0293). */
  idToken: string | null;
  /** The code came back to the apps' custom scheme (see `isPublicClientRedirect`). */
  publicClient: boolean;
}

/**
 * The apps return from Microsoft to `chord://oauthredirect`, registered in
 * Entra under "Mobile and desktop": a public client. Microsoft refuses a
 * client secret on its codes and refresh tokens (AADSTS90023), while the web
 * address (`https://…/oauthredirect`, "Web") must send one.
 */
export function isPublicClientRedirect(redirectUri: string): boolean {
  return !/^https?:\/\//i.test(redirectUri.trim());
}

/** Token request credentials: the secret only for the web client. */
function clientCredentials(publicClient: boolean): Record<string, string> {
  return publicClient
    ? { client_id: env.MS_CLIENT_ID }
    : { client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET };
}

/** The sealed blob for a Microsoft grant; the flag only when it is set. */
export function outlookAuthBlob(refreshToken: string, publicClient: boolean | undefined): OutlookAuth {
  return publicClient ? { refreshToken, publicClient: true } : { refreshToken };
}

/** Read the mailbox identity off Graph /me with a fresh access token. */
async function fetchProfile(accessToken: string): Promise<{ email: string; displayName: string | null }> {
  const res = await fetch(GRAPH_ME, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`graph /me ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const me = (await res.json()) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };
  const email = (me.mail ?? me.userPrincipalName ?? '').toLowerCase();
  if (!email) throw new Error('graph /me returned no mail address');
  return { email, displayName: me.displayName ?? null };
}

/** Exchange the client's PKCE authorization code for tokens + identity. */
export async function exchangeOutlookCode(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OutlookExchangeResult> {
  assertConfigured();
  const publicClient = isPublicClientRedirect(opts.redirectUri);
  const tokens = await postToken({
    ...clientCredentials(publicClient),
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  if (!tokens.access_token) throw new Error('microsoft response missing access_token');
  if (!tokens.refresh_token) {
    throw new Error('microsoft response missing refresh_token (offline_access not granted?)');
  }
  const profile = await fetchProfile(tokens.access_token);
  return {
    refreshToken: tokens.refresh_token,
    emailAddress: profile.email,
    displayName: profile.displayName,
    grantedScopes: tokens.scope ?? '',
    idToken: tokens.id_token ?? null,
    publicClient,
  };
}

/**
 * Mint a short-lived Graph access token from the account's stored refresh
 * token, resealing the rotated refresh token when Microsoft returns one.
 * Reused for up to 10 minutes (`utils/access-token-cache.ts`): every thread
 * open and every 5-minute sync used to pay a token round trip first.
 * A dead token marks the account status='reconnect' before throwing.
 */
export async function getOutlookAccessToken(db: Kysely<DB>, account: AccountRow): Promise<string> {
  assertConfigured();
  const auth = openAuthBlob<OutlookAuth>(account);
  return cachedAccessToken(`outlook:${account.id}`, auth.refreshToken, () =>
    mintOutlookAccessToken(db, account, auth),
  );
}

async function mintOutlookAccessToken(
  db: Kysely<DB>,
  account: AccountRow,
  auth: OutlookAuth,
): Promise<MintedAccessToken> {
  let tokens: MsTokenResponse;
  try {
    tokens = await postToken({
      ...clientCredentials(!!auth.publicClient),
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    });
  } catch (err) {
    if (err instanceof AccountAuthError && err.needsReconnect) {
      await markAccountReconnect(db, account.id);
    }
    throw err;
  }
  if (!tokens.access_token) throw new Error('microsoft refresh response missing access_token');
  if (tokens.refresh_token && tokens.refresh_token !== auth.refreshToken) {
    try {
      await db
        .updateTable('email_accounts')
        .set({
          ...sealAuthBlob(outlookAuthBlob(tokens.refresh_token, auth.publicClient)),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', account.id)
        .execute();
    } catch (err) {
      logger.warn('outlook rotated-token reseal failed', {
        accountId: account.id,
        err: (err as Error).message,
      });
    }
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    rotatedRefreshToken: tokens.refresh_token,
  };
}
