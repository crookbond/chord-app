/**
 * Chat posts from several writers at once (ADR 0311 send queue): a queued
 * message retried in parallel with one Idempotency-Key posts once, and two
 * people or two devices posting together both land.
 */
import { API } from '@chord/kernel';

import { Checks, call, newKey, pair, signIn, tally, together, type Scenario } from './harness.js';

export const chatSend: Scenario = {
  name: 'chat-send',
  about: 'chat messages sent at the same moment, and one queued message retried at once',
  async run(checks: Checks) {
    const phone = await signIn('conc-alex');
    const laptop = await signIn('conc-alex');
    const sam = await signIn('conc-sam');

    const group = await call(phone, 'POST', API.groups, { name: `Concurrency chat ${Date.now()}`, kind: 'group' });
    if (group.status >= 300) throw new Error(`create group: ${group.status} ${JSON.stringify(group.body)}`);
    const groupId = group.body.id as string;
    try {
      await call(sam, 'POST', API.groupJoin, { inviteCode: group.body.inviteCode });
      const post = (token: string, body: string, key = newKey()) => call(token, 'POST', API.groupMessages(groupId), { body }, key);
      const count = async (body: string) =>
        ((await call(phone, 'GET', API.groupMessages(groupId))).body as any[]).filter((m) => m.body === body).length;

      const key = newKey();
      const retries = await together(10, () => post(phone, 'running late, start without me', key));
      const statuses = tally(retries.map((r) => r.status));
      const posted = await count('running late, start without me');
      checks.expect('one message retried 10 times with one key - posted once', posted === 1, `${JSON.stringify(statuses)} -> ${posted}`);

      for (const [who, second] of [['two people', sam], ['one person, two devices', laptop]] as const) {
        for (const gap of [0, 10, 100]) {
          const [a, b] = await pair(gap, () => post(phone, `${who} ${gap} a`), () => post(second, `${who} ${gap} b`));
          const both = (await count(`${who} ${gap} a`)) === 1 && (await count(`${who} ${gap} b`)) === 1;
          checks.expect(`${who}, ${gap} ms: both messages land once`, both && a.status < 300 && b.status < 300, `${a.status}|${b.status}`);
        }
      }
    } finally {
      await call(phone, 'DELETE', API.group(groupId));
    }
  },
};
