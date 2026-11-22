/**
 * ADR 0107 trades mailbox management away, and that trade only holds if getting
 * to the provider is one tap. What these pin is the honesty half: a link is
 * emitted only when we know where it goes, and a mailbox-root link never claims
 * to be a thread link.
 */
import { describe, expect, it } from 'vitest';

import { providerThreadLink } from '@chord/kernel';

describe('providerThreadLink', () => {
  it('deep-links a Gmail thread, and names the profile', () => {
    const link = providerThreadLink({
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      nativeThreadId: 't_abc123',
    });
    expect(link).not.toBeNull();
    expect(link!.exact).toBe(true);
    expect(link!.label).toBe('Open in Gmail');
    expect(link!.url).toContain('#all/t_abc123');
    // Without authuser a second mailbox opens the FIRST signed-in inbox.
    expect(link!.url).toContain('authuser=me%40gmail.com');
  });

  it('reaches archived mail — the one place Chord itself cannot look', () => {
    const link = providerThreadLink({
      provider: 'gmail',
      emailAddress: null,
      nativeThreadId: 't_x',
    });
    // `#all/` rather than `#inbox/`: an archived thread is exactly what the user
    // is most likely to be chasing when they leave for Gmail.
    expect(link!.url).toContain('/mail/u/0/#all/');
  });

  it('returns null for Gmail with no thread id rather than a mailbox guess', () => {
    expect(
      providerThreadLink({ provider: 'gmail', emailAddress: 'a@b.com', nativeThreadId: null }),
    ).toBeNull();
  });

  it('marks Outlook inexact — OWA deep links are keyed differently', () => {
    const link = providerThreadLink({
      provider: 'outlook',
      emailAddress: 'me@work.com',
      nativeThreadId: 'conv_1',
    });
    expect(link!.exact).toBe(false);
    expect(link!.label).toBe('Open in Outlook');
  });

  it('names the webmail for known IMAP presets, inexactly', () => {
    for (const [preset, label] of [
      ['yahoo', 'Open Yahoo Mail'],
      ['aol', 'Open AOL Mail'],
      ['icloud', 'Open iCloud Mail'],
    ] as const) {
      const link = providerThreadLink({
        provider: 'imap',
        emailAddress: 'me@example.com',
        nativeThreadId: '12',
        presetKey: preset,
      });
      expect(link, preset).not.toBeNull();
      expect(link!.label).toBe(label);
      expect(link!.exact).toBe(false);
    }
  });

  it('gives a custom IMAP host nothing — a guessed webmail is worse than no button', () => {
    expect(
      providerThreadLink({
        provider: 'imap',
        emailAddress: 'me@self-hosted.example',
        nativeThreadId: '12',
        presetKey: 'custom',
      }),
    ).toBeNull();
    expect(
      providerThreadLink({
        provider: 'imap',
        emailAddress: 'me@self-hosted.example',
        nativeThreadId: '12',
        presetKey: null,
      }),
    ).toBeNull();
  });
});
