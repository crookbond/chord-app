/**
 * Which unsubscribe we are allowed to offer (ADR 0122). The kind decides what
 * we may claim afterwards, so getting it wrong is a lie, not a UI nit.
 */
import { describe, expect, it } from 'vitest';

import { parseUnsubscribe } from '@chord/kernel';

describe('parseUnsubscribe', () => {
  it('is one-click only when RFC 8058 says so', () => {
    const opt = parseUnsubscribe(
      '<https://list.example/u/abc>, <mailto:u@list.example>',
      'List-Unsubscribe=One-Click',
    );

    expect(opt).toEqual({ kind: 'one_click', target: 'https://list.example/u/abc' });
  });

  it('without the Post header, an https URI is a link and not a one-click', () => {
    // POSTing anyway would be a guess about someone else's endpoint.
    const opt = parseUnsubscribe('<https://list.example/u/abc>');

    expect(opt?.kind).toBe('link');
  });

  it('prefers a mailto we can send over a page the reader must finish', () => {
    const opt = parseUnsubscribe('<mailto:u@list.example>, <https://list.example/u/abc>');

    expect(opt).toEqual({ kind: 'mailto', target: 'u@list.example' });
  });

  it('carries the subject the sender asked for', () => {
    const opt = parseUnsubscribe('<mailto:u@list.example?subject=unsubscribe%20me>');

    expect(opt).toEqual({ kind: 'mailto', target: 'u@list.example', subject: 'unsubscribe me' });
  });

  it('accepts a bare uri from senders who skip the angle brackets', () => {
    expect(parseUnsubscribe('https://list.example/u/abc')?.kind).toBe('link');
  });

  it('falls back to http, which is a link and never a one-click', () => {
    // RFC 8058 one-click is https-only; an http URI stays a link even with
    // the Post header present.
    const opt = parseUnsubscribe('<http://list.example/u/abc>', 'List-Unsubscribe=One-Click');

    expect(opt).toEqual({ kind: 'link', target: 'http://list.example/u/abc' });
  });

  it('ignores a mailto with no address', () => {
    expect(parseUnsubscribe('<mailto:>, <https://list.example/u>')?.kind).toBe('link');
  });

  it('returns nothing when there is no header, or nothing usable in it', () => {
    expect(parseUnsubscribe(null)).toBeNull();
    expect(parseUnsubscribe('   ')).toBeNull();
    expect(parseUnsubscribe('<ftp://list.example/u>')).toBeNull();
  });
});
