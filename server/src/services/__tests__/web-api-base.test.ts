/**
 * ADR 0316: the web session is a SameSite=Lax cookie, so the web app must reach
 * the API on the same site as the page. Found clicking through the dev web app:
 * `.env` sets EXPO_PUBLIC_API_BASE=http://127.0.0.1:4000 while the page is on
 * localhost:8081, so sign-in succeeded and every later request was 401.
 */
import { describe, expect, it } from 'vitest';

import { isLocalDevHost, webApiBase } from '@chord/kernel';

const page = (hostname: string, protocol = 'http:') => ({ protocol, hostname });

describe('webApiBase', () => {
  it('moves a loopback API to the page host so the cookie is sent', () => {
    expect(webApiBase('http://127.0.0.1:4000', page('localhost'))).toBe('http://localhost:4000');
    expect(webApiBase('http://localhost:4000/', page('127.0.0.1'))).toBe('http://127.0.0.1:4000');
  });

  it('moves a LAN API set for phones to the page host', () => {
    expect(webApiBase('http://192.168.1.101:4000', page('localhost'))).toBe('http://localhost:4000');
  });

  it('keeps an API already on the page host', () => {
    expect(webApiBase('http://192.168.1.101:4000', page('192.168.1.101'))).toBe('http://192.168.1.101:4000');
  });

  it('never rewrites a public API host', () => {
    expect(webApiBase('https://chordapp.ai', page('chordapp.ai', 'https:'))).toBe('https://chordapp.ai');
    expect(webApiBase('https://chordapp.ai', page('www.chordapp.ai', 'https:'))).toBe('https://chordapp.ai');
    expect(webApiBase('https://chordapp.ai', page('localhost'))).toBe('https://chordapp.ai');
  });

  it('uses the page host on port 4000 when nothing is configured', () => {
    expect(webApiBase(undefined, page('localhost'))).toBe('http://localhost:4000');
    expect(webApiBase('', page('10.0.0.5'))).toBe('http://10.0.0.5:4000');
  });

  it('knows what a local host is', () => {
    expect(isLocalDevHost('localhost')).toBe(true);
    expect(isLocalDevHost('172.20.1.1')).toBe(true);
    expect(isLocalDevHost('172.32.1.1')).toBe(false);
    expect(isLocalDevHost('8.8.8.8')).toBe(false);
    expect(isLocalDevHost('chordapp.ai')).toBe(false);
  });
});
