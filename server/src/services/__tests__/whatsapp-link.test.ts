/**
 * ADR 0253 - the app turns a configured WhatsApp number into a tappable link.
 * Kernel has no harness of its own, so its tests live with the server's.
 */
import { describe, expect, it } from 'vitest';

import { formatWhatsappNumber, whatsappChatUrl } from '@chord/kernel';

import { env } from '@/config/env.js';
import { publicWhatsappNumber } from '@/services/phone/normalize.js';

describe('whatsappChatUrl', () => {
  it('builds a wa.me link from digits only, with the first message encoded', () => {
    expect(whatsappChatUrl('+15555550142')).toBe('https://wa.me/15555550142');
    expect(whatsappChatUrl('+15555550142', 'Hi Chord')).toBe('https://wa.me/15555550142?text=Hi%20Chord');
  });

  it('returns null rather than a broken link when there is no usable number', () => {
    expect(whatsappChatUrl(null)).toBeNull();
    expect(whatsappChatUrl('')).toBeNull();
    expect(whatsappChatUrl('+1 77')).toBeNull();
    expect(whatsappChatUrl('+1234567890123456789')).toBeNull();
  });

  it('does not care which number it is: the link follows the config', () => {
    // The business number changing later is a config change, not a code one.
    expect(whatsappChatUrl('+447700900123')).toBe('https://wa.me/447700900123');
  });
});

describe('formatWhatsappNumber', () => {
  it('groups a North American number and leaves others as given', () => {
    expect(formatWhatsappNumber('+15555550142')).toBe('+1 555 555 0142');
    expect(formatWhatsappNumber('+447700900123')).toBe('+447700900123');
  });
});

describe('publicWhatsappNumber (server config)', () => {
  const original = env.WHATSAPP_PUBLIC_NUMBER;
  const set = (v: string) => ((env as { WHATSAPP_PUBLIC_NUMBER: string }).WHATSAPP_PUBLIC_NUMBER = v);

  it('is null until a number is configured, and ignores a malformed one', () => {
    try {
      set('');
      expect(publicWhatsappNumber()).toBeNull();
      set('not a number');
      expect(publicWhatsappNumber()).toBeNull();
      set('+1 (555) 555-0142');
      expect(publicWhatsappNumber()).toBe('+15555550142');
    } finally {
      set(original);
    }
  });
});
