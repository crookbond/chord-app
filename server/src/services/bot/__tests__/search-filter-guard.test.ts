import { describe, expect, it } from 'vitest';

import { dropUnaskedMailFilters } from '@/services/bot/search-filter-guard.js';

// The call prod's model made for "show me emails from mallory" (2026-10-20).
const PROD_CALL = {
  after: '2026-09-01',
  before: '2026-10-20',
  emailAction: ['to_do', 'reply_needed', 'informational', 'other'] as const,
  emailKind: 'delivery' as const,
  from: 'Steve Mallory',
  hasAttachment: false,
  to: '',
};

describe('search filters nobody asked for', () => {
  it('leaves only the person when the user named only a person', () => {
    const r = dropUnaskedMailFilters({ ...PROD_CALL, emailAction: [...PROD_CALL.emailAction] }, ['Show me emails from mallory']);
    expect(r.args).toEqual({ from: 'Steve Mallory' });
    expect(r.dropped.sort()).toEqual(['after', 'before', 'emailAction', 'emailKind', 'hasAttachment', 'to']);
  });

  it('keeps the filters the user did ask for', () => {
    const r = dropUnaskedMailFilters(
      { from: 'Bill', emailKind: 'delivery', after: '2026-09-01', hasAttachment: true, emailAction: ['reply_needed'] },
      ['packages from Bill since September with an attachment that need a reply'],
    );
    expect(r.args).toEqual({ from: 'Bill', emailKind: 'delivery', after: '2026-09-01', hasAttachment: true, emailAction: ['reply_needed'] });
  });

  it('reads the earlier messages too', () => {
    const r = dropUnaskedMailFilters({ from: 'Bill', emailKind: 'receipt' }, ['and from Bill?', 'show me my receipts from Costco']);
    expect(r.args.emailKind).toBe('receipt');
  });

  it('takes the call as given when there is no message to read', () => {
    const r = dropUnaskedMailFilters({ from: 'Bill', emailKind: 'flight', after: '2026-09-01' }, null);
    expect(r.args).toEqual({ from: 'Bill', emailKind: 'flight', after: '2026-09-01' });
  });

  it('never treats every action at once, an empty name or "no attachment" as a filter', () => {
    const r = dropUnaskedMailFilters(
      { to: ' ', hasAttachment: false, emailAction: ['to_do', 'reply_needed', 'informational', 'other'] },
      null,
    );
    expect(r.args).toEqual({});
  });
});
