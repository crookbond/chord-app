/**
 * `/chord <text>` is the Telegram workaround for the `@`-autocomplete
 * dropdown that filters strictly by registered bot @username and
 * therefore won't surface a `@chord` text alias. The inbound pipeline
 * rewrites `/chord <text>` into `@chord <text>` and marks the message
 * mentionsBot=true so the rest of the bot path treats it identically
 * to a native @-mention. The bare `/chord` (no remainder) becomes
 * `@chord` and gets a generic reply.
 */
import { describe, expect, it } from 'vitest';

import { buildSlashCommandRegex } from '@chord/kernel';

describe('buildSlashCommandRegex', () => {
  const re = () => buildSlashCommandRegex(['chord']);

  it('matches /chord followed by text and captures the remainder', () => {
    const m = '/chord add bread to costco list'.match(re());
    expect(m).not.toBeNull();
    expect(m![1]).toBe('add bread to costco list');
  });

  it('matches the bare /chord with no remainder', () => {
    const m = '/chord'.match(re());
    expect(m).not.toBeNull();
    expect(m![1]).toBeUndefined();
  });

  it('accepts Telegram-style @bot-suffix disambiguator', () => {
    const m = '/chord@my_chord_bot remind me to call vet'.match(re());
    expect(m).not.toBeNull();
    expect(m![1]).toBe('remind me to call vet');
  });

  it('matches the configured alias even when not the default', () => {
    const m = '/chord-beta hello'.match(buildSlashCommandRegex(['chord-beta']));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('hello');
  });

  it('does not match an unrelated slash command', () => {
    expect('/start hello'.match(re())).toBeNull();
    expect('/help'.match(re())).toBeNull();
  });

  it('does not match `@chord …` (handled by the regular mention path)', () => {
    expect('@chord do x'.match(re())).toBeNull();
  });

  it('is case-insensitive on the alias', () => {
    expect('/CHORD ping'.match(re())).not.toBeNull();
    expect('/Chord ping'.match(re())).not.toBeNull();
  });

  it('captures multi-line remainder', () => {
    const m = '/chord remind me to:\n - buy milk\n - water plants'.match(re());
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/buy milk/);
  });
});
