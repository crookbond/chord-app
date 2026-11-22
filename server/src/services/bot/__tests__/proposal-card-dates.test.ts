/**
 * The card a staged suggestion carries (app chat, WhatsApp, Telegram) reads
 * its date as a date, not the ISO string the tool call holds
 * (kernel/src/suggestion-when.ts). Reported values from a demo account.
 */
import { describe, expect, it } from 'vitest';

import { proposeCardFor } from '@/services/bot/executor.js';

const card = (name: string, args: Record<string, unknown>) =>
  proposeCardFor({ name, args } as never, 'America/New_York').card;

describe('proposal card dates', () => {
  it('a to-do card says the due day', () => {
    expect(card('create_task', { title: 'Pay water bill ($84.20)', dueAt: '2026-11-28T09:00:00-05:00' }).meta).toBe(
      'due Sat, Nov 28',
    );
  });

  it('an event card says the day and time', () => {
    const c = card('create_event', {
      title: 'Dentist cleaning',
      startsAt: '2026-11-25T15:30:00-05:00',
      location: '120 Main St',
    });
    expect(c.meta).toBe('Wed, Nov 25, 3:30 PM');
    expect(c.subtitle).toBe('120 Main St');
  });

  it('a flight leg card keeps the ticket clock, a stay its dates', () => {
    expect(
      card('add_travel_leg', { origin: 'DEL', destination: 'JFK', departAt: '2026-12-03T01:50:00+05:30' }).meta,
    ).toBe('Thu, Dec 3, 1:50 AM');
    expect(
      card('add_accommodation', { propertyName: 'Inn', checkinDate: '2026-12-03', checkoutDate: '2026-12-06' }).meta,
    ).toBe('Thu, Dec 3 → Sun, Dec 6');
  });
});
