import { describe, expect, it } from 'vitest';

import { categoryNavOrder } from '@chord/kernel';

const t = (id: string, isUnread: boolean, day: number) => ({
  id,
  isUnread,
  lastMessageAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`,
});

describe('categoryNavOrder', () => {
  it('starts on the tapped email, then the rest of the unread newest first', () => {
    const threads = [t('old', true, 1), t('tapped', true, 10), t('newest', true, 15), t('mid', true, 5)];
    expect(categoryNavOrder('tapped', threads)).toEqual(['tapped', 'newest', 'mid', 'old']);
  });

  it('leaves read email out, but keeps the tapped one even when it is read', () => {
    const threads = [t('tapped', false, 10), t('read', false, 12), t('unread', true, 8)];
    expect(categoryNavOrder('tapped', threads)).toEqual(['tapped', 'unread']);
  });

  it('lists an email once when two categories both hold it', () => {
    const threads = [t('a', true, 3), t('a', true, 3), t('b', true, 2)];
    expect(categoryNavOrder('b', threads)).toEqual(['b', 'a']);
  });

  it('is just the tapped email when nothing else is unread', () => {
    expect(categoryNavOrder('only', [t('only', true, 1)])).toEqual(['only']);
  });
});
