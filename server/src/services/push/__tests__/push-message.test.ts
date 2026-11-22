import { describe, expect, it } from 'vitest';

import { ANDROID_PUSH_CHANNEL, buildPushMessages } from '../expo.service.js';

describe('buildPushMessages', () => {
  it("addresses the app's Android channel at high priority, for every device", () => {
    const tokens = ['ExponentPushToken[a]', 'ExponentPushToken[b]'];
    const messages = buildPushMessages(tokens, { title: 'Ann', body: 'Dinner at 7?', data: { groupId: 'g1' } });
    expect(messages).toEqual(
      tokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        channelId: ANDROID_PUSH_CHANNEL,
        title: 'Ann',
        body: 'Dinner at 7?',
        data: { groupId: 'g1' },
      })),
    );
  });

  it('names the channel the app creates', () => {
    // mobile/src/push.ts creates exactly this channel; a push to a channel the
    // phone does not have is not shown on Android 8+.
    expect(ANDROID_PUSH_CHANNEL).toBe('default');
  });
});
