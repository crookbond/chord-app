/**
 * A user-typed URL the server then calls (ADR 0269): the BYOK model endpoint
 * and a custom IMAP host. Saving either used to make the server connect to
 * whatever was typed — 169.254.169.254, 10.x, localhost — and the BYOK
 * failure message relayed whatever that host answered.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env as readonlyEnv } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { connectImapAccount } from '@/services/email-accounts/accounts.service.js';
import { saveModelKey } from '@/services/model-key.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const env = readonlyEnv as { NODE_ENV: string; IMAP_PROVIDER: string };
const saved = { nodeEnv: env.NODE_ENV, imap: env.IMAP_PROVIDER };

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'byok-user');
  if (!process.env.MASTER_KEY) process.env.MASTER_KEY = Buffer.alloc(32, 1).toString('base64');
});
afterEach(async () => {
  env.NODE_ENV = saved.nodeEnv;
  env.IMAP_PROVIDER = saved.imap;
  await closeTestDb(db);
});

describe('BYOK endpoint', () => {
  it('in production, never sends a request to an internal host', async () => {
    env.NODE_ENV = 'production';
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await saveModelKey(db, userId, {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-x',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      });
      expect(res.ok).toBe(false);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it('in production, refuses the cloud metadata address', async () => {
    env.NODE_ENV = 'production';
    const res = await saveModelKey(db, userId, {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-x',
      baseUrl: 'https://169.254.169.254/latest',
    });
    expect(res.ok).toBe(false);
    const row = await db.selectFrom('users').select('model_base_url').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(row.model_base_url).toBeNull();
  });

  it('in production, refuses plain http', async () => {
    env.NODE_ENV = 'production';
    const res = await saveModelKey(db, userId, {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-x',
      baseUrl: 'http://api.example.com/v1',
    });
    expect(res.ok).toBe(false);
  });

  it('does not relay what the endpoint answered', async () => {
    env.NODE_ENV = 'development';
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'INTERNAL-SECRET db=10.0.0.5 password=hunter2' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await saveModelKey(db, userId, {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-x',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).not.toMatch(/INTERNAL-SECRET|hunter2|10\.0\.0\.5/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe('custom IMAP host', () => {
  it('in production, refuses a private host before connecting', async () => {
    env.NODE_ENV = 'production';
    env.IMAP_PROVIDER = 'real';
    await expect(
      connectImapAccount(db, userId, {
        emailAddress: 'me@example.com',
        password: 'pw',
        preset: 'custom',
        host: '127.0.0.1',
        port: 6379,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.selectFrom('email_accounts').selectAll().execute()).toHaveLength(0);
  });
});
