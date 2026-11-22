/**
 * Chord (in-app) renderer is the identity-prose renderer: the mobile +
 * web clients consume cards STRUCTURALLY via `SSE.botCard`, so the
 * persisted/bridged body for the in-app surface is the assistant prose
 * UNCHANGED. Cards must NOT be flattened into the body — that would
 * produce duplicate rendering in the app (a structured card AND the
 * text-flattened line).
 *
 * These tests pin that contract. A future change that wants the body
 * to include card lines for Chord must update this test deliberately.
 */
import { describe, expect, it } from 'vitest';

import { renderChord } from '@/services/connectors/renderers/chord.renderer.js';
import { renderFor } from '@/services/connectors/renderers/index.js';

describe('renderChord', () => {
  it('passes prose through unchanged when there are no cards', () => {
    expect(renderChord({ body: 'hello', cards: [] })).toEqual({ text: 'hello' });
  });

  it('does NOT append card lines to the body', () => {
    const out = renderChord({
      body: 'Saved.',
      cards: [
        {
          kind: 'save',
          title: 'Instagram reel',
          url: 'https://instagram.com/reel/x',
        },
      ],
    });
    expect(out).toEqual({ text: 'Saved.' });
    expect(out.text).not.toContain('Instagram reel');
    expect(out.text).not.toContain('instagram.com');
  });

  it('renders an empty body verbatim even when cards are present', () => {
    expect(
      renderChord({
        body: '',
        cards: [{ kind: 'action', title: 'Open in Maps', url: 'https://x' }],
      }),
    ).toEqual({ text: '' });
  });
});

describe('renderFor dispatcher — Commit B: chord routes to chord renderer', () => {
  it('chord platform produces prose-only text', () => {
    const out = renderFor('chord', {
      body: 'Saved.',
      cards: [{ kind: 'save', title: 'Reel', url: 'https://example.com' }],
    });
    expect(out).toEqual({ text: 'Saved.' });
  });

  it('plain platform still flattens card lines (unchanged from Commit A)', () => {
    const out = renderFor('plain', {
      body: 'Saved.',
      cards: [{ kind: 'save', title: 'Reel', url: 'https://example.com' }],
    });
    expect(out.text).toBe('Saved.\n\nReel: https://example.com');
  });

  it('telegram/slack/discord still route to plain (Commit C pending)', () => {
    const input = {
      body: 'Saved.',
      cards: [
        { kind: 'save' as const, title: 'Reel', url: 'https://example.com' },
      ],
    };
    const expected = 'Saved.\n\nReel: https://example.com';
    expect(renderFor('telegram', input).text).toBe(expected);
    expect(renderFor('slack', input).text).toBe(expected);
    expect(renderFor('discord', input).text).toBe(expected);
  });
});
