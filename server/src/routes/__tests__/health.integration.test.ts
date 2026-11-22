/**
 * Health endpoints (liveness + readiness).
 *
 * Liveness (`/health`) must always answer cheaply. Readiness
 * (`/health/ready`) verifies Postgres connectivity and that an LLM provider
 * is configured, returning 503 when a dependency is down so a load balancer
 * can pull the node.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API } from '@chord/kernel';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const { Pool } = pg;

describe('health routes', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('liveness returns ok', async () => {
    const res = await fetch(`${base}${API.health}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('liveness advertises the bot mention alias for tooling auto-detect', async () => {
    const res = await fetch(`${base}${API.health}`);
    const body = (await res.json()) as { botAlias?: string };
    // Default deployment alias (example.env BOT_MENTION_ALIASES=chord).
    expect(typeof body.botAlias).toBe('string');
    expect(body.botAlias).toBe('chord');
  });

  it('liveness says where Chord is reachable on WhatsApp, and nothing when no number is set (ADR 0253)', async () => {
    const original = env.WHATSAPP_PUBLIC_NUMBER;
    const set = (v: string) => ((env as { WHATSAPP_PUBLIC_NUMBER: string }).WHATSAPP_PUBLIC_NUMBER = v);
    try {
      set('');
      expect(((await (await fetch(`${base}${API.health}`)).json()) as { whatsappNumber: string | null }).whatsappNumber).toBeNull();
      set('+1 (555) 010-0123');
      expect(((await (await fetch(`${base}${API.health}`)).json()) as { whatsappNumber: string | null }).whatsappNumber).toBe('+15550100123');
    } finally {
      set(original);
    }
  });

  it('readiness reports healthy when postgres + llm are up', async () => {
    const res = await fetch(`${base}${API.healthReady}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Record<string, { ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.llm.ok).toBe(true);
  });

  it('readiness reports 503 when postgres is unreachable', async () => {
    // Point a second app at a port nothing listens on. That is what
    // "unreachable" means to the readiness probe, and it needs no database:
    // tearing down a real one would either destroy the worker's recycled
    // handle or pay a CREATE DATABASE this assertion does not need.
    const unreachable = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: '127.0.0.1',
          port: 1,
          database: 'nope',
          connectionTimeoutMillis: 1_000,
        }),
      }),
    });
    const downServer = http.createServer(buildApp(unreachable));
    await new Promise<void>((resolve) => downServer.listen(0, '127.0.0.1', resolve));
    const downBase = `http://127.0.0.1:${(downServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${downBase}${API.healthReady}`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: Record<string, { ok: boolean }>;
      };
      expect(body.ok).toBe(false);
      expect(body.checks.postgres.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => downServer.close(() => resolve()));
      await unreachable.destroy().catch(() => {});
    }
  });
});
