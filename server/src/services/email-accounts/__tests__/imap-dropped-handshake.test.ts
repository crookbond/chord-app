import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realImapApi } from '@/services/email-accounts/imap-api.js';

/**
 * Prod, 2026-10-06 23:41 UTC: chord-worker exited on
 *
 *   AuthenticationFailure [Error]: Already logged out
 *       at ImapFlow.authenticate
 *       at ImapFlow.startSession
 *   Emitted 'error' event on ImapFlow instance
 *
 * The server greeted us and then dropped the socket while the login was still
 * starting. connect() rejects on the close; the login, still running in the
 * background, then fails with nothing left to reject and is emitted as an
 * 'error' event. This runs the real imapflow against a socket that does
 * exactly that - a fake client would only prove the fake.
 */
describe('imap server that drops the socket mid-handshake', () => {
  let server: net.Server;
  let port: number;
  const fatal: unknown[] = [];
  const onFatal = (err: unknown) => fatal.push(err);

  beforeEach(async () => {
    fatal.length = 0;
    server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write('* OK ready\r\n');
      // The first thing the client sends is CAPABILITY; answer by hanging up.
      sock.on('data', () => sock.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    process.on('uncaughtException', onFatal);
    process.on('unhandledRejection', onFatal);
  });

  afterEach(async () => {
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails the call without an unhandled error event', async () => {
    const api = realImapApi({
      host: '127.0.0.1',
      port,
      smtpHost: '127.0.0.1',
      smtpPort: 465,
      username: 'someone@example.com',
      password: 'app-password',
    });

    await expect(api.listWindow(90)).rejects.toThrow(/close/i);

    // The late failure lands a few turns after connect() rejects.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fatal).toEqual([]);
  });
});
