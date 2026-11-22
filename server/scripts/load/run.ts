/**
 * Load driver: N users and N groups, every user acting at once.
 *
 *   tsx scripts/load/run.ts --users 500 --levels 20000,8000,3000,1000 --level-seconds 90
 *
 * Talks to scripts/load/server.ts over HTTP only (plus its /__load control
 * plane), so it exercises the same routes the apps do. Each level is a mean
 * think time per user; a smaller number is more load. Per level it records
 * client-side latency per operation, SSE fan-out latency, bot-turn timing, and
 * pulls the server's own route / SQL / event-loop report, so a slow number can
 * be traced to where the time went.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { API } from '@chord/kernel';

import { cpuBetween, snapshotCpu } from './cpu.js';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1]! : d;
};
const has = (f: string) => argv.includes(f);
const USERS = Number(arg('--users', '500'));
const BASE = arg('--base', 'http://127.0.0.1:4002');
const LEVELS = arg('--levels', '20000,8000,3000,1000').split(',').map(Number);
const LEVEL_MS = Number(arg('--level-seconds', '90')) * 1000;
const OUT = arg('--out', path.resolve(process.cwd(), '../logs-load/out'));
const PROFILE_LEVEL = Number(arg('--profile-level', '-1')); // index into LEVELS
const SETUP_CONCURRENCY = Number(arg('--setup-concurrency', '40'));
const MIX_ONLY = arg('--only', '');
const MEGA = Number(arg('--mega', '0'));
fs.mkdirSync(OUT, { recursive: true });

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const expo = (mean: number) => -Math.log(1 - Math.random()) * mean;
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;

// ── stats ────────────────────────────────────────────────────────────────────
class Series {
  v: number[] = [];
  errors: Record<string, number> = {};
  add(ms: number) {
    this.v.push(ms);
  }
  err(k: string) {
    this.errors[k] = (this.errors[k] ?? 0) + 1;
  }
  summary() {
    const s = [...this.v].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
    const r = (n: number) => Math.round(n * 10) / 10;
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      n: s.length,
      errors: Object.values(this.errors).reduce((a, b) => a + b, 0),
      errorKinds: this.errors,
      avg: r(s.length ? sum / s.length : 0),
      p50: r(q(0.5)),
      p95: r(q(0.95)),
      p99: r(q(0.99)),
      max: r(s.length ? s[s.length - 1]! : 0),
    };
  }
}

let ops = new Map<string, Series>();
const series = (name: string) => {
  let s = ops.get(name);
  if (!s) ops.set(name, (s = new Series()));
  return s;
};

// ── http ─────────────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function call<T = unknown>(
  op: string,
  method: string,
  p: string,
  token: string | null,
  body?: unknown,
): Promise<T | null> {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-chord-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) {
      series(op).err(`http_${res.status}`);
      if (!lastErrorSample.has(op + res.status)) {
        lastErrorSample.set(op + res.status, `${method} ${p} -> ${res.status} ${text.slice(0, 160)}`);
      }
      return null;
    }
    series(op).add(ms);
    return text ? (JSON.parse(text) as T) : (null as T);
  } catch (err) {
    series(op).err(`net_${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name}`);
    return null;
  }
}
const lastErrorSample = new Map<string, string>();

// ── SSE ──────────────────────────────────────────────────────────────────────
interface SseHandle {
  close(): void;
}
let sseOpen = 0;
let sseDropped = 0;

async function openSse(p: string, token: string, onEvent: (ev: string, data: string) => void): Promise<SseHandle> {
  const ac = new AbortController();
  const t0 = performance.now();
  const res = await fetch(BASE + p, { headers: { 'x-chord-token': token }, signal: ac.signal });
  if (!res.ok || !res.body) throw new HttpError(res.status, `sse ${p}`);
  series('sse_connect').add(performance.now() - t0);
  sseOpen += 1;
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (ev && data !== undefined) onEvent(ev, data);
        }
      }
    } catch {
      /* aborted or dropped */
    }
    sseOpen -= 1;
    if (!ac.signal.aborted) sseDropped += 1;
  })();
  return { close: () => ac.abort() };
}

// ── fan-out + bot-turn tracking (fed by every SSE stream) ────────────────────
const MARK = /\[#L:(\d+(?:\.\d+)?):(\w+)\]/;
const msgMarker = new Map<string, string>(); // messageId -> marker
const marker0 = new Map<string, number>(); // marker -> client send time
const botTrigger = new Map<string, string>(); // bot messageId -> trigger id
const botSeen = new Map<string, { start?: number; token?: number; done?: boolean }>();

function onGroupEvent(listener: string, ev: string, raw: string, tag = '') {
  const t = now();
  if (tag === 'mega') return onMegaEvent(ev, raw, t);
  if (ev === 'message') {
    let m: { id: string; body?: string; senderId: string | null };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const mk = m.body ? MARK.exec(m.body) : null;
    if (mk && m.senderId) {
      const sent = Number(mk[1]);
      msgMarker.set(m.id, mk[0]);
      marker0.set(mk[0], sent);
      series('sse_fanout').add(t - sent);
    }
    return;
  }
  if (ev === 'bot.start') {
    const s = JSON.parse(raw) as { messageId: string; triggerMessageId: string };
    if (botTrigger.has(s.messageId)) return;
    botTrigger.set(s.messageId, s.triggerMessageId);
    botSeen.set(s.messageId, { start: t });
    const mk = msgMarker.get(s.triggerMessageId);
    const t0 = mk ? marker0.get(mk) : undefined;
    if (t0) series('bot_to_start').add(t - t0);
    return;
  }
  if (ev === 'bot.token') {
    const s = JSON.parse(raw) as { messageId: string };
    const b = botSeen.get(s.messageId);
    if (b && b.token === undefined) {
      b.token = t;
      const mk = msgMarker.get(botTrigger.get(s.messageId) ?? '');
      const t0 = mk ? marker0.get(mk) : undefined;
      if (t0) series('bot_to_first_token').add(t - t0);
    }
    return;
  }
  if (ev === 'bot.done' || ev === 'bot.receipt') {
    const s = JSON.parse(raw) as { messageId: string };
    const b = botSeen.get(s.messageId);
    if (b && !b.done) {
      b.done = true;
      const mk = msgMarker.get(botTrigger.get(s.messageId) ?? '');
      const t0 = mk ? marker0.get(mk) : undefined;
      if (t0) series('bot_turn_total').add(t - t0);
    }
  }
}

// ── the world ────────────────────────────────────────────────────────────────
interface User {
  i: number;
  id: string;
  token: string;
  name: string;
  ownGroup: string;
  groups: string[]; // shared groups this user is in (includes ownGroup)
  personal: string;
  lists: Map<string, string>;
  tasks: string[];
  events: string[];
  seenThreads: string[];
}
const users: User[] = [];
let botAlias = 'chord';
let seq = 0;
const stamp = () => `[#L:${now().toFixed(1)}:${(++seq).toString(36)}]`;

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

async function setup() {
  const h = await fetch(BASE + API.health).then((r) => r.json() as Promise<{ botAlias?: string }>);
  botAlias = h.botAlias ?? 'chord';
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const r = await fn();
    console.log(`[setup] ${name}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return r;
  };

  await phase(`login ${USERS} users`, async () => {
    const rows = await mapLimit(Array.from({ length: USERS }, (_, i) => i), SETUP_CONCURRENCY, async (i) => {
      const r = await call<{ user: { id: string }; token: string }>('setup_login', 'POST', API.session, null, {
        username: `load_${i}`,
        displayName: `Load User ${i}`,
      });
      return r ? { i, id: r.user.id, token: r.token } : null;
    });
    for (const r of rows) {
      if (!r) throw new Error('login failed; aborting');
      users.push({
        i: r.i,
        id: r.id,
        token: r.token,
        name: `Load User ${r.i}`,
        ownGroup: '',
        groups: [],
        personal: '',
        lists: new Map(),
        tasks: [],
        events: [],
        seenThreads: [],
      });
    }
  });

  await phase('connect mock mail + calendar', async () => {
    await fetch(BASE + '/__load/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds: users.map((u) => u.id) }),
    });
  });

  await phase(`create ${USERS} groups`, async () => {
    const invite = new Map<number, string>();
    await mapLimit(users, SETUP_CONCURRENCY, async (u) => {
      const g = await call<{ id: string; inviteCode: string }>('setup_group_create', 'POST', API.groups, u.token, {
        name: `Group ${u.i}`,
        kind: 'group',
      });
      if (!g) throw new Error('group create failed');
      u.ownGroup = g.id;
      u.groups.push(g.id);
      invite.set(u.i, g.inviteCode);
    });
    // Group g: owner g plus the next four users (mod N). Every user ends up in 5.
    const joins: { u: User; code: string; gid: string }[] = [];
    for (const owner of users) {
      for (let k = 1; k <= 4; k++) {
        joins.push({ u: users[(owner.i + k) % USERS]!, code: invite.get(owner.i)!, gid: owner.ownGroup });
      }
    }
    await phase(`join ${joins.length} memberships`, () =>
      mapLimit(joins, SETUP_CONCURRENCY, async (j) => {
        const r = await call('setup_group_join', 'POST', API.groupJoin, j.u.token, { inviteCode: j.code });
        if (r) j.u.groups.push(j.gid);
      }),
    );
  });

  await phase('discover personal groups', () =>
    mapLimit(users, SETUP_CONCURRENCY, async (u) => {
      const gs = await call<{ id: string; kind: string }[]>('setup_list_groups', 'GET', API.groups, u.token);
      u.personal = gs?.find((g) => g.kind === 'personal')?.id ?? '';
    }),
  );

  await phase('open SSE streams (me + own + personal + one more group)', async () => {
    await mapLimit(users, SETUP_CONCURRENCY, async (u) => {
      const other = u.groups.find((g) => g !== u.ownGroup) ?? u.ownGroup;
      const targets = [...new Set([u.ownGroup, u.personal, other])];
      await openSse(API.meStream, u.token, () => undefined);
      for (const g of targets) {
        if (!g) continue;
        await openSse(API.groupStream(g), u.token, (ev, data) => onGroupEvent(u.id + g, ev, data));
      }
    });
    console.log(`[setup] SSE open: ${sseOpen}`);
  });

  await phase('first mail sync (backfill) for every user', async () => {
    await mapLimit(users, SETUP_CONCURRENCY, async (u) => {
      await fetch(BASE + '/__load/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: u.id, n: 12 }),
      });
      await call('mail_first_sync', 'POST', API.meEmailSync, u.token, {});
    });
  });
}

// ── operations ───────────────────────────────────────────────────────────────
const BOT_PROMPTS = [
  'add to costco list: milk bread sunscreen',
  'book a rental car for the trip',
  'save https://example.com/recipe/${n}',
  'we should have a potluck dinner next week',
  'add restaurant Fred',
  'what is on my list',
];
const CHATTER = [
  'anyone free this weekend?',
  'running 10 minutes late',
  'thanks!',
  'did you see the school email',
  'can someone pick up the kids at 3',
  'dinner at 7?',
];

type Op = { name: string; weight: number; run: (u: User) => Promise<void> };

const OPS: Op[] = [
  {
    name: 'chat_msg',
    weight: 30,
    run: async (u) => {
      const g = pick(u.groups);
      await call('chat_msg', 'POST', API.groupMessages(g), u.token, {
        body: `${pick(CHATTER)} ${stamp()}`,
        tz: 'America/Los_Angeles',
      });
    },
  },
  {
    name: 'bot_msg',
    weight: 8,
    run: async (u) => {
      const inPersonal = Math.random() < 0.5 && u.personal;
      const g = inPersonal ? u.personal : u.ownGroup;
      const text = pick(BOT_PROMPTS).replace('${n}', String(seq));
      await call('bot_msg_post', 'POST', API.groupMessages(g), u.token, {
        body: `${inPersonal ? '' : `@${botAlias} `}${text} ${stamp()}`,
        tz: 'America/Los_Angeles',
      });
    },
  },
  {
    name: 'task_add',
    weight: 8,
    run: async (u) => {
      const t = await call<{ id: string }>('task_add', 'POST', API.groupTasks(pick(u.groups)), u.token, {
        title: `Load task ${++seq}`,
      });
      if (t) {
        u.tasks.push(t.id);
        if (u.tasks.length > 30) u.tasks.shift();
      }
    },
  },
  {
    name: 'task_done',
    weight: 4,
    run: async (u) => {
      const id = u.tasks.shift();
      if (id) await call('task_done', 'PATCH', API.task(id), u.token, { status: 'done' });
    },
  },
  {
    name: 'todo_item_add',
    weight: 6,
    run: async (u) => {
      const g = pick(u.groups);
      let listId = u.lists.get(g);
      if (!listId) {
        const l = await call<{ id: string }>('todo_list_create', 'POST', API.groupLists(g), u.token, { name: 'Todo' });
        if (!l) return;
        listId = l.id;
        u.lists.set(g, listId);
      }
      await call('todo_item_add', 'POST', API.listItems(listId), u.token, { text: `Item ${++seq}` });
    },
  },
  {
    name: 'save_add',
    weight: 5,
    run: async (u) => {
      await call('save_add', 'POST', API.groupSaves(pick(u.groups)), u.token, {
        kind: 'link',
        title: `Save ${++seq}`,
        url: `https://example.com/s/${seq}`,
      });
    },
  },
  {
    name: 'event_add',
    weight: 6,
    run: async (u) => {
      const start = new Date(Date.now() + (1 + Math.floor(Math.random() * 20)) * 86_400_000);
      start.setUTCHours(15 + Math.floor(Math.random() * 6), 0, 0, 0);
      const e = await call<{ id: string }>('event_add', 'POST', API.groupEvents(pick(u.groups)), u.token, {
        title: `Load event ${++seq}`,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      });
      if (e) {
        u.events.push(e.id);
        if (u.events.length > 30) u.events.shift();
      }
    },
  },
  {
    name: 'event_del',
    weight: 3,
    run: async (u) => {
      const id = u.events.shift();
      if (id) await call('event_del', 'DELETE', API.event(id), u.token);
    },
  },
  {
    name: 'hub_read',
    weight: 8,
    run: async (u) => {
      await call('hub_read', 'GET', pick([API.meTasks, API.meLists, API.meSaves]), u.token);
    },
  },
  {
    name: 'calendar_view',
    weight: 4,
    run: async (u) => {
      await call('calendar_view', 'GET', API.meEvents, u.token);
    },
  },
  {
    name: 'chat_open',
    weight: 6,
    run: async (u) => {
      const g = pick(u.groups);
      await call('chat_open_messages', 'GET', API.groupMessages(g), u.token);
      await call('chat_open_read', 'POST', API.groupRead(g), u.token, {});
    },
  },
  {
    name: 'app_open',
    weight: 2,
    run: async (u) => {
      await Promise.all([
        call('app_open_me', 'GET', API.me, u.token),
        call('app_open_groups', 'GET', API.groups, u.token),
        call('app_open_email_status', 'GET', API.meEmailStatus, u.token),
      ]);
    },
  },
  {
    name: 'mail_arrive_sync',
    weight: 8,
    run: async (u) => {
      await fetch(BASE + '/__load/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: u.id, n: 1 + Math.floor(Math.random() * 3) }),
      });
      await call('mail_sync', 'POST', API.meEmailSync, u.token, {});
    },
  },
  {
    name: 'mail_browse',
    weight: 8,
    run: async (u) => {
      const which = Math.random();
      if (which < 0.4) {
        const r = await call<{ threads?: { id: string }[] } | { id: string }[]>(
          'mail_threads',
          'GET',
          `${API.meEmailThreads}?mode=traditional`,
          u.token,
        );
        const list = Array.isArray(r) ? r : (r?.threads ?? []);
        u.seenThreads = list.slice(0, 20).map((t) => t.id);
      } else if (which < 0.6) {
        await call('mail_tiles', 'GET', `${API.meEmailTiles}?deep=1`, u.token);
      } else if (which < 0.8) {
        await call('mail_decisions', 'GET', API.meEmailDecisions, u.token);
      } else if (u.seenThreads.length) {
        await call('mail_thread_open', 'GET', API.meEmailThread(pick(u.seenThreads)), u.token);
      } else {
        await call('mail_threads', 'GET', `${API.meEmailThreads}?mode=traditional`, u.token);
      }
    },
  },
  {
    name: 'search',
    weight: 4,
    run: async (u) => {
      await call('search', 'GET', `${API.meSearch}?q=${encodeURIComponent(pick(['dinner', 'permission slip', 'order', 'costco', 'flight']))}`, u.token);
    },
  },
];

function chooser(): () => Op {
  const list = MIX_ONLY ? OPS.filter((o) => MIX_ONLY.split(',').includes(o.name)) : OPS;
  const total = list.reduce((n, o) => n + o.weight, 0);
  return () => {
    let r = Math.random() * total;
    return list.find((o) => (r -= o.weight) < 0) ?? list[0]!;
  };
}

// ── mega group: one group, many members, everyone listening ──────────────────
// Real families are small, but school and club groups are not, and two things
// in the server scale with members squared: an event creates one copy per member
// and each copy is broadcast to the whole group channel, so N members means N
// broadcasts each written to N sockets.
const EMARK = /\[#E:(\d+(?:\.\d+)?):(\w+)\]/;

function onMegaEvent(ev: string, raw: string, t: number) {
  if (ev === 'message') {
    let m: { body?: string; senderId: string | null };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const mk = m.body ? MARK.exec(m.body) : null;
    if (mk && m.senderId) series('mega_msg_delivery').add(t - Number(mk[1]));
    return;
  }
  if (ev === 'event.created' || ev === 'event.deleted') {
    let e: { title?: string };
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    const mk = e.title ? EMARK.exec(e.title) : null;
    if (mk) series(ev === 'event.created' ? 'mega_event_delivery' : 'mega_event_del_delivery').add(t - Number(mk[1]));
    return;
  }
  if (ev === 'task.created') series('mega_task_delivery').add(0);
}

async function megaPhase(n: number) {
  console.log(`\n[mega] one group of ${n} members, all listening`);
  ops = new Map();
  await control('/reset', 'POST');
  const members = users.slice(0, n);
  const owner = members[0]!;
  const g = await call<{ id: string; inviteCode: string }>('mega_group_create', 'POST', API.groups, owner.token, {
    name: 'Mega group',
    kind: 'group',
  });
  if (!g) throw new Error('mega group create failed');
  await mapLimit(members.slice(1), 20, async (u) => {
    await call('mega_join', 'POST', API.groupJoin, u.token, { inviteCode: g.inviteCode });
  });
  await mapLimit(members, 20, async (u) => {
    await openSse(API.groupStream(g.id), u.token, (ev, data) => onGroupEvent(u.id, ev, data, 'mega'));
  });
  console.log(`[mega] ${sseOpen} SSE open, group ${g.id}`);
  await sleep(1000);

  // Chat: 30 messages from random members; every member's stream should see each.
  for (let i = 0; i < 30; i++) {
    const u = pick(members);
    await call('mega_chat_msg', 'POST', API.groupMessages(g.id), u.token, {
      body: `mega hello ${i} ${stamp()}`,
      tz: 'America/Los_Angeles',
    });
    await sleep(150);
  }
  await sleep(2000);

  // Events: the owner creates 8, then removes them. Each copy is broadcast to the group.
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const start = new Date(Date.now() + (3 + i) * 86_400_000);
    start.setUTCHours(17, 0, 0, 0);
    const t0 = now();
    const e = await call<{ id: string }>('mega_event_add', 'POST', API.groupEvents(g.id), owner.token, {
      title: `Mega event ${i} [#E:${t0.toFixed(1)}:${i}]`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    if (e) ids.push(e.id);
    await sleep(1500);
  }
  await sleep(3000);
  for (const id of ids) {
    await call('mega_event_del', 'DELETE', API.event(id), owner.token);
    await sleep(1000);
  }

  // Tasks: a fan-out of catch-up assignments per member.
  for (let i = 0; i < 10; i++) {
    await call('mega_task_add', 'POST', API.groupTasks(g.id), owner.token, { title: `Mega task ${i}` });
    await sleep(300);
  }
  await sleep(6000);

  const server = await control<Record<string, unknown>>('/report');
  const summary: Record<string, ReturnType<Series['summary']>> = {};
  for (const [k, sr] of ops) summary[k] = sr.summary();
  fs.writeFileSync(path.join(OUT, 'mega.json'), JSON.stringify({ members: n, client: summary, server }, null, 1));
  printLevel({ achievedOpsPerSec: 0, client: summary, server });
}

// ── levels ───────────────────────────────────────────────────────────────────
async function control<T>(p: string, method = 'GET'): Promise<T> {
  const res = await fetch(BASE + '/__load' + p, { method });
  return (await res.json()) as T;
}

async function runLevel(thinkMs: number, idx: number, profile: boolean) {
  console.log(`\n[level ${idx}] think=${thinkMs}ms/user, ${LEVEL_MS / 1000}s, target ≈ ${(USERS * 1000 / thinkMs).toFixed(0)} ops/s`);
  ops = new Map();
  lastErrorSample.clear();
  console.log('[level] resetting server stats');
  await control('/reset', 'POST');
  if (profile) {
    console.log('[level] starting server CPU profile');
    await control('/profile/start', 'POST');
    console.log('[level] profile started');
  }
  console.log('[level] cpu snapshot');
  const cpu0 = snapshotCpu();
  console.log('[level] go');
  const driverCpu0 = process.cpuUsage();
  const choose = chooser();
  const stopAt = Date.now() + LEVEL_MS;
  let issued = 0;
  const t0 = performance.now();
  await Promise.all(
    users.map(async (u) => {
      await sleep(Math.random() * Math.min(thinkMs, 5000)); // de-phase
      while (Date.now() < stopAt) {
        issued += 1;
        try {
          await choose().run(u);
        } catch (err) {
          series('driver_error').err(String((err as Error).message).slice(0, 80));
        }
        await sleep(expo(thinkMs));
      }
    }),
  );
  const elapsed = (performance.now() - t0) / 1000;
  const cpu1 = snapshotCpu();
  const driverUsage = process.cpuUsage(driverCpu0);
  // Let in-flight bot turns, syncs and background work finish so their cost is counted.
  await sleep(8000);
  let profileFile: string | undefined;
  if (profile) profileFile = (await control<{ file: string }>('/profile/stop', 'POST')).file;
  const server = await control<Record<string, unknown>>('/report');
  const summary: Record<string, ReturnType<Series['summary']>> = {};
  for (const [k, s] of ops) summary[k] = s.summary();
  const result = {
    thinkMs,
    seconds: elapsed,
    issued,
    achievedOpsPerSec: Math.round((issued / elapsed) * 10) / 10,
    sseOpen,
    sseDropped,
    cpu: {
      ...(cpuBetween(cpu0, cpu1) ?? {}),
      driverCores: Math.round(((driverUsage.user + driverUsage.system) / 1e6 / elapsed) * 100) / 100,
      machineCores: 6,
    },
    client: summary,
    errorSamples: Object.fromEntries(lastErrorSample),
    server,
    profileFile,
  };
  fs.writeFileSync(path.join(OUT, `level-${idx}-think${thinkMs}.json`), JSON.stringify(result, null, 1));
  printLevel(result);
  return result;
}

function printLevel(r: { achievedOpsPerSec: number; client: Record<string, ReturnType<Series['summary']>>; server: Record<string, unknown> }) {
  console.log(`  achieved ${r.achievedOpsPerSec} ops/s   SSE open ${sseOpen} dropped ${sseDropped}`);
  const rows = Object.entries(r.client).sort((a, b) => b[1].p95 - a[1].p95);
  console.log('  op'.padEnd(28) + 'n'.padStart(7) + 'err'.padStart(6) + 'avg'.padStart(9) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'max'.padStart(9));
  for (const [k, s] of rows) {
    console.log(
      `  ${k.padEnd(26)}${String(s.n).padStart(7)}${String(s.errors).padStart(6)}${String(s.avg).padStart(9)}${String(s.p50).padStart(9)}${String(s.p95).padStart(9)}${String(s.p99).padStart(9)}${String(s.max).padStart(9)}`,
    );
  }
  const loop = (r.server as { eventLoopMs?: { p99: number; max: number } }).eventLoopMs;
  const pool = (r.server as { pool?: { waiting: number; total: number } }).pool;
  console.log(`  server event-loop p99 ${loop?.p99}ms max ${loop?.max}ms; pool max total ${pool?.total} max waiting ${pool?.waiting}`);
  const c = (r as { cpu?: Record<string, number>; server: { serverCores?: number } }).cpu;
  const sc = (r.server as { serverCores?: number }).serverCores;
  if (c) console.log(`  cores busy (of ${c.machineCores}): machine ${c.machineCoresBusy}; app server ${sc}, driver ${c.driverCores}, all node ${c.nodeCores}, postgres+other ${c.postgresAndOtherCores}`);
}

// A native abort leaves no message, so keep a trail of how big the driver is.
setInterval(() => {
  const m = process.memoryUsage();
  console.log(
    `[hb] rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB ext=${Math.round(m.external / 1048576)}MB ab=${Math.round(m.arrayBuffers / 1048576)}MB sse=${sseOpen} maps=${msgMarker.size}/${marker0.size}/${botTrigger.size}/${botSeen.size}`,
  );
}, 10_000).unref();

process.on('exit', (code) => console.log(`[exit] code ${code}`));
process.on('uncaughtException', (err) => {
  console.log('[uncaught]', err);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.log('[unhandled]', err);
  process.exit(3);
});

async function main() {
  console.log(`[load] ${USERS} users, levels ${LEVELS.join(', ')} ms, ${LEVEL_MS / 1000}s each -> ${OUT}`);
  const tSetup = performance.now();
  await setup();
  const setupSummary: Record<string, ReturnType<Series['summary']>> = {};
  for (const [k, s] of ops) setupSummary[k] = s.summary();
  const setupServer = await control<Record<string, unknown>>('/report');
  fs.writeFileSync(
    path.join(OUT, 'setup.json'),
    JSON.stringify({ seconds: (performance.now() - tSetup) / 1000, client: setupSummary, server: setupServer }, null, 1),
  );
  console.log(`[load] setup done in ${((performance.now() - tSetup) / 1000).toFixed(1)}s`);

  const all = [];
  for (let i = 0; i < LEVELS.length; i++) all.push(await runLevel(LEVELS[i]!, i, i === PROFILE_LEVEL));
  if (MEGA > 0) await megaPhase(Math.min(MEGA, users.length));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(all.map((r) => ({ thinkMs: r.thinkMs, ops: r.achievedOpsPerSec })), null, 1));
  if (!has('--keep-server')) await fetch(BASE + '/__load/shutdown', { method: 'POST' }).catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error('[load] fatal', err);
  process.exit(1);
});
