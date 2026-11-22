/**
 * The sentence the app shows for a server error (kernel/src/request-error.ts).
 * Kernel has no harness of its own, so it is tested here.
 */
import { describe, expect, it } from 'vitest';

import { SERVER_TROUBLE_TEXT, TOO_MANY_REQUESTS_TEXT, requestErrorText } from '@chord/kernel';

describe('requestErrorText', () => {
  it('words the rate limiter instead of showing its text (the To Do\'s screen showed "too many requests, slow down")', () => {
    expect(requestErrorText(429, 'Too Many Requests', '{"error":"too many requests, slow down"}')).toBe(
      TOO_MANY_REQUESTS_TEXT,
    );
    expect(requestErrorText(429, 'Too Many Requests', '')).toBe(TOO_MANY_REQUESTS_TEXT);
  });

  it('keeps a message the server wrote for the person', () => {
    expect(requestErrorText(400, 'Bad Request', '{"error":"that key was rejected by OpenAI"}')).toBe(
      'that key was rejected by OpenAI',
    );
    expect(requestErrorText(404, 'Not Found', '{"error":"thread not found"}')).toBe('thread not found');
    expect(requestErrorText(503, 'Service Unavailable', '{"error":"SMS verification is not set up"}')).toBe(
      'SMS verification is not set up',
    );
  });

  it('never shows "internal error" or a proxy\'s HTML page', () => {
    expect(requestErrorText(500, 'Internal Server Error', '{"error":"internal error"}')).toBe(SERVER_TROUBLE_TEXT);
    expect(
      requestErrorText(502, 'Bad Gateway', '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>'),
    ).toBe(SERVER_TROUBLE_TEXT);
    expect(requestErrorText(504, 'Gateway Timeout', '')).toBe(SERVER_TROUBLE_TEXT);
  });

  it('falls back to the body, then the status, for a 4xx with no { error }', () => {
    expect(requestErrorText(413, 'Payload Too Large', 'file too big')).toBe('file too big');
    expect(requestErrorText(418, "I'm a teapot", '')).toBe("418 I'm a teapot");
  });
});
