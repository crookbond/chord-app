/**
 * ADR 0235 — connect OpenRouter as the user's own AI key, end to end over the
 * real app: start (session) -> OpenRouter -> callback (no session, `state` is
 * the credential) -> code exchange -> the same checked, sealed storage a pasted
 * key gets.
 *
 * Only two things are faked: the HTTP call to openrouter.ai (a stub on global
 * fetch that lets the test's own requests through) and the one tiny LLM call
 * that validates a key.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validate = vi.hoisted(() => vi.fn());
vi.mock('@/services/llm/factory.js', async (orig) => ({
  ...(await orig<typeof import('@/services/llm/factory.js')>()),
  validateUserModelKey: validate,
}));

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import { ensurePersonalGroup, createGroup } from '@/services/groups.service.js';
import { openRouterModelFor } from '@/services/openrouter-connect.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const ORIGIN = 'https://app.example';
const KEY = 'sk-or-v1-test-key';
type E = Record<string, string>;
const setEnv = (k: string, v: string) => ((env as unknown as E)[k] = v);

describe('connect OpenRouter (ADR 0235)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;
  let tok: string;
  let exchanges: { url: string; body: Record<string, string> }[];
  let exchangeStatus: number;
  const realFetch = globalThis.fetch;
  const savedMasterKey = process.env.MASTER_KEY;

  async function mintToken(uid: string): Promise<string> {
    const token = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now }).execute();
    return token;
  }

  beforeEach(async () => {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
    _resetCryptoCacheForTests();
    setEnv('WEB_ORIGIN', ORIGIN);
    validate.mockReset();
    validate.mockResolvedValue({ ok: true });
    exchanges = [];
    exchangeStatus = 200;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith('https://openrouter.ai/')) {
        exchanges.push({ url, body: JSON.parse(String(init?.body)) });
        return exchangeStatus === 200
          ? new Response(JSON.stringify({ key: KEY, user_id: 'or_user' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: exchangeStatus });
      }
      return realFetch(input, init);
    });
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'john', 'John Doe');
    tok = await mintToken(userId);
  });

  afterEach(async () => {
    if (savedMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = savedMasterKey;
    _resetCryptoCacheForTests();
    setEnv('WEB_ORIGIN', '');
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const start = (body: object = {}, token: string | null = tok) =>
    fetch(`${base}${API.meOpenRouterStart}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { [SESSION_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });

  /** Start an attempt; returns the state OpenRouter would echo back. */
  async function begin(body: object = {}, token: string | null = tok) {
    const res = await start(body, token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; model: string };
    const url = new URL(json.url);
    const callback = new URL(url.searchParams.get('callback_url')!);
    return { ...json, auth: url, state: callback.pathname.split('/').pop()! };
  }

  const callback = (state: string, code: string | null = 'code-123') =>
    fetch(`${base}${API.openRouterCallback(state)}${code ? `?code=${code}` : ''}`, { redirect: 'manual' });

  const keyRow = () =>
    db
      .selectFrom('users')
      .select(['model_provider', 'model_name', 'model_base_url', 'model_key_ciphertext'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  const pending = () => db.selectFrom('openrouter_connects').selectAll().execute();
  // ADR 0252 - what the app reads to say "your key is out of credit".
  const health = () =>
    db
      .selectFrom('users')
      .select(['byok_key_issue', 'byok_key_nudged_at'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  describe('starting', () => {
    it('needs a session', async () => {
      expect((await start({}, null)).status).toBe(401);
    });

    it('sends the user to OpenRouter with a PKCE challenge that matches the stored verifier', async () => {
      const { auth, state } = await begin();
      expect(auth.origin + auth.pathname).toBe('https://openrouter.ai/auth');
      expect(auth.searchParams.get('callback_url')).toBe(`${ORIGIN}${API.openRouterCallback(state)}`);
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      const [row] = await pending();
      expect(row).toMatchObject({ state, user_id: userId, platform: 'web' });
      expect(createHash('sha256').update(row!.code_verifier).digest('base64url')).toBe(
        auth.searchParams.get('code_challenge'),
      );
    });

    it('a model the user typed wins; otherwise it is a model OpenRouter knows', async () => {
      const typed = await begin({ model: 'meta-llama/llama-3.1-70b-instruct' });
      expect(typed.model).toBe('meta-llama/llama-3.1-70b-instruct');
      const dflt = await begin();
      expect(dflt.model).toContain('/');
    });

    it('one open attempt per person: starting again replaces the earlier one', async () => {
      const first = await begin();
      const second = await begin();
      expect((await pending()).map((r) => r.state)).toEqual([second.state]);
      expect((await callback(first.state)).status).toBe(400);
    });

    it('says so when there is no public address for OpenRouter to return to', async () => {
      setEnv('WEB_ORIGIN', '');
      const signup = env.SIGNUP_URL;
      setEnv('SIGNUP_URL', '');
      try {
        expect((await start()).status).toBe(503);
      } finally {
        setEnv('SIGNUP_URL', signup);
      }
    });
  });

  describe('finishing', () => {
    it('stores the key the user just authorised — checked and sealed — and sends the web user back', async () => {
      // An outage left over from the previous key does not follow the new one.
      await db
        .updateTable('users')
        .set({ byok_key_issue: 'credit', byok_key_issue_at: new Date().toISOString(), byok_key_nudged_at: new Date().toISOString() })
        .where('id', '=', userId)
        .execute();
      const { state } = await begin({ model: 'anthropic/claude-sonnet-4.6' });
      const [pend] = await pending();
      const res = await callback(state);
      expect(res.status).toBe(302);
      expect(await health()).toEqual({ byok_key_issue: null, byok_key_nudged_at: null });
      expect(res.headers.get('location')).toBe(`${ORIGIN}/settings?byok=ok`);
      expect(res.headers.get('cache-control')).toBe('no-store');

      // The code went to OpenRouter with this attempt's own verifier.
      expect(exchanges).toEqual([
        {
          url: 'https://openrouter.ai/api/v1/auth/keys',
          body: { code: 'code-123', code_verifier: pend!.code_verifier, code_challenge_method: 'S256' },
        },
      ]);
      // It was checked before it was kept...
      expect(validate).toHaveBeenCalledWith({
        provider: 'openai',
        apiKey: KEY,
        model: 'anthropic/claude-sonnet-4.6',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      // ...and stored the way a pasted key is: encrypted, never as the key itself.
      const row = await keyRow();
      expect(row).toMatchObject({
        model_provider: 'openai',
        model_name: 'anthropic/claude-sonnet-4.6',
        model_base_url: 'https://openrouter.ai/api/v1',
      });
      expect(row.model_key_ciphertext).not.toBeNull();
      expect(Buffer.from(row.model_key_ciphertext!).toString('utf8')).not.toContain(KEY);
      expect(await pending()).toHaveLength(0);
    });

    it('sends a native app back to its own scheme', async () => {
      const { state } = await begin({ platform: 'native' });
      const res = await callback(state);
      expect(res.headers.get('location')).toBe('chord://settings?byok=ok');
    });

    it('is single use: replaying the callback finds nothing and exchanges nothing', async () => {
      const { state } = await begin();
      await callback(state);
      const again = await callback(state);
      expect(again.status).toBe(400);
      expect(await again.text()).toContain('expired');
      expect(exchanges).toHaveLength(1);
    });

    it('an unknown state is a plain page, not a redirect', async () => {
      const res = await callback('not-a-real-state');
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(exchanges).toHaveLength(0);
    });

    it('only the person who started it is changed', async () => {
      const other = await createUser(db, 'priya', 'Priya Rao');
      await db
        .updateTable('users')
        .set({ model_provider: 'gemini', model_name: 'gemini-2.5-flash' })
        .where('id', '=', other)
        .execute();
      const { state } = await begin();
      await callback(state);
      expect((await keyRow()).model_provider).toBe('openai');
      const o = await db.selectFrom('users').select(['model_provider', 'model_name']).where('id', '=', other).executeTakeFirstOrThrow();
      expect(o).toEqual({ model_provider: 'gemini', model_name: 'gemini-2.5-flash' });
    });

    it('declining at OpenRouter keeps what was there and says it did not connect', async () => {
      await db.updateTable('users').set({ model_provider: 'gemini', model_name: 'old-model' }).where('id', '=', userId).execute();
      const { state } = await begin();
      const res = await callback(state, null);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('byok')).toBe('error');
      expect(exchanges).toHaveLength(0);
      expect(await keyRow()).toMatchObject({ model_provider: 'gemini', model_name: 'old-model' });
    });

    it('a code OpenRouter refuses stores nothing', async () => {
      exchangeStatus = 403;
      const { state } = await begin();
      const res = await callback(state);
      expect(new URL(res.headers.get('location')!).searchParams.get('byok')).toBe('error');
      expect((await keyRow()).model_key_ciphertext).toBeNull();
    });

    it('a key that checks out but has no credit is KEPT, and the user is told what is missing', async () => {
      validate.mockResolvedValue({ ok: false, error: { kind: 'credit', message: '402 Insufficient credits' } });
      const { state } = await begin();
      const res = await callback(state);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('byok')).toBe('needs_credit');
      expect(loc.searchParams.get('message')).toContain('openrouter.ai/credits');
      expect((await keyRow()).model_key_ciphertext).not.toBeNull();
      // ...and it is on record for the Email-tab banner, already explained so
      // the chat nudge does not say it a second time (ADR 0252).
      const h = await health();
      expect(h.byok_key_issue).toBe('credit');
      expect(h.byok_key_nudged_at).not.toBeNull();
    });

    it('a key that is rejected, or a model that does not exist, is NOT kept', async () => {
      await db.updateTable('users').set({ model_provider: 'gemini', model_name: 'old-model' }).where('id', '=', userId).execute();
      validate.mockResolvedValue({ ok: false, error: { kind: 'other', status: 404, message: '404 no such model' } });
      const { state } = await begin({ model: 'nope/nope' });
      const res = await callback(state);
      expect(new URL(res.headers.get('location')!).searchParams.get('byok')).toBe('error');
      expect(await keyRow()).toMatchObject({ model_provider: 'gemini', model_name: 'old-model', model_key_ciphertext: null });
    });

    it('an attempt left open past ten minutes cannot be finished', async () => {
      const { state } = await begin();
      await db
        .updateTable('openrouter_connects')
        .set({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() })
        .execute();
      const res = await callback(state);
      expect(new URL(res.headers.get('location')!).searchParams.get('byok')).toBe('error');
      expect(exchanges).toHaveLength(0);
      expect((await keyRow()).model_key_ciphertext).toBeNull();
    });
  });

  describe('the pasted-key route shares the same storage rules', () => {
    const put = (body: object) =>
      fetch(`${base}${API.meModelKey}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
        body: JSON.stringify(body),
      });
    const body = {
      provider: 'openai',
      apiKey: 'sk-pasted',
      model: 'deepseek/deepseek-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
    };

    it('saves a key that checks out', async () => {
      expect((await put(body)).status).toBe(200);
      expect(await keyRow()).toMatchObject({ model_name: 'deepseek/deepseek-chat' });
    });

    it('rejects a dead OpenRouter key by naming OpenRouter, not OpenAI', async () => {
      validate.mockResolvedValue({ ok: false, error: { kind: 'credit', message: '402' } });
      const res = await put(body);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('OpenRouter');
      expect(error).toContain('openrouter.ai/credits');
      expect(error).not.toContain('platform.openai.com');
      expect((await keyRow()).model_key_ciphertext).toBeNull();
    });
  });

  describe('in chat', () => {
    const call = (groupId: string, args: Record<string, unknown> = {}) =>
      applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        turnId: `turn-${Math.random()}`,
        call: { name: 'connect_openrouter', args } as never,
      });

    it('is registered and personal-chat only', () => {
      expect(toolSchemas).toHaveProperty('connect_openrouter');
      expect(PERSONAL_ONLY_TOOL_NAMES.has('connect_openrouter')).toBe(true);
    });

    it('hands back a tappable link and claims nothing is connected yet', async () => {
      const personal = (await ensurePersonalGroup(db, userId)).id;
      const out = await call(personal);
      expect(out.data).toMatchObject({ ok: true });
      expect(out.card).toMatchObject({ kind: 'action', title: 'Connect OpenRouter' });
      expect((out.card as { url: string }).url).toMatch(/^https:\/\/openrouter\.ai\/auth\?/);
      expect((await pending()).map((r) => r.user_id)).toEqual([userId]);
      expect((await keyRow()).model_key_ciphertext).toBeNull();
    });

    it('is refused inside a shared group', async () => {
      const shared = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId, nameIsCustom: true })).id;
      const out = await call(shared);
      expect(out.data).toMatchObject({ ok: false, reason: 'personal_only' });
      expect(await pending()).toHaveLength(0);
    });
  });
});

describe('which OpenRouter model a connection starts on', () => {
  const fallback = env.OPENROUTER_DEFAULT_MODEL;
  const sys = (provider: 'openai' | 'anthropic' | 'gemini' | 'mock', model: string, baseUrl: string | null = null) => ({
    provider,
    model,
    baseUrl,
  });

  it.each([
    ['openai', sys('openai', 'gpt-5.4-mini'), 'openai/gpt-5.4-mini'],
    ['gemini', sys('gemini', 'gemini-2.5-flash'), 'google/gemini-2.5-flash'],
    ['anthropic (dashes become dots)', sys('anthropic', 'claude-sonnet-4-6'), 'anthropic/claude-sonnet-4.6'],
    ['anthropic with a date suffix', sys('anthropic', 'claude-haiku-4-5-20251001'), 'anthropic/claude-haiku-4.5-20251001'],
    ['already an OpenRouter model', sys('openai', 'deepseek/deepseek-chat', 'https://openrouter.ai/api/v1'), 'deepseek/deepseek-chat'],
    ['some other compatible endpoint', sys('openai', 'llama3', 'http://localhost:11434/v1'), fallback],
    ['a mock', sys('mock', 'mock'), fallback],
    ['nothing configured', null, fallback],
  ] as const)('%s', (_name, system, expected) => {
    expect(openRouterModelFor(system as never)).toBe(expected);
  });

  it('what the user typed beats all of it', () => {
    expect(openRouterModelFor(sys('openai', 'gpt-5.4-mini'), '  x-ai/grok-4  ')).toBe('x-ai/grok-4');
  });
});
