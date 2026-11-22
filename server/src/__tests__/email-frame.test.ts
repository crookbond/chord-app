import { describe, expect, it } from 'vitest';

import {
  EMAIL_FRAME_MAX_HEIGHT,
  EMAIL_FRAME_SANDBOX,
  isOpenableEmailLink,
  parseEmailFrameMessage,
} from '@chord/kernel';

describe('parseEmailFrameMessage', () => {
  it('reads the probe height, rounded up', () => {
    expect(parseEmailFrameMessage({ chordEmail: 'height', height: 812.4 })).toEqual({
      kind: 'height',
      height: 813,
    });
  });

  it('caps a height no email should need', () => {
    expect(parseEmailFrameMessage({ chordEmail: 'height', height: 1e9 })).toEqual({
      kind: 'height',
      height: EMAIL_FRAME_MAX_HEIGHT,
    });
  });

  it('refuses a height that is not a positive number', () => {
    for (const height of [0, -5, NaN, Infinity, '500', null, undefined]) {
      expect(parseEmailFrameMessage({ chordEmail: 'height', height })).toBeNull();
    }
  });

  it('passes on a link the app may open', () => {
    expect(parseEmailFrameMessage({ chordEmail: 'open', url: 'https://school.example/form' })).toEqual({
      kind: 'open',
      url: 'https://school.example/form',
    });
    expect(parseEmailFrameMessage({ chordEmail: 'open', url: 'mailto:a@b.example' })?.kind).toBe('open');
  });

  it('never passes on a link to anything but http(s) or mailto', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'chord://settings',
      'blob:https://chordapp.ai/x',
      'not a url',
      '',
      'https://x.example/' + 'a'.repeat(9000),
      42,
    ]) {
      expect(parseEmailFrameMessage({ chordEmail: 'open', url })).toBeNull();
    }
  });

  it("ignores every other message, including the file viewer's", () => {
    for (const data of [
      null,
      undefined,
      'height:500',
      500,
      [],
      { chordViewer: 'open:https://x.example' },
      { chordEmail: 'navigate', url: 'https://x.example' },
      { chordEmail: 'eval', code: '1' },
    ]) {
      expect(parseEmailFrameMessage(data)).toBeNull();
    }
  });
});

describe('isOpenableEmailLink', () => {
  it('takes http, https and mailto only', () => {
    expect(isOpenableEmailLink('http://a.example')).toBe(true);
    expect(isOpenableEmailLink('https://a.example')).toBe(true);
    expect(isOpenableEmailLink('mailto:x@a.example')).toBe(true);
    expect(isOpenableEmailLink('cid:image001')).toBe(false);
    expect(isOpenableEmailLink('vbscript:x')).toBe(false);
  });
});

describe('EMAIL_FRAME_SANDBOX', () => {
  // Same-origin would give the email frame the app's origin: its storage,
  // cookies and DOM, which is what the frame is there to take away.
  it('runs the probe and never shares the app origin', () => {
    const flags = EMAIL_FRAME_SANDBOX.split(/\s+/);
    expect(flags).toContain('allow-scripts');
    expect(flags).not.toContain('allow-same-origin');
    expect(flags).not.toContain('allow-top-navigation');
    expect(flags).not.toContain('allow-forms');
  });
});
