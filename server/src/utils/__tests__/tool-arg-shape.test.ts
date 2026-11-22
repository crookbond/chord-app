import { describe, expect, it } from 'vitest';

import { toolArgShape } from '@/utils/tool-arg-shape.js';

describe('a tool call as it is logged', () => {
  it('shows how a search was filtered without what was asked', () => {
    expect(
      toolArgShape({
        query: '',
        from: 'mallory',
        after: '2026-09-01',
        hasAttachment: false,
        emailAction: ['to_do'],
        emailKind: 'receipt',
        categories: ['emails', 'files'],
        limit: 5,
      }),
    ).toEqual({
      query: '',
      from: '<7 chars>',
      after: '2026-09-01',
      hasAttachment: false,
      emailAction: ['to_do'],
      emailKind: 'receipt',
      categories: ['emails', 'files'],
      limit: 5,
    });
  });

  it('never writes free text, even a single short word', () => {
    expect(toolArgShape({ query: 'cabin', title: 'dentist', body: 'see you at 3', listName: 'costco', tags: ['kids'] })).toEqual({
      query: '<5 chars>',
      title: '<7 chars>',
      body: '<12 chars>',
      listName: '<6 chars>',
      tags: ['<4 chars>'],
    });
  });

  it('keeps a server id, so the call can be matched to a row', () => {
    expect(toolArgShape({ threadId: 'emt_0XoEa3i8T_MI' })).toEqual({ threadId: 'emt_0XoEa3i8T_MI' });
    // A made-up id (an address, a sentence) is not one of ours: length only.
    expect(toolArgShape({ threadId: 'fake.one@gmail.com' })).toEqual({ threadId: '<18 chars>' });
  });
});
