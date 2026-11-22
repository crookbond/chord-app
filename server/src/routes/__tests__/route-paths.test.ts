/**
 * A route registered through a kernel path helper that encodes its argument
 * matched nothing: `encodeURIComponent(':attId')` is `%3AattId`, so the email
 * attachment download answered Express's own 404 for three months
 * (email-attachment-download.integration.test.ts). Every registered path is
 * checked here for an encoded character, which no route pattern needs.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';

type Layer = {
  route?: { path: string | string[] };
  handle?: { stack?: Layer[] };
};

function routePaths(stack: Layer[], out: string[] = []): string[] {
  for (const layer of stack) {
    if (layer.route) {
      const p = layer.route.path;
      out.push(...(Array.isArray(p) ? p : [p]).filter((x): x is string => typeof x === 'string'));
    } else if (layer.handle?.stack) {
      routePaths(layer.handle.stack, out);
    }
  }
  return out;
}

describe('registered route paths', () => {
  it('contain no URL-encoded characters', () => {
    const app = buildApp({} as never) as unknown as { _router: { stack: Layer[] } };
    const paths = routePaths(app._router.stack);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths.filter((p) => /%[0-9A-Fa-f]{2}/.test(p))).toEqual([]);
  });
});
