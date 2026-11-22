/**
 * ADR 0235 — connect the user's own OpenRouter account as their AI key.
 *
 * OpenRouter's OAuth (PKCE) flow hands an app a key the USER owns and can
 * revoke, so nobody pastes anything: the app sends them to openrouter.ai to
 * sign in, add credit and approve, OpenRouter redirects to our callback with a
 * one-time `code`, and the server swaps it for the key and stores it exactly as
 * a pasted key would be stored (`saveModelKey` — checked, then sealed).
 *
 * The exchange is server-side on purpose: the key never passes through the
 * app, and the PKCE verifier never leaves the server. The callback is a plain
 * browser redirect with no session, so the pending connection is found by an
 * unguessable single-use `state` that was bound to the user when they started
 * (10 minutes, like the code itself). Where the browser goes afterwards is
 * decided here from the platform they started on, never taken from the
 * request, so the callback cannot be used as an open redirect.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';

import { API, type MeSettings } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { saveModelKey } from './model-key.service.js';
import { webOrigin } from './stripe.service.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const AUTH_PAGE = 'https://openrouter.ai/auth';
const KEYS_API = 'https://openrouter.ai/api/v1/auth/keys';
const TTL_MS = 10 * 60_000;

/** The app's own URL scheme (mobile/app.json) — what an in-app browser session
 *  opened with `openAuthSessionAsync` closes on. */
const NATIVE_RETURN_BASE = 'chord://settings';

type FetchFn = typeof fetch;
type SystemLlm = MeSettings['systemLlm'];

export type ConnectPlatform = 'web' | 'native';

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * Which OpenRouter model a new connection starts on: whatever the user typed,
 * else the model the app itself runs on today, spelled the way OpenRouter
 * spells it (`vendor/model`, dotted versions) — "the same as the app unless
 * they edit it". A system default on some other compatible endpoint has slugs
 * that mean nothing here, so that falls back to `OPENROUTER_DEFAULT_MODEL`.
 */
export function openRouterModelFor(system: SystemLlm, typed?: string): string {
  const own = typed?.trim();
  if (own) return own;
  const fallback = env.OPENROUTER_DEFAULT_MODEL;
  if (!system || system.provider === 'mock') return fallback;
  if (system.baseUrl) return system.baseUrl.includes('openrouter.ai') ? system.model : fallback;
  switch (system.provider) {
    case 'openai':
      return `openai/${system.model}`;
    case 'gemini':
      return `google/${system.model}`;
    case 'anthropic':
      // Anthropic's API says claude-sonnet-4-6; OpenRouter says claude-sonnet-4.6.
      return `anthropic/${system.model.replace(/-(\d)-(\d)(?=-|$)/, '-$1.$2')}`;
    default:
      return fallback;
  }
}

export type StartResult = { ok: true; url: string; model: string } | { ok: false; reason: 'unavailable' };

export async function startOpenRouterConnect(
  db: Kysely<DB>,
  userId: string,
  input: { platform: ConnectPlatform; model?: string },
  system: SystemLlm,
): Promise<StartResult> {
  // No public origin = nowhere for OpenRouter to send the browser back to.
  const origin = webOrigin();
  if (!origin) return { ok: false, reason: 'unavailable' };

  const model = openRouterModelFor(system, input.model);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  // Stale rows and this user's earlier, never-finished attempts go first, so
  // the table holds at most one open attempt per person.
  await db
    .deleteFrom('openrouter_connects')
    .where((eb) =>
      eb.or([
        eb('created_at', '<', new Date(Date.now() - TTL_MS).toISOString()),
        eb('user_id', '=', userId),
      ]),
    )
    .execute();
  await db
    .insertInto('openrouter_connects')
    .values({
      state,
      user_id: userId,
      code_verifier: verifier,
      model,
      platform: input.platform,
      created_at: new Date().toISOString(),
    })
    .execute();

  const url = new URL(AUTH_PAGE);
  url.searchParams.set('callback_url', `${origin}${API.openRouterCallback(state)}`);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { ok: true, url: url.toString(), model };
}

export type ConnectStatus = 'ok' | 'needs_credit' | 'error';

export type ConnectOutcome =
  | { found: false }
  | { found: true; returnTo: string; status: ConnectStatus; message?: string };

function returnUrl(platform: string, status: ConnectStatus, message?: string): string {
  const base = platform === 'native' ? NATIVE_RETURN_BASE : `${webOrigin()}/settings`;
  const u = new URL(base);
  u.searchParams.set('byok', status);
  if (message) u.searchParams.set('message', message.slice(0, 300));
  return u.toString();
}

/**
 * Finish a connection from OpenRouter's redirect. Single use: the pending row
 * is removed before anything else happens, so a replayed callback finds
 * nothing. Never logs the code or the key.
 */
export async function completeOpenRouterConnect(
  db: Kysely<DB>,
  state: string,
  code: string | null,
  fetchFn: FetchFn = fetch,
): Promise<ConnectOutcome> {
  const row = await db
    .selectFrom('openrouter_connects')
    .selectAll()
    .where('state', '=', state)
    .executeTakeFirst();
  if (!row) return { found: false };
  await db.deleteFrom('openrouter_connects').where('state', '=', state).execute();

  const done = (status: ConnectStatus, message?: string): ConnectOutcome => ({
    found: true,
    returnTo: returnUrl(row.platform, status, message),
    status,
    message,
  });

  if (Date.parse(row.created_at) < Date.now() - TTL_MS) {
    return done('error', 'That sign-in took too long. Start again from Settings.');
  }
  if (!code) return done('error', 'OpenRouter did not approve the connection.');

  let apiKey: string | undefined;
  try {
    const res = await fetchFn(KEYS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: row.code_verifier, code_challenge_method: 'S256' }),
    });
    if (res.ok) apiKey = ((await res.json()) as { key?: string }).key;
    else logger.warn('openrouter code exchange refused', { status: res.status });
  } catch (err) {
    logger.warn('openrouter code exchange failed', { err: (err as Error).message });
  }
  if (!apiKey) {
    return done('error', 'OpenRouter did not accept the sign-in. Start again from Settings.');
  }

  const saved = await saveModelKey(
    db,
    row.user_id,
    { provider: 'openai', apiKey, model: row.model, baseUrl: OPENROUTER_BASE_URL },
    { keepIfUnfunded: true },
  );
  if (!saved.ok) return done('error', saved.message);
  if (saved.unfunded) {
    return done('needs_credit', 'Connected. Add credit at openrouter.ai/credits to start using it.');
  }
  return done('ok');
}
