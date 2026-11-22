/**
 * The message post answers 201 and then keeps working (follow-up window,
 * confirm verbs, starting the bot). A throw in that part reached the error
 * handler, which answered a second time: that throws "Cannot set headers
 * after they are sent", the error escapes the handler, and Express falls back
 * to destroying the socket. The log also called it an unhandled 500, for a
 * request the client saw succeed.
 */
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/config/logging.js';
import { errorHandler } from '@/middleware/error-handler.js';

function sentResponse(): Response {
  const res = {
    headersSent: true,
    status: () => res,
    json: () => {
      throw Object.assign(new Error('Cannot set headers after they are sent to the client'), {
        code: 'ERR_HTTP_HEADERS_SENT',
      });
    },
  };
  return res as unknown as Response;
}

describe('an error after the response was sent', () => {
  it('is logged, not answered again', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      expect(() =>
        errorHandler(new Error('follow-up window lookup failed'), {} as Request, sentResponse(), () => {}),
      ).not.toThrow();
      expect(spy).toHaveBeenCalledWith('error after the response was sent', expect.anything());
    } finally {
      spy.mockRestore();
    }
  });
});
