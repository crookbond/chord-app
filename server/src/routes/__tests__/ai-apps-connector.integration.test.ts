/**
 * ADR 0335 — the MCP connector end to end over the real app: register a client
 * (RFC 7591), authorize with PKCE, answer on the consent endpoints, exchange
 * the code, call MCP tools, refresh, revoke. Nothing is faked.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AI_APP_TRY_ASKING, API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listMcpTools } from '@/services/ai-apps/mcp-tools.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type E = Record<string, unknown>;
const setEnv = (k: string, v: unknown) => ((env as unknown as E)[k] = v);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const b64url = (b: Buffer) => b.toString('base64url');

describe('MCP connector (ADR 0335)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;
  let session: string;

  async function mintSession(uid: string): Promise<string> {
    const token = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now }).execute();
    return token;
  }

  beforeEach(async () => {
    setEnv('MCP_CONNECTOR_ENABLED', true);
    setEnv('WEB_ORIGIN', 'https://chord.example');
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'john', 'John Doe');
    session = await mintSession(userId);
  });

  afterEach(async () => {
    setEnv('MCP_CONNECTOR_ENABLED', false);
    setEnv('WEB_ORIGIN', '');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  const form = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

  async function register(redirectUris: string[] = [REDIRECT]): Promise<string> {
    const res = await json(API.oauthRegister, { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  function pkce() {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  const authorize = (q: Record<string, string>) =>
    fetch(`${base}${API.oauthAuthorize}?${new URLSearchParams(q).toString()}`, { redirect: 'manual' });

  /** Through consent: returns the code the client receives. */
  async function getCode(
    clientId: string,
    challenge: string,
    opts: { scope?: string; asSession?: string } = {},
  ): Promise<string> {
    const res = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get('location')!);
    expect(consent.origin + consent.pathname).toBe('https://chord.example/connect');
    const requestId = consent.searchParams.get('request')!;
    const view = await fetch(`${base}${API.meAiAppRequest(requestId)}`, {
      headers: { [SESSION_HEADER]: opts.asSession ?? session },
    });
    expect(view.status).toBe(200);
    expect(((await view.json()) as { clientName: string }).clientName).toBe('Claude');
    const ok = await json(API.meAiAppRequestApprove(requestId), {}, { [SESSION_HEADER]: opts.asSession ?? session });
    expect(ok.status).toBe(200);
    const back = new URL(((await ok.json()) as { redirectTo: string }).redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe('https://chord.example');
    return back.searchParams.get('code')!;
  }

  async function connect(opts: { scope?: string; asSession?: string } = {}) {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await getCode(clientId, challenge, opts);
    const res = await form(API.oauthToken, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; scope: string };
    return { clientId, ...tokens };
  }

  let rpcId = 0;
  async function mcp(token: string | null, method: string, params: unknown = {}) {
    return fetch(`${base}${API.mcp}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  }
  async function call(token: string, name: string, args: unknown = {}) {
    const res = await mcp(token, 'tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean; structuredContent?: E } }).result;
  }

  it('is off unless MCP_CONNECTOR_ENABLED', async () => {
    setEnv('MCP_CONNECTOR_ENABLED', false);
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await mcp('x', 'ping')).status).toBe(404);
    expect((await json(API.oauthRegister, { redirect_uris: [REDIRECT] })).status).toBe(404);
  });

  it('publishes discovery metadata that points at its own endpoints', async () => {
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as E;
    expect(as.issuer).toBe('https://chord.example');
    expect(as.token_endpoint).toBe(`https://chord.example${API.oauthToken}`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource${API.mcp}`)).json()) as E;
    expect(pr.resource).toBe(`https://chord.example${API.mcp}`);
    expect(pr.authorization_servers).toEqual(['https://chord.example']);
  });

  it('refuses a redirect URI that is neither https nor loopback http', async () => {
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/cb#frag']) {
      const res = await json(API.oauthRegister, { redirect_uris: [bad] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as E).error).toBe('invalid_redirect_uri');
    }
    expect((await json(API.oauthRegister, { redirect_uris: ['http://127.0.0.1:33418/cb'] })).status).toBe(201);
  });

  it('never redirects to a URI the client did not register', async () => {
    const clientId = await register();
    const res = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example/steal',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await db.selectFrom('oauth_requests').selectAll().execute()).toHaveLength(0);
  });

  it('requires S256 PKCE', async () => {
    const clientId = await register();
    const cases: Record<string, string>[] = [{}, { code_challenge: pkce().challenge, code_challenge_method: 'plain' }];
    for (const q of cases) {
      const res = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, ...q });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    }
  });

  it('refuses a code with the wrong PKCE verifier, and a code spent twice revokes what it issued', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await getCode(clientId, challenge);
    const exchange = (v: string) =>
      form(API.oauthToken, { grant_type: 'authorization_code', code, code_verifier: v, client_id: clientId, redirect_uri: REDIRECT });

    const wrong = await exchange(b64url(randomBytes(32)));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as E).error).toBe('invalid_grant');

    const good = await exchange(verifier);
    expect(good.status).toBe(200);
    const { access_token } = (await good.json()) as { access_token: string };
    expect((await mcp(access_token, 'ping')).status).toBe(200);

    const again = await exchange(verifier);
    expect(again.status).toBe(400);
    expect((await mcp(access_token, 'ping')).status).toBe(401);
  });

  it('answers a consent request once', async () => {
    const clientId = await register();
    const res = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const requestId = new URL(res.headers.get('location')!).searchParams.get('request')!;
    expect((await json(API.meAiAppRequestApprove(requestId), {})).status).toBe(401);
    expect((await json(API.meAiAppRequestDeny(requestId), {}, { [SESSION_HEADER]: session })).status).toBe(200);
    expect((await json(API.meAiAppRequestApprove(requestId), {}, { [SESSION_HEADER]: session })).status).toBe(409);
  });

  it('stores only hashes of every secret', async () => {
    const t = await connect();
    const rows = await db.selectFrom('oauth_tokens').select('token_hash').execute();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.token_hash.startsWith('h_')).toBe(true);
      expect([t.access_token, t.refresh_token]).not.toContain(r.token_hash);
    }
    expect(rows.map((r) => r.token_hash)).toContain(hashSessionToken(t.access_token));
  });

  it('asks for a token with a pointer to its metadata', async () => {
    const res = await mcp(null, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="https://chord.example/.well-known/oauth-protected-resource${API.mcp}"`);
    const bad = await mcp('chord_at_made_up', 'ping');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('a Chord session token is not an MCP token', async () => {
    expect((await mcp(session, 'ping')).status).toBe(401);
  });

  it('initializes, lists tools and reads the user\'s own to-dos', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_task', args: { title: 'Renew passport' } },
    });
    const { access_token } = await connect();

    const init = (await (await mcp(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json()) as {
      result: { protocolVersion: string; capabilities: E };
    };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    const note = await fetch(`${base}${API.mcp}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(note.status).toBe(202);

    const list = (await (await mcp(access_token, 'tools/list')).json()) as { result: { tools: { name: string; annotations: E; inputSchema: E }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search', 'read_email', 'list_tasks', 'create_event', 'list_action_items']));
    // Never offered: anything that sends, deletes or acts without a tap.
    for (const n of ['compose_email', 'forward_email', 'delete_event', 'complete_task', 'message_user', 'disconnect_app']) {
      expect(names).not.toContain(n);
    }
    expect(list.result.tools.find((t) => t.name === 'list_tasks')!.annotations.readOnlyHint).toBe(true);
    expect(list.result.tools.find((t) => t.name === 'list_tasks')!.inputSchema.type).toBe('object');

    const out = await call(access_token, 'list_tasks', {});
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toContain('Renew passport');
  });

  it('a write is only a suggestion until the user confirms it in Chord', async () => {
    const { access_token } = await connect();
    const out = await call(access_token, 'create_task', { title: 'Book the dentist' });
    expect(out.isError).toBe(false);
    expect(await db.selectFrom('tasks').selectAll().execute()).toHaveLength(0);

    const props = await db.selectFrom('proposals').selectAll().execute();
    expect(props).toHaveLength(1);
    expect(props[0].status).toBe('pending');
    expect(props[0].tool_name).toBe('create_task');
    expect(props[0].provenance).toMatch(/^connector:ogr_/);

    const items = await call(access_token, 'list_action_items', {});
    expect(items.content[0].text).toContain('Book the dentist');

    const confirm = await json(`/api/v1/proposals/${props[0].id}/confirm`, {}, { [SESSION_HEADER]: session });
    expect(confirm.status).toBe(200);
    const tasks = await db.selectFrom('tasks').select('title').execute();
    expect(tasks.map((t) => t.title)).toEqual(['Book the dentist']);
  });

  it('a read-only grant cannot see or call the suggestion tools', async () => {
    const { access_token, scope } = await connect({ scope: 'read' });
    expect(scope).toBe('read');
    const list = (await (await mcp(access_token, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).not.toContain('create_task');
    const out = await call(access_token, 'create_task', { title: 'x' });
    expect(out.isError).toBe(true);
    expect(await db.selectFrom('proposals').selectAll().execute()).toHaveLength(0);
  });

  it('a token reads only its own user', async () => {
    const other = await createUser(db, 'mallory', 'Mallory');
    const otherPersonal = await ensurePersonalGroup(db, other);
    await applyToolCall(db, {
      groupId: otherPersonal.id,
      actorUserId: other,
      provenance: null,
      call: { name: 'create_task', args: { title: 'Mallory secret task' } },
    });
    const { access_token } = await connect();
    const out = await call(access_token, 'list_tasks', {});
    expect(out.content[0].text).not.toContain('Mallory secret task');
  });

  it('rotates refresh tokens, and a spent one revokes the grant', async () => {
    const t = await connect();
    const refresh = (rt: string) => form(API.oauthToken, { grant_type: 'refresh_token', refresh_token: rt, client_id: t.clientId });
    const first = await refresh(t.refresh_token);
    expect(first.status).toBe(200);
    const next = (await first.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect((await mcp(next.access_token, 'ping')).status).toBe(200);

    const replay = await refresh(t.refresh_token);
    expect(replay.status).toBe(400);
    expect((await mcp(next.access_token, 'ping')).status).toBe(401);
    expect((await refresh(next.refresh_token)).status).toBe(400);
  });

  it('a refresh token from another client is refused', async () => {
    const t = await connect();
    const otherClient = await register();
    const res = await form(API.oauthToken, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: otherClient });
    expect(res.status).toBe(400);
  });

  it('disconnecting in Settings ends access at once', async () => {
    const { access_token } = await connect();
    const apps = (await (await fetch(`${base}${API.meAiApps}`, { headers: { [SESSION_HEADER]: session } })).json()) as { id: string; name: string }[];
    expect(apps.map((a) => a.name)).toEqual(['Claude']);
    const del = await fetch(`${base}${API.meAiApp(apps[0].id)}`, { method: 'DELETE', headers: { [SESSION_HEADER]: session } });
    expect(del.status).toBe(204);
    expect((await mcp(access_token, 'ping')).status).toBe(401);
  });

  it('another user cannot disconnect my app', async () => {
    await connect();
    const apps = (await (await fetch(`${base}${API.meAiApps}`, { headers: { [SESSION_HEADER]: session } })).json()) as { id: string }[];
    const other = await mintSession(await createUser(db, 'eve', 'Eve'));
    const del = await fetch(`${base}${API.meAiApp(apps[0].id)}`, { method: 'DELETE', headers: { [SESSION_HEADER]: other } });
    expect(del.status).toBe(404);
  });

  it('the bot disconnects an app by name from the personal chat only', async () => {
    const { access_token } = await connect();
    const personal = await ensurePersonalGroup(db, userId);
    const listed = await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_connected_apps', args: {} },
    });
    expect(JSON.stringify(listed.data)).toContain('Claude');
    const res = await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: userId,
      provenance: null,
      call: { name: 'disconnect_app', args: { app: 'claude' } },
    });
    expect((res.data as E).ok).toBe(true);
    expect((await mcp(access_token, 'ping')).status).toBe(401);
  });

  it('RFC 7009 revocation of the refresh token ends the grant', async () => {
    const t = await connect();
    const res = await form(API.oauthRevoke, { token: t.refresh_token, client_id: t.clientId });
    expect(res.status).toBe(200);
    expect((await mcp(t.access_token, 'ping')).status).toBe(401);
  });

  it('refuses a browser Origin it does not expect (MCP DNS-rebinding rule)', async () => {
    const { access_token } = await connect();
    const ping = (origin?: string) =>
      fetch(`${base}${API.mcp}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${access_token}`,
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    expect((await ping('https://evil.example')).status).toBe(403);
    expect((await ping('http://claude.ai')).status).toBe(403);
    expect((await ping('https://claude.ai.evil.example')).status).toBe(403);
    expect((await ping()).status).toBe(200);
    expect((await ping('https://claude.ai')).status).toBe(200);
    expect((await ping('https://chatgpt.com')).status).toBe(200);
    expect((await ping('https://chord.example')).status).toBe(200);
    expect((await ping('http://localhost:6274')).status).toBe(200);
  });

  // ── Getting started (addendum): account, mailboxes, then things to try ──

  describe('getting started', () => {
    let provider: unknown;
    beforeEach(() => {
      provider = (env as unknown as E).GMAIL_PROVIDER;
      // The mock Gmail counts every user as connected; this is about a real mailbox.
      setEnv('GMAIL_PROVIDER', 'google');
    });
    afterEach(() => setEnv('GMAIL_PROVIDER', provider));

    type Started = {
      steps: { step: number; done: boolean; link?: string }[];
      nextStep: number;
      mailboxes: { address: string }[];
      tryAsking: string[];
    };

    it('with no mailbox, the next step is connecting one, with the Settings link', async () => {
      const { access_token } = await connect();
      const out = await call(access_token, 'get_started');
      expect(out.isError).toBe(false);
      const s = out.structuredContent as unknown as Started;
      expect(s.steps[0]!.done).toBe(true);
      expect(s.steps[1]!.done).toBe(false);
      expect(s.nextStep).toBe(2);
      expect(s.steps[1]!.link).toBe('https://chord.example/settings?open=mailboxes');
      expect(s.tryAsking.length).toBeGreaterThan(3);
    });

    it('a connected mailbox moves the user on to trying it', async () => {
      await db
        .updateTable('users')
        .set({ email: 'john@example.com', refresh_token_scopes: 'openid https://www.googleapis.com/auth/gmail.modify' })
        .where('id', '=', userId)
        .execute();
      const { access_token } = await connect();
      const s = (await call(access_token, 'get_started')).structuredContent as unknown as Started;
      expect(s.steps[1]!.done).toBe(true);
      expect(s.nextStep).toBe(3);
      expect(s.mailboxes.map((m) => m.address)).toEqual(['john@example.com']);
    });

    it('a read-only grant still gets started, and is offered only things it can do', async () => {
      const { access_token } = await connect({ scope: 'read' });
      const list = (await (await mcp(access_token, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((t) => t.name)).toContain('get_started');
      const s = (await call(access_token, 'get_started')).structuredContent as unknown as Started;
      const readOnly = AI_APP_TRY_ASKING.filter((t) => t.scope === 'read').map((t) => t.ask);
      expect(s.tryAsking).toEqual(readOnly);
    });

    it('a suggest-only grant can still get started', async () => {
      const { access_token, scope } = await connect({ scope: 'suggest' });
      expect(scope).toBe('suggest');
      const list = (await (await mcp(access_token, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((t) => t.name)).toContain('get_started');
      expect((await call(access_token, 'get_started')).isError).toBe(false);
    });

    it('an email search with no mailbox says why it is empty and where to connect', async () => {
      const { access_token } = await connect();
      const out = await call(access_token, 'search', { query: 'field trip' });
      expect(out.isError).toBe(false);
      const no = (out.structuredContent as E).noMailbox as { connectAt: string };
      expect(no.connectAt).toBe('https://chord.example/settings?open=mailboxes');
    });

    it('the server tells the app to start with get_started', async () => {
      const res = await mcp(null, 'initialize', {});
      expect(res.status).toBe(401);
      const { access_token } = await connect();
      const init = (await (
        await mcp(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      ).json()) as { result: { instructions: string } };
      expect(init.result.instructions).toContain('get_started');
    });
  });
});

describe('things to try (ADR 0335 addendum)', () => {
  it('name only tools the connector has, at the scope they are listed under', () => {
    const readTools = new Set(listMcpTools(['read']).map((t) => t.name));
    const allTools = new Set(listMcpTools(['read', 'suggest']).map((t) => t.name));
    for (const t of AI_APP_TRY_ASKING) {
      const usable = t.scope === 'read' ? readTools : allTools;
      for (const u of t.uses) expect(usable.has(u), `${t.ask} uses ${u}`).toBe(true);
    }
  });
});
