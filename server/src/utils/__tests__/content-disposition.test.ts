import { validateHeaderValue } from 'node:http';

import { describe, expect, it } from 'vitest';

import { attachmentDisposition } from '@/utils/content-disposition.js';

describe('attachmentDisposition', () => {
  it('is a header Node will send for a filename with an en dash', () => {
    const name = 'Menu – final.pdf';
    // What the download route used to build: Node throws on it.
    expect(() => validateHeaderValue('Content-Disposition', `attachment; filename="${name}"`)).toThrow();

    const value = attachmentDisposition(name);
    expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
    expect(value).toBe(
      `attachment; filename="Menu _ final.pdf"; filename*=UTF-8''Menu%20%E2%80%93%20final.pdf`,
    );
  });

  it('keeps a plain filename in the plain form', () => {
    expect(attachmentDisposition('trip.pdf')).toBe('attachment; filename="trip.pdf"');
  });

  it('cannot be ended early by a quote or a line break', () => {
    const value = attachmentDisposition('a"b\r\nSet-Cookie: x=1.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.match(/"/g)).toHaveLength(2);
  });
});
