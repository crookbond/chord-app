/**
 * ADR 0335 — Chord as the OAuth 2.1 authorization server for its MCP
 * connector. A client (Claude, ChatGPT, an MCP inspector) registers itself
 * (RFC 7591), sends the user's browser to /authorize, the user says yes on
 * Chord's own consent page, and the client spends the code at /token with its
 * PKCE verifier. The tokens act as that user and nobody else.
 *
 * Rules that are not obvious:
 *  - Only S256 PKCE. `plain` sends the secret it is meant to protect.
 *  - A redirect URI is matched exactly against what the client registered;
 *    an unknown client or redirect never gets a redirect (that is the open
 *    redirect the check exists to stop), only an error page.
 *  - Every secret is stored as `h_<sha256>` (ADR 0269). They are long and
 *    random, so a plain hash is enough.
 *  - A refresh token is single use. Presenting a spent one means two parties
 *    hold it, so the whole grant is revoked (OAuth 2.1 §4.3.1).
 *  - A code presented twice revokes what the first exchange issued.
 */
import { createHash } from 'node:crypto';

import { AI_APP_SCOPES, parseAiAppScope, type AiAppRequestView, type AiAppScope, type ConnectedAiApp } from '@chord/kernel';
import { API } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { nanoid } from 'nanoid';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { secretsEqual } from '../../utils/secret-compare.js';
import { hashSessionToken } from '../../utils/session-token.js';
import { webOrigin } from '../stripe.service.js';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Long enough for a new user to sign up and connect a mailbox before answering.
const REQUEST_TTL_MS = 30 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_NAME_LENGTH = 80;
const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

const hash = (secret: string) => hashSessionToken(secret);

/** The public origin the connector is reached on (`WEB_ORIGIN`). */
export function connectorOrigin(): string {
  return webOrigin();
}

/** Hosts (and their subdomains) whose web pages may call the MCP endpoint. */
const AI_APP_WEB_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'openai.com'];

/**
 * The MCP spec's DNS-rebinding rule: a request carrying an `Origin` the server
 * does not expect is refused. Claude's and ChatGPT's servers send none (they
 * call server to server), so no Origin is fine; a browser page must be Chord's
 * own, one of the AI apps' own sites, or a page on this machine (the MCP
 * Inspector and other local test tools). Everything else still needs a token,
 * so this only closes the browser-borne path.
 */
export function isAllowedMcpOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === new URL(connectorOrigin()).origin) return true;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  }
  if (url.protocol !== 'https:') return false;
  return AI_APP_WEB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** RFC 8707 resource identifier: the MCP endpoint's absolute URL. */
export function mcpResourceUrl(): string {
  return `${connectorOrigin()}${API.mcp}`;
}

/** Issuer identifier (RFC 8414): the bare origin. */
export function issuer(): string {
  return connectorOrigin();
}

export function authorizationServerMetadata(): Record<string, unknown> {
  const o = connectorOrigin();
  return {
    issuer: issuer(),
    authorization_endpoint: `${o}${API.oauthAuthorize}`,
    token_endpoint: `${o}${API.oauthToken}`,
    registration_endpoint: `${o}${API.oauthRegister}`,
    revocation_endpoint: `${o}${API.oauthRevoke}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...AI_APP_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/privacy`,
  };
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [...AI_APP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Chord',
    resource_documentation: `${connectorOrigin()}/privacy`,
  };
}

export function protectedResourceMetadataUrl(): string {
  return `${connectorOrigin()}/.well-known/oauth-protected-resource${API.mcp}`;
}

// ── Registration (RFC 7591) ──────────────────────────────────────────────

export type RegisterResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/**
 * https anywhere; http only on the machine itself (a desktop client's loopback
 * listener, RFC 8252 §7.3). No fragment, no other scheme.
 */
export function isAcceptableRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URI_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  }
  return false;
}

export async function registerClient(db: Kysely<DB>, body: unknown): Promise<RegisterResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris must list 1 to 10 URIs' };
  }
  if (!uris.every(isAcceptableRedirectUri)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'each redirect URI must be https, or http on localhost, with no fragment',
    };
  }
  const method = b.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
    return { ok: false, error: 'invalid_client_metadata', description: 'unsupported token_endpoint_auth_method' };
  }
  const grants = b.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) {
    return { ok: false, error: 'invalid_client_metadata', description: 'unsupported grant_types' };
  }
  const name = typeof b.client_name === 'string' && b.client_name.trim()
    ? b.client_name.trim().slice(0, MAX_NAME_LENGTH)
    : 'An AI app';
  const clientUri = typeof b.client_uri === 'string' && isAcceptableRedirectUri(b.client_uri) ? b.client_uri : null;

  const id = `ocl_${nanoid(24)}`;
  const secret = method === 'none' ? null : `chord_cs_${nanoid(40)}`;
  const now = new Date();
  await db
    .insertInto('oauth_clients')
    .values({
      id,
      secret_hash: secret ? hash(secret) : null,
      name,
      client_uri: clientUri,
      redirect_uris: JSON.stringify(uris),
      created_at: now.toISOString(),
    })
    .execute();
  return {
    ok: true,
    body: {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: name,
      ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  };
}

// ── /authorize ───────────────────────────────────────────────────────────

export type AuthorizeOutcome =
  /** Nothing trustworthy to redirect to: show this to the person. */
  | { kind: 'error_page'; message: string }
  /** The redirect URI is known good; the error goes back to the client. */
  | { kind: 'redirect'; url: string }
  /** Send the browser to the consent page for this request. */
  | { kind: 'consent'; requestId: string };

function withQuery(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const one = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function beginAuthorization(
  db: Kysely<DB>,
  query: Record<string, unknown>,
): Promise<AuthorizeOutcome> {
  const clientId = one(query.client_id);
  if (!clientId) return { kind: 'error_page', message: 'The app did not say who it is (no client_id).' };
  const client = await db.selectFrom('oauth_clients').selectAll().where('id', '=', clientId).executeTakeFirst();
  if (!client) return { kind: 'error_page', message: 'This app is not registered with Chord. Connect it again from the app.' };

  const registered = client.redirect_uris;
  const asked = one(query.redirect_uri);
  const redirectUri = asked ?? (registered.length === 1 ? registered[0] : null);
  if (!redirectUri || !registered.includes(redirectUri)) {
    return { kind: 'error_page', message: 'The app asked to return somewhere it did not register, so Chord stopped.' };
  }
  const state = one(query.state);
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    url: withQuery(redirectUri, { error, error_description: description, state, iss: issuer() }),
  });

  if (query.response_type !== 'code') return fail('unsupported_response_type', 'only response_type=code');
  const challenge = one(query.code_challenge);
  if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail('invalid_request', 'a PKCE code_challenge is required');
  }
  if (query.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const scopes = parseAiAppScope(one(query.scope));
  if (!scopes) return fail('invalid_scope', `scopes are: ${AI_APP_SCOPES.join(' ')}`);
  const resource = one(query.resource);
  if (resource && !sameResource(resource)) return fail('invalid_target', 'unknown resource');

  const id = `oar_${nanoid(24)}`;
  const now = Date.now();
  await db
    .insertInto('oauth_requests')
    .values({
      id,
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state,
      scope: scopes.join(' '),
      resource,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + REQUEST_TTL_MS).toISOString(),
      user_id: null,
      code_hash: null,
      code_expires_at: null,
      used_at: null,
    })
    .execute();
  return { kind: 'consent', requestId: id };
}

/** A trailing slash is the same resource; nothing else is. */
function sameResource(r: string): boolean {
  return r.replace(/\/$/, '') === mcpResourceUrl().replace(/\/$/, '');
}

/** The consent page's view of a request that is still waiting for an answer. */
export async function describeRequest(db: Kysely<DB>, id: string): Promise<AiAppRequestView | null> {
  const row = await db
    .selectFrom('oauth_requests')
    .innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_requests.client_id')
    .select([
      'oauth_requests.id',
      'oauth_requests.redirect_uri',
      'oauth_requests.scope',
      'oauth_requests.expires_at',
      'oauth_requests.user_id',
      'oauth_requests.used_at',
      'oauth_clients.name',
      'oauth_clients.client_uri',
    ])
    .where('oauth_requests.id', '=', id)
    .executeTakeFirst();
  if (!row || row.user_id || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  return {
    id: row.id,
    clientName: row.name,
    clientUri: row.client_uri,
    redirectHost: new URL(row.redirect_uri).host,
    scopes: parseAiAppScope(row.scope) ?? [],
  };
}

/**
 * The signed-in user answers. One answer per request: the update only lands on
 * a request nobody has answered, so a second tab (or a replayed POST) gets null.
 */
export async function decideRequest(
  db: Kysely<DB>,
  id: string,
  userId: string,
  allow: boolean,
): Promise<{ redirectTo: string } | null> {
  const nowIso = new Date().toISOString();
  const code = allow ? `chord_code_${nanoid(40)}` : null;
  const row = await db
    .updateTable('oauth_requests')
    .set({
      user_id: userId,
      code_hash: code ? hash(code) : null,
      code_expires_at: code ? new Date(Date.now() + CODE_TTL_MS).toISOString() : null,
      used_at: allow ? null : nowIso,
    })
    .where('id', '=', id)
    .where('user_id', 'is', null)
    .where('used_at', 'is', null)
    .where('expires_at', '>', nowIso)
    .returning(['redirect_uri', 'state'])
    .executeTakeFirst();
  if (!row) return null;
  if (!code) {
    return {
      redirectTo: withQuery(row.redirect_uri, {
        error: 'access_denied',
        error_description: 'The user did not allow it',
        state: row.state,
        iss: issuer(),
      }),
    };
  }
  return { redirectTo: withQuery(row.redirect_uri, { code, state: row.state, iss: issuer() }) };
}

// ── /token ───────────────────────────────────────────────────────────────

export interface ClientCredentials {
  clientId: string | null;
  clientSecret: string | null;
}

export type TokenOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 401; error: string; description: string };

const bad = (error: string, description: string, status: 400 | 401 = 400): TokenOutcome => ({
  ok: false,
  status,
  error,
  description,
});

async function authenticateClient(
  db: Kysely<DB>,
  creds: ClientCredentials,
): Promise<{ id: string; name: string } | TokenOutcome> {
  if (!creds.clientId) return bad('invalid_client', 'client_id is required', 401);
  const client = await db
    .selectFrom('oauth_clients')
    .select(['id', 'name', 'secret_hash'])
    .where('id', '=', creds.clientId)
    .executeTakeFirst();
  if (!client) return bad('invalid_client', 'unknown client', 401);
  if (client.secret_hash) {
    if (!creds.clientSecret || !secretsEqual(hash(creds.clientSecret), client.secret_hash)) {
      return bad('invalid_client', 'client authentication failed', 401);
    }
  }
  return { id: client.id, name: client.name };
}

function isOutcome(v: unknown): v is TokenOutcome {
  return !!v && typeof v === 'object' && 'ok' in v;
}

/** base64url(SHA-256(verifier)), the S256 transform (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export async function exchangeToken(
  db: Kysely<DB>,
  params: Record<string, unknown>,
  creds: ClientCredentials,
): Promise<TokenOutcome> {
  const client = await authenticateClient(db, creds);
  if (isOutcome(client)) return client;
  const grantType = params.grant_type;
  if (grantType === 'authorization_code') return exchangeCode(db, client, params);
  if (grantType === 'refresh_token') return refresh(db, client, params);
  return bad('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

async function exchangeCode(
  db: Kysely<DB>,
  client: { id: string },
  params: Record<string, unknown>,
): Promise<TokenOutcome> {
  const code = one(params.code);
  const verifier = one(params.code_verifier);
  if (!code) return bad('invalid_request', 'code is required');
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return bad('invalid_request', 'a valid code_verifier is required');
  }
  const row = await db.selectFrom('oauth_requests').selectAll().where('code_hash', '=', hash(code)).executeTakeFirst();
  if (!row || !row.user_id) return bad('invalid_grant', 'unknown code');
  if (row.client_id !== client.id) return bad('invalid_grant', 'code was issued to another client');
  if (row.used_at) {
    // Spent once already: whoever is presenting it now copied it. End what the
    // first exchange started.
    logger.warn('oauth code presented twice; revoking the grant', { clientId: client.id });
    await revokeClientGrants(db, row.user_id, client.id);
    return bad('invalid_grant', 'code already used');
  }
  if (!row.code_expires_at || Date.parse(row.code_expires_at) < Date.now()) return bad('invalid_grant', 'code expired');
  const redirectUri = one(params.redirect_uri);
  if (redirectUri !== row.redirect_uri) return bad('invalid_grant', 'redirect_uri does not match');
  if (!secretsEqual(s256(verifier), row.code_challenge)) return bad('invalid_grant', 'PKCE verification failed');
  const resource = one(params.resource);
  if (resource && !sameResource(resource)) return bad('invalid_target', 'unknown resource');

  const spent = await db
    .updateTable('oauth_requests')
    .set({ used_at: new Date().toISOString() })
    .where('id', '=', row.id)
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!spent) return bad('invalid_grant', 'code already used');

  const grantId = await upsertGrant(db, row.user_id, client.id, row.scope);
  return { ok: true, body: await issueTokens(db, grantId, row.scope) };
}

async function refresh(
  db: Kysely<DB>,
  client: { id: string },
  params: Record<string, unknown>,
): Promise<TokenOutcome> {
  const token = one(params.refresh_token);
  if (!token) return bad('invalid_request', 'refresh_token is required');
  const row = await db
    .selectFrom('oauth_tokens')
    .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
    .select([
      'oauth_tokens.token_hash',
      'oauth_tokens.expires_at',
      'oauth_tokens.rotated_at',
      'oauth_grants.id as grant_id',
      'oauth_grants.client_id',
      'oauth_grants.scope',
      'oauth_grants.revoked_at',
    ])
    .where('oauth_tokens.token_hash', '=', hash(token))
    .where('oauth_tokens.kind', '=', 'refresh')
    .executeTakeFirst();
  if (!row || row.revoked_at) return bad('invalid_grant', 'unknown refresh token');
  if (row.client_id !== client.id) return bad('invalid_grant', 'refresh token was issued to another client');
  if (row.rotated_at) {
    logger.warn('spent oauth refresh token presented; revoking the grant', { grantId: row.grant_id });
    await revokeGrantById(db, row.grant_id);
    return bad('invalid_grant', 'refresh token already used');
  }
  if (Date.parse(row.expires_at) < Date.now()) return bad('invalid_grant', 'refresh token expired');
  let scope = row.scope;
  const asked = one(params.scope);
  if (asked) {
    const want = parseAiAppScope(asked);
    const held = new Set(parseAiAppScope(row.scope) ?? []);
    if (!want || want.some((s) => !held.has(s))) return bad('invalid_scope', 'cannot widen scope on refresh');
    scope = want.join(' ');
  }
  const rotated = await db
    .updateTable('oauth_tokens')
    .set({ rotated_at: new Date().toISOString() })
    .where('token_hash', '=', row.token_hash)
    .where('rotated_at', 'is', null)
    .returning('token_hash')
    .executeTakeFirst();
  // Lost a race with another refresh of the same token: not proof of theft
  // (a client retrying), so refuse without revoking.
  if (!rotated) return bad('invalid_grant', 'refresh token already used');
  return { ok: true, body: await issueTokens(db, row.grant_id, scope) };
}

/** One grant per user and client; a new consent replaces the old scope. */
async function upsertGrant(db: Kysely<DB>, userId: string, clientId: string, scope: string): Promise<string> {
  const existing = await db
    .selectFrom('oauth_grants')
    .select('id')
    .where('user_id', '=', userId)
    .where('client_id', '=', clientId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (existing) {
    await db.updateTable('oauth_grants').set({ scope }).where('id', '=', existing.id).execute();
    return existing.id;
  }
  const id = `ogr_${nanoid(20)}`;
  await db
    .insertInto('oauth_grants')
    .values({ id, user_id: userId, client_id: clientId, scope, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null })
    .execute();
  return id;
}

async function issueTokens(db: Kysely<DB>, grantId: string, scope: string): Promise<Record<string, unknown>> {
  const access = `chord_at_${nanoid(40)}`;
  const refreshToken = `chord_rt_${nanoid(40)}`;
  const now = Date.now();
  await db
    .insertInto('oauth_tokens')
    .values([
      {
        token_hash: hash(access),
        grant_id: grantId,
        kind: 'access',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
        rotated_at: null,
      },
      {
        token_hash: hash(refreshToken),
        grant_id: grantId,
        kind: 'refresh',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
        rotated_at: null,
      },
    ])
    .execute();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope,
  };
}

// ── Revocation ───────────────────────────────────────────────────────────

/**
 * RFC 7009. Always "ok" to the caller (the RFC says an unknown token is not an
 * error). A refresh token ends the whole grant; an access token ends itself.
 */
export async function revokeTokenByValue(db: Kysely<DB>, token: string, creds: ClientCredentials): Promise<TokenOutcome | null> {
  const client = await authenticateClient(db, creds);
  if (isOutcome(client)) return client;
  const row = await db
    .selectFrom('oauth_tokens')
    .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
    .select(['oauth_tokens.token_hash', 'oauth_tokens.kind', 'oauth_grants.id as grant_id', 'oauth_grants.client_id'])
    .where('oauth_tokens.token_hash', '=', hash(token))
    .executeTakeFirst();
  if (!row || row.client_id !== client.id) return null;
  if (row.kind === 'refresh') await revokeGrantById(db, row.grant_id);
  else await db.deleteFrom('oauth_tokens').where('token_hash', '=', row.token_hash).execute();
  return null;
}

async function revokeGrantById(db: Kysely<DB>, grantId: string): Promise<void> {
  await db.updateTable('oauth_grants').set({ revoked_at: new Date().toISOString() }).where('id', '=', grantId).where('revoked_at', 'is', null).execute();
  await db.deleteFrom('oauth_tokens').where('grant_id', '=', grantId).execute();
}

async function revokeClientGrants(db: Kysely<DB>, userId: string, clientId: string): Promise<void> {
  const grants = await db
    .selectFrom('oauth_grants')
    .select('id')
    .where('user_id', '=', userId)
    .where('client_id', '=', clientId)
    .where('revoked_at', 'is', null)
    .execute();
  for (const g of grants) await revokeGrantById(db, g.id);
}

// ── The resource side: who is this bearer? ───────────────────────────────

export interface AiAppAuth {
  userId: string;
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: AiAppScope[];
}

export async function verifyAccessToken(db: Kysely<DB>, token: string): Promise<AiAppAuth | null> {
  const row = await db
    .selectFrom('oauth_tokens')
    .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
    .innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
    .select([
      'oauth_tokens.expires_at',
      'oauth_grants.id as grant_id',
      'oauth_grants.user_id',
      'oauth_grants.scope',
      'oauth_grants.revoked_at',
      'oauth_grants.last_used_at',
      'oauth_clients.id as client_id',
      'oauth_clients.name',
    ])
    .where('oauth_tokens.token_hash', '=', hash(token))
    .where('oauth_tokens.kind', '=', 'access')
    .executeTakeFirst();
  if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now()) return null;
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Date.now() - last > LAST_USED_REFRESH_MS) {
    db.updateTable('oauth_grants')
      .set({ last_used_at: new Date().toISOString() })
      .where('id', '=', row.grant_id)
      .execute()
      .catch((err) => logger.warn('failed to refresh oauth grant last_used_at', { err }));
  }
  return {
    userId: row.user_id,
    grantId: row.grant_id,
    clientId: row.client_id,
    clientName: row.name,
    scopes: parseAiAppScope(row.scope) ?? [],
  };
}

// ── The user's side: Settings and the bot ────────────────────────────────

export async function listConnectedApps(db: Kysely<DB>, userId: string): Promise<ConnectedAiApp[]> {
  const rows = await db
    .selectFrom('oauth_grants')
    .innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
    .select([
      'oauth_grants.id',
      'oauth_grants.scope',
      'oauth_grants.created_at',
      'oauth_grants.last_used_at',
      'oauth_clients.name',
      'oauth_clients.client_uri',
    ])
    .where('oauth_grants.user_id', '=', userId)
    .where('oauth_grants.revoked_at', 'is', null)
    .orderBy('oauth_grants.created_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    clientUri: r.client_uri,
    scopes: parseAiAppScope(r.scope) ?? [],
    connectedAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Disconnect one app. False when it is not this user's (or already gone). */
export async function disconnectApp(db: Kysely<DB>, userId: string, grantId: string): Promise<boolean> {
  const grant = await db
    .selectFrom('oauth_grants')
    .select('id')
    .where('id', '=', grantId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!grant) return false;
  await revokeGrantById(db, grant.id);
  return true;
}

/** Old requests and dead tokens, for the daily retention pass. */
export async function pruneOauthRows(db: Kysely<DB>): Promise<void> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  await db.deleteFrom('oauth_requests').where('expires_at', '<', dayAgo).execute();
  await db.deleteFrom('oauth_tokens').where('expires_at', '<', nowIso).execute();
}
