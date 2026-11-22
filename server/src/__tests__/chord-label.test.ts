import { chordImapKeyword, chordProviderLabel } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

describe('chord-label helpers', () => {
  it('builds Chord/ display tags', () => {
    expect(chordProviderLabel('  Family ')).toBe('Chord/Family');
  });

  it('builds IMAP-safe keywords', () => {
    expect(chordImapKeyword('Family')).toMatch(/^Chord_[A-Za-z0-9_-]+$/);
    expect(chordImapKeyword('a b')).not.toMatch(/\s/);
  });
});
