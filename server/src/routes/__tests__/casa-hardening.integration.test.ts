/**
 * Gaps found by the CASA AL1 review that make questionnaire answers untrue
 * (ADR 0269). Each test is the failure as it was: the cookie without Secure,
 * the raw token in `sessions`, `?token=` accepted on any route, a 5xx leaking
 * its internal message, an uploaded HTML file served as HTML.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { API, SESSION_HEADER } from '@chord/kernel';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env as readonlyEnv } from '@/config/env.js';

const env = readonlyEnv as { -readonly [K in keyof typeof readonlyEnv]: (typeof readonlyEnv)[K] } & { NODE_ENV: string; AUTH_MODE: 'google' | 'demo' };
import type { DB } from '@/db/schema.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
const savedNodeEnv = env.NODE_ENV;
const savedAuthMode = env.AUTH_MODE;

beforeEach(async () => {
  db = await openTestDb();
  env.AUTH_MODE = 'demo';
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  env.NODE_ENV = savedNodeEnv;
  env.AUTH_MODE = savedAuthMode;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

async function signIn(username: string): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base}${API.session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return { token: body.token, cookie: res.headers.get('set-cookie') ?? '' };
}

describe('session cookie', () => {
  it('is Secure in production', async () => {
    env.NODE_ENV = 'production';
    const { cookie } = await signIn('casa-prod');
    expect(cookie).toMatch(/chord\.sid=/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('is not Secure in local dev, where the server is plain http', async () => {
    env.NODE_ENV = 'development';
    const { cookie } = await signIn('casa-dev');
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('logout clears it with the same attributes', async () => {
    env.NODE_ENV = 'production';
    const { token } = await signIn('casa-logout-cookie');
    const res = await fetch(`${base}${API.sessionLogout}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: token },
    });
    expect(res.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
  });
});

describe('session tokens at rest', () => {
  it('sessions holds a hash of the token, never the token', async () => {
    const { token } = await signIn('casa-hash');
    const rows = await db.selectFrom('sessions').select('token').execute();
    expect(rows.map((r) => r.token)).not.toContain(token);
    expect(rows.map((r) => r.token)).toContain(hashSessionToken(token));
  });

  it('the token the client holds still signs it in', async () => {
    const { token } = await signIn('casa-me');
    const res = await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: token } });
    expect(res.status).toBe(200);
  });

  it('the stored value does not sign anyone in', async () => {
    const { token } = await signIn('casa-stolen-row');
    const res = await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: hashSessionToken(token) } });
    expect(res.status).toBe(401);
  });

  it('logout deletes the session', async () => {
    const { token } = await signIn('casa-logout');
    await fetch(`${base}${API.sessionLogout}`, { method: 'POST', headers: { [SESSION_HEADER]: token } });
    expect(await db.selectFrom('sessions').selectAll().execute()).toHaveLength(0);
    const res = await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: token } });
    expect(res.status).toBe(401);
  });
});

describe('?token= query fallback', () => {
  it('is refused on an ordinary route', async () => {
    const { token } = await signIn('casa-query');
    const res = await fetch(`${base}${API.me}?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it('still works on the SSE stream the web client opens', async () => {
    const { token } = await signIn('casa-stream');
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/v1/me/stream?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    ctrl.abort();
  });
});

describe('group file download', () => {
  it('serves an uploaded HTML file as bytes to download, never as a page', async () => {
    const userId = await createUser(db, 'casa-files');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: userId });
    const id = newId('a');
    const rel = path.join('test-casa', id, 'evil.html');
    const full = path.join(env.DATA_DIR, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '<script>alert(document.cookie)</script>');
    try {
      const now = new Date().toISOString();
      await db
        .insertInto('attachments')
        .values({
          id,
          scope_kind: 'group',
          scope_id: group.id,
          uploaded_by: userId,
          filename: 'evil.html',
          mime_type: 'text/html',
          size: 40,
          path: rel,
          summary: null,
          extracted_text: null,
          image_meta: null,
          pinned: 0,
          indexed_at: now,
          created_at: now,
        })
        .execute();
      const token = newId('t');
      await db
        .insertInto('sessions')
        .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
        .execute();

      const res = await fetch(`${base}/api/v1/attachments/${id}`, { headers: { [SESSION_HEADER]: token } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/octet-stream/);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await fs.rm(path.join(env.DATA_DIR, 'test-casa', id), { recursive: true, force: true });
    }
  });
});

describe('error handler', () => {
  function appWith(err: unknown): express.Express {
    const app = express();
    app.get('/x', (_req, _res, next) => next(err));
    app.use(errorHandler);
    return app;
  }

  async function call(app: express.Express): Promise<{ status: number; body: { error: string } }> {
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/x`);
      return { status: res.status, body: (await res.json()) as { error: string } };
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  it('does not hand a 5xx message to the client', async () => {
    const r = await call(appWith(new Error('Cloud KMS decrypt failed (503)')));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('internal error');
  });

  it('keeps a deliberate 4xx message', async () => {
    const r = await call(appWith(Object.assign(new Error('zip has too many entries'), { status: 400 })));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('zip has too many entries');
  });
});
