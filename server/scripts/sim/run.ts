/**
 * Multi-user load + scenario simulator.
 *
 * Spawns N personas, distributes them across groups (john/alice
 * sprinkled across multiple), opens one SSE stream per group, and runs
 * each user's chatter loop for a configurable duration. Roughly every
 * fifth message is an @Chord prompt; the verifier asserts the bot
 * picked the right tool and (where applicable) produced a valid deep
 * link / card. Everything is logged to JSONL and a summary report
 * prints at end.
 *
 * Usage:
 *   tsx server/scripts/sim/run.ts \
 *     --users 10 --duration 10m --base http://127.0.0.1:4000 \
 *     [--mock] [--chord-every 5]
 */
import { API } from '@chord/kernel';

import { ChordClient, type SessionInfo } from './client.js';
import { SimLog } from './log.js';
import { personasFor } from './personas.js';
import {
  CHATTER,
  CHORD_PROMPTS,
  SETUP_SCENARIOS,
  type ChordTemplate,
  type SetupScenario,
} from './scenarios.js';
import { openSse } from './sse.js';
import { type CapturedTurn, verifyTurn } from './verify.js';

interface Args {
  users: number;
  durationMs: number;
  base: string;
  mock: boolean;
  chordEvery: number;
  /** The deployment's bot mention alias (server BOT_MENTION_ALIASES). Prompts
   * hardcode "@Chord"; we rewrite to "@<alias>" so the bot is actually
   * addressed on deployments that renamed it (e.g. "chord-beta"). When the
   * flag is omitted we auto-detect it from the server's /health `botAlias`. */
  botAlias: string;
  /** True when --bot-alias was passed explicitly (suppresses auto-detect). */
  botAliasExplicit: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return def;
    return argv[i + 1];
  };
  const has = (flag: string) => argv.includes(flag);
  const dur = get('--duration', '10m')!;
  const m = dur.match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`bad --duration: ${dur}`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 'm']!;
  return {
    users: Number.parseInt(get('--users', '10')!, 10),
    durationMs: Number.parseInt(m[1], 10) * mult,
    base: get('--base', 'http://127.0.0.1:4000')!,
    mock: has('--mock'),
    chordEvery: Number.parseInt(get('--chord-every', '5')!, 10),
    // Default matches example.env (BOT_MENTION_ALIASES=chord). When omitted
    // we auto-detect the real alias from /health in main(); pass --bot-alias
    // to force a value, otherwise "@Chord" prompts won't mention a renamed bot.
    botAlias: (get('--bot-alias', 'chord') || 'chord').trim(),
    botAliasExplicit: has('--bot-alias'),
  };
}

/** Rewrite the literal "@Chord" in a prompt to the deployment's actual alias. */
function addressBot(text: string, alias: string): string {
  if (alias.toLowerCase() === 'chord') return text;
  return text.replace(/@chord\b/gi, `@${alias}`);
}

function pick<T>(arr: T[], rng: () => number = Math.random): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function jitter(ms: number, frac = 0.4): number {
  return Math.round(ms * (1 - frac + Math.random() * 2 * frac));
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Per-group SSE bus. Disambiguates concurrent turns within one group
 * via the `bot.start` event — emitted at the top of every bot turn,
 * carrying both `triggerMessageId` (the prompt) and `messageId` (the
 * bot reply id). Once we've seen `bot.start`, every subsequent
 * `bot.token` / `bot.tool` / `bot.card` / `bot.done` event for that
 * turn carries `messageId` and we route it directly.
 */
class TurnCapture {
  /** Keyed by promptMessageId. */
  private waiters = new Map<
    string,
    {
      resolve: (t: CapturedTurn) => void;
      turn: CapturedTurn;
      timer: NodeJS.Timeout;
    }
  >();
  /** Reverse index: bot reply id → prompt id. Populated on bot.start. */
  private byBotMessage = new Map<string, string>();

  async awaitTurn(promptMessageId: string, timeoutMs: number): Promise<CapturedTurn> {
    return new Promise<CapturedTurn>((resolve) => {
      const turn: CapturedTurn = {
        promptMessageId,
        replyMessageIds: [],
        toolCalls: [],
        cards: [],
        done: false,
        timedOut: false,
        startedAt: Date.now(),
      };
      const timer = setTimeout(() => {
        const w = this.waiters.get(promptMessageId);
        if (w) {
          w.turn.timedOut = true;
          w.turn.durationMs = Date.now() - w.turn.startedAt;
          this.waiters.delete(promptMessageId);
          // Drop any byBotMessage entry that pointed back at this prompt
          // so the reverse index doesn't leak across long sim runs.
          for (const [botId, pid] of this.byBotMessage) {
            if (pid === promptMessageId) this.byBotMessage.delete(botId);
          }
          resolve(w.turn);
        }
      }, timeoutMs);
      this.waiters.set(promptMessageId, { resolve, turn, timer });
    });
  }

  ingest(event: string, data: unknown): void {
    if (event === 'bot.start') {
      const s = data as { triggerMessageId: string; messageId: string };
      if (this.waiters.has(s.triggerMessageId)) {
        this.byBotMessage.set(s.messageId, s.triggerMessageId);
      }
      return;
    }

    if (event === 'message') {
      const m = data as { id: string; senderId: string | null; replyToId?: string | null };
      if (m.senderId !== null || !m.replyToId) return;
      const w = this.waiters.get(m.replyToId);
      if (w) w.turn.replyMessageIds.push(m.id);
      return;
    }

    if (
      event !== 'bot.tool' &&
      event !== 'bot.card' &&
      event !== 'bot.done' &&
      event !== 'bot.receipt'
    ) {
      return;
    }

    const messageId = (data as { messageId?: string }).messageId;
    if (!messageId) return;
    const promptId = this.byBotMessage.get(messageId);
    if (!promptId) return;
    const w = this.waiters.get(promptId);
    if (!w) return;

    if (event === 'bot.tool') {
      const t = data as { name: string; status: 'ok' | 'error'; summary: string };
      w.turn.toolCalls.push({ name: t.name, status: t.status, summary: t.summary });
    } else if (event === 'bot.card') {
      const c = data as { cards: { kind: string; title: string; url?: string }[] };
      for (const card of c.cards) w.turn.cards.push(card);
    } else if (event === 'bot.done' || event === 'bot.receipt') {
      // ADR 0022: directive turns end with bot.receipt instead of
      // bot.done. Either is the canonical "turn done" signal — cards
      // can still arrive in the grace window after.
      w.turn.done = true;
      w.turn.durationMs = Date.now() - w.turn.startedAt;
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        this.waiters.delete(promptId);
        this.byBotMessage.delete(messageId);
        w.resolve(w.turn);
      }, 750);
    }
  }
}

/**
 * Build the user/group graph. Groups of 4 drawn from the "others"
 * pool. Every group has AT LEAST ONE of john / alice; the
 * membership rotates so we get coverage of asymmetric scenarios:
 *   - i % 3 === 0  → john + alice both
 *   - i % 3 === 1  → john only
 *   - i % 3 === 2  → alice only
 *
 * If only one of the two anchor users is logged in (because either
 * persona is absent from the sim's user count), every group gets the
 * present one. The invariant — every group sees at least one anchor
 * — is asserted at runtime in main() so a regression here can't
 * silently degrade the demo coverage.
 */
function planGroups(sessions: SessionInfo[]): {
  groupName: string;
  ownerIdx: number;
  memberIdxs: number[];
}[] {
  const johnIdx = sessions.findIndex((s) => s.username === 'john');
  const aliceIdx = sessions.findIndex((s) => s.username === 'alice');
  const others = sessions
    .map((_, i) => i)
    .filter((i) => i !== johnIdx && i !== aliceIdx);

  const groups: { groupName: string; ownerIdx: number; memberIdxs: number[] }[] = [];
  for (let i = 0; i + 3 < others.length; i += 4) {
    const idxs = others.slice(i, i + 4);
    const memberIdxs = [...idxs];
    const slot = groups.length % 3;
    const wantJohn = slot === 0 || slot === 1;
    const wantAlice = slot === 0 || slot === 2;
    if (wantJohn && johnIdx >= 0) memberIdxs.push(johnIdx);
    if (wantAlice && aliceIdx >= 0) memberIdxs.push(aliceIdx);
    // Fallback: if neither anchor was present in this slot's plan
    // (e.g. one of them is missing from the sim's persona pool),
    // force the other into the group so the invariant holds.
    if (
      (johnIdx < 0 || !memberIdxs.includes(johnIdx)) &&
      (aliceIdx < 0 || !memberIdxs.includes(aliceIdx))
    ) {
      if (johnIdx >= 0) memberIdxs.push(johnIdx);
      else if (aliceIdx >= 0) memberIdxs.push(aliceIdx);
    }
    groups.push({
      groupName: `Group ${groups.length + 1}`,
      ownerIdx: idxs[0]!,
      memberIdxs,
    });
  }
  return groups;
}

function assertAnchorInEveryGroup(
  sessions: SessionInfo[],
  plan: ReturnType<typeof planGroups>,
): { withJohn: number; withAlice: number; withBoth: number; total: number } {
  const johnIdx = sessions.findIndex((s) => s.username === 'john');
  const aliceIdx = sessions.findIndex((s) => s.username === 'alice');
  let withJohn = 0;
  let withAlice = 0;
  let withBoth = 0;
  for (const g of plan) {
    const r = johnIdx >= 0 && g.memberIdxs.includes(johnIdx);
    const m = aliceIdx >= 0 && g.memberIdxs.includes(aliceIdx);
    if (!r && !m) {
      throw new Error(
        `planGroups invariant broken: ${g.groupName} has neither john nor alice`,
      );
    }
    if (r) withJohn++;
    if (m) withAlice++;
    if (r && m) withBoth++;
  }
  return { withJohn, withAlice, withBoth, total: plan.length };
}

async function main() {
  const args = parseArgs();
  if (args.users < 4) throw new Error('need at least 4 users to form a group');
  // Curated pool is PERSONAS.length; beyond that personasFor() fills with
  // synthetic simuser_N accounts so the load sim can scale to hundreds. Cap at
  // a sane ceiling to avoid a typo spawning tens of thousands of accounts.
  if (args.users > 2000) {
    throw new Error(`max users: 2000 (requested ${args.users})`);
  }

  const tsTag = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = `logs/sim-${tsTag}.jsonl`;
  const log = new SimLog(logPath);
  log.write('sim.start', {
    args,
    pid: process.pid,
    base: args.base,
  });
  console.log(`[sim] logging to ${logPath}`);
  console.log(
    `[sim] ${args.users} users, ${args.durationMs / 1000}s, every ${args.chordEvery}th msg → @${args.botAlias}, base=${args.base}, mock=${args.mock}`,
  );

  // 1. Health check. Also auto-detect the bot mention alias from the
  // deployment (unless --bot-alias forced one) so "@Chord" prompts address
  // a renamed bot instead of silently failing to mention it.
  const health = await fetch(`${args.base}${API.health}`);
  if (!health.ok) throw new Error(`server not healthy: ${health.status}`);
  if (!args.botAliasExplicit) {
    const body = (await health.json().catch(() => null)) as { botAlias?: string } | null;
    const detected = body?.botAlias?.trim();
    if (detected && detected.toLowerCase() !== args.botAlias.toLowerCase()) {
      console.log(`[sim] auto-detected bot alias "@${detected}" from /health (was "@${args.botAlias}")`);
      args.botAlias = detected;
    }
  }

  // 1b. Reset state — wipe prior groups, group_members, messages,
  // trips, lists, saves, tasks, events, places, contacts, media,
  // memories, proposals, attachments. Users + sessions survive
  // (login below is idempotent and just refreshes tokens). Requires
  // DEMO_MODE=1 on the server.
  console.log('[sim] resetting server state…');
  await ChordClient.resetDemo(args.base);
  log.write('sim.reset', {
    note: 'wiped groups, group_members, messages, trips, lists, saves, tasks, events, places, contacts, media, memories, proposals, attachments. users preserved.',
  });

  // 2. Login every persona, then pin each to invocation-only listening
  // mode. Default for new users is already 'invocation', but personas
  // may carry over from prior demo runs that bumped them to 'passive'
  // or 'active' — explicit set keeps every run reproducible. The bot
  // will only react to @Chord-mention messages; passive/active
  // background ingestion is off everywhere.
  const personas = personasFor(args.users);
  const sessions: SessionInfo[] = [];
  // Bounded-concurrency login: sequential is too slow at hundreds of users, but
  // an unbounded fan-out would swamp the server. Batches preserve persona order
  // (planGroups relies on indices; anchors are found by username).
  const LOGIN_CONCURRENCY = 16;
  for (let i = 0; i < personas.length; i += LOGIN_CONCURRENCY) {
    const batch = personas.slice(i, i + LOGIN_CONCURRENCY);
    try {
      const batchSessions = await Promise.all(
        batch.map(async (p) => {
          const s = await ChordClient.login(args.base, p.username, p.displayName);
          await new ChordClient(args.base, s.token).setListeningMode('invocation');
          return s;
        }),
      );
      sessions.push(...batchSessions);
    } catch (err) {
      log.write('sim.error', { phase: 'login', message: String(err) });
      throw err;
    }
  }
  console.log(`[sim] logged in ${sessions.length} users`);

  // 3. Build groups. Owner creates, members join via inviteCode.
  const plan = planGroups(sessions);
  // Invariant: every group has at least john OR alice. This makes
  // the run observable from either anchor's account and prevents the
  // demo from drifting into "mystery groups nobody on stage can see."
  const anchorStats = assertAnchorInEveryGroup(sessions, plan);
  log.write('sim.group-plan', anchorStats);
  console.log(
    `[sim] groups planned: ${anchorStats.total} (john in ${anchorStats.withJohn}, alice in ${anchorStats.withAlice}, both in ${anchorStats.withBoth})`,
  );
  interface GroupTargets {
    taskId: string;
    listId: string;
    itemId: string;
    saveId: string;
    eventId: string;
  }
  const groups: {
    id: string;
    name: string;
    memberIdxs: number[];
    ownerIdx: number;
    capture: TurnCapture;
    targets?: GroupTargets;
  }[] = [];
  for (const p of plan) {
    const ownerSession = sessions[p.ownerIdx]!;
    const owner = new ChordClient(args.base, ownerSession.token);
    const group = await owner.createGroup(p.groupName);
    log.write('sim.group-created', {
      groupId: group.id,
      name: group.name,
      ownerUsername: ownerSession.username,
    });
    for (const idx of p.memberIdxs) {
      if (idx === p.ownerIdx) continue;
      const c = new ChordClient(args.base, sessions[idx]!.token);
      try {
        // Join through a shareable invite link (ADR 0047) rather than the
        // bare code, exercising the real link → extract-code → join path.
        const inviteLink = `${args.base}/join/${group.inviteCode}`;
        await c.joinViaLink(inviteLink);
        log.write('sim.group-joined', {
          groupId: group.id,
          username: sessions[idx]!.username,
          via: 'link',
        });
      } catch (err) {
        log.write('sim.error', {
          phase: 'join',
          groupId: group.id,
          username: sessions[idx]!.username,
          message: String(err),
        });
      }
    }
    // Seed one of each entity type so the adversarial phase has concrete,
    // known ids in this group to attack from a non-member account.
    let targets: GroupTargets | undefined;
    try {
      const task = await owner.createTask(group.id, 'Sim seed task');
      const list = await owner.createList(group.id, 'Sim seed list');
      const item = await owner.addListItem(list.id, 'Sim seed item');
      const save = await owner.createSave(group.id, 'Sim seed save', 'https://example.com/sim');
      const event = await owner.createEvent(group.id, 'Sim seed event', '2026-07-04T17:00:00Z');
      targets = { taskId: task.id, listId: list.id, itemId: item.id, saveId: save.id, eventId: event.id };
    } catch (err) {
      log.write('sim.error', { phase: 'seed-targets', groupId: group.id, message: String(err) });
    }
    groups.push({
      id: group.id,
      name: group.name,
      memberIdxs: p.memberIdxs,
      ownerIdx: p.ownerIdx,
      capture: new TurnCapture(),
      targets,
    });
  }

  // 3b. Personal groups already exist post-resetDemo — every user gets
  // one ensured at user creation (auth.ts / session.ts) and reset
  // re-ensures them for everyone. Discover each persona's personal
  // group via /me/groups and fold them into the rotation so the
  // user-loop occasionally posts there too. The bot replies without
  // an @Chord mention in personal groups (bot.service.ts overrides
  // invocation-mode for kind='personal').
  let personalDiscovered = 0;
  for (let idx = 0; idx < sessions.length; idx += 1) {
    const session = sessions[idx]!;
    const c = new ChordClient(args.base, session.token);
    try {
      const myGroups = await c.listMyGroups();
      const personal = myGroups.find((g) => g.kind === 'personal');
      if (!personal) continue;
      groups.push({
        id: personal.id,
        name: personal.name,
        memberIdxs: [idx],
        ownerIdx: idx,
        capture: new TurnCapture(),
      });
      personalDiscovered += 1;
    } catch (err) {
      log.write('sim.error', {
        phase: 'personal-discover',
        username: session.username,
        message: String(err),
      });
    }
  }
  console.log(`[sim] personal groups discovered: ${personalDiscovered}`);

  // 4. Open one SSE stream per group, owned by the group's first member.
  const streams = await Promise.all(
    groups.map(async (g) => {
      const ownerToken = sessions[g.memberIdxs[0]!]!.token;
      const conn = await openSse(
        `${args.base}${API.groupStream(g.id)}`,
        ownerToken,
        (err) => log.write('sim.sse-error', { groupId: g.id, message: String(err) }),
      );
      conn.onEvent((event, data) => g.capture.ingest(event, data));
      return conn;
    }),
  );

  // 5. Per-user chatter loops. Each user picks a group it belongs to
  //    and posts; messages are jittered and stop on global deadline.
  const deadline = Date.now() + args.durationMs;
  const tally = {
    messagesPosted: 0,
    chordPrompts: 0,
    chordPassed: 0,
    chordFailed: 0,
    failuresByCode: {} as Record<string, number>,
    toolCounts: {} as Record<string, number>,
    cardCounts: {} as Record<string, number>,
    proposalsSeen: 0,
    proposalsByKind: {} as Record<string, number>,
    // Setup scenarios — file-upload-driven flows (form-fill, screenshot).
    setupScenariosRun: 0,
    setupPassed: 0,
    setupFailed: 0,
    setupByScenario: {} as Record<string, number>,
    postCheckPassed: 0,
    postCheckFailed: 0,
    postCheckSkipped: 0,
    // Adversarial cross-group access probes (ADR 0004 / 0032).
    idorAttempts: 0,
    idorBlocked: 0,
    idorLeaked: 0,
    idorControlOk: 0,
    idorControlFail: 0,
    idorLeaks: [] as Array<{
      group: string;
      attacker: string;
      method: string;
      path: string;
      status: number;
    }>,
  };

  async function userLoop(userIdx: number) {
    const session = sessions[userIdx]!;
    const client = new ChordClient(args.base, session.token);
    const myGroups = groups.filter((g) => g.memberIdxs.includes(userIdx));
    if (myGroups.length === 0) return;

    let counter = Math.floor(Math.random() * args.chordEvery);
    while (Date.now() < deadline) {
      const group = pick(myGroups);
      counter++;
      // Setup scenarios are heavier (file upload + indexing) so we run
      // them ~1/5th as often as plain chord prompts.
      const isSetup = counter % (args.chordEvery * 5) === 1;
      const isChord = !isSetup && counter % args.chordEvery === 0;

      try {
        if (isSetup) {
          const scenario: SetupScenario = pick(SETUP_SCENARIOS);
          tally.setupScenariosRun = (tally.setupScenariosRun ?? 0) + 1;
          tally.setupByScenario[scenario.id] = (tally.setupByScenario[scenario.id] ?? 0) + 1;
          try {
            const tmpl = await scenario.setup({
              client: {
                uploadFile: (gid, name, buf, mime) =>
                  client.uploadFile(gid, name, buf, mime),
                postMessage: (gid, body) => client.postMessage(gid, body),
                listProposals: () => client.listProposals(),
              },
              groupId: group.id,
              mock: args.mock,
            });
            if (tmpl) {
              const posted = await client.postMessage(group.id, addressBot(tmpl.prompt, args.botAlias));
              log.write('sim.setup-prompt', {
                scenarioId: scenario.id,
                messageId: posted.id,
                groupId: group.id,
                username: session.username,
                prompt: tmpl.prompt,
                expectTool: tmpl.expectTool,
              });
              const turn = await group.capture.awaitTurn(posted.id, 60_000);
              const result = verifyTurn(tmpl, turn, { mock: args.mock });
              if (result.ok) tally.setupPassed = (tally.setupPassed ?? 0) + 1;
              else tally.setupFailed = (tally.setupFailed ?? 0) + 1;
              for (const f of result.failures) {
                tally.failuresByCode[`setup:${f.code}`] =
                  (tally.failuresByCode[`setup:${f.code}`] ?? 0) + 1;
              }
              log.write('sim.setup-result', {
                scenarioId: scenario.id,
                messageId: posted.id,
                ok: result.ok,
                failures: result.failures,
                tools: turn.toolCalls,
              });
            } else {
              log.write('sim.setup-no-prompt', { scenarioId: scenario.id });
            }
            if (scenario.postCheck) {
              const pc = await scenario.postCheck({
                client: {
                  uploadFile: (gid, name, buf, mime) =>
                    client.uploadFile(gid, name, buf, mime),
                  postMessage: (gid, body) => client.postMessage(gid, body),
                  listProposals: () => client.listProposals(),
                },
                groupId: group.id,
                mock: args.mock,
              });
              log.write('sim.setup-postcheck', {
                scenarioId: scenario.id,
                ok: pc.ok,
                skipped: pc.skipped ?? false,
                reason: pc.reason,
              });
              if (pc.skipped) {
                tally.postCheckSkipped = (tally.postCheckSkipped ?? 0) + 1;
              } else if (pc.ok) {
                tally.postCheckPassed = (tally.postCheckPassed ?? 0) + 1;
              } else {
                tally.postCheckFailed = (tally.postCheckFailed ?? 0) + 1;
              }
            }
          } catch (err) {
            log.write('sim.error', {
              phase: 'setup-scenario',
              scenarioId: scenario.id,
              username: session.username,
              groupId: group.id,
              message: String(err),
            });
          }
        } else if (isChord) {
          const tmpl: ChordTemplate = pick(CHORD_PROMPTS);
          const posted = await client.postMessage(group.id, addressBot(tmpl.prompt, args.botAlias));
          log.write('sim.chord-prompt', {
            messageId: posted.id,
            groupId: group.id,
            username: session.username,
            prompt: tmpl.prompt,
            expectTool: tmpl.expectTool,
          });
          tally.chordPrompts++;

          const turn = await group.capture.awaitTurn(posted.id, 30_000);
          const result = verifyTurn(tmpl, turn, { mock: args.mock });
          if (result.ok) tally.chordPassed++;
          else tally.chordFailed++;
          for (const f of result.failures) {
            tally.failuresByCode[f.code] = (tally.failuresByCode[f.code] ?? 0) + 1;
          }
          for (const t of turn.toolCalls) {
            tally.toolCounts[t.name] = (tally.toolCounts[t.name] ?? 0) + 1;
          }
          for (const c of turn.cards) {
            tally.cardCounts[c.kind] = (tally.cardCounts[c.kind] ?? 0) + 1;
          }
          log.write('sim.chord-result', {
            messageId: posted.id,
            groupId: group.id,
            ok: result.ok,
            failures: result.failures,
            tools: turn.toolCalls,
            cards: turn.cards,
            durationMs: turn.durationMs ?? null,
            timedOut: turn.timedOut,
          });
        } else {
          const body = pick(CHATTER);
          const posted = await client.postMessage(group.id, body);
          log.write('sim.message-posted', {
            messageId: posted.id,
            groupId: group.id,
            username: session.username,
            preview: body.slice(0, 80),
          });
          tally.messagesPosted++;
        }
      } catch (err) {
        log.write('sim.error', {
          phase: isChord ? 'chord-post' : 'chat-post',
          username: session.username,
          groupId: group.id,
          message: String(err),
        });
      }

      // 8s base, jitter ±40%. Tunable; tighter rates stress the bot loop.
      await sleep(jitter(8_000));
    }
  }

  // Per-user nudge poller — proxies for proactive bot output. Each user
  // calls /me/proposals every ~45s (jittered) and we record any
  // proposal id we haven't seen before for that user. ADR 0009-style
  // proactive memory nudges land here, as do bot-suggested writes.
  async function proposalPoller(userIdx: number) {
    const session = sessions[userIdx]!;
    const client = new ChordClient(args.base, session.token);
    const seen = new Set<string>();
    // Stagger initial polls so 100 users don't all hammer at t=0.
    await sleep(Math.random() * 30_000);
    while (Date.now() < deadline) {
      try {
        const proposals = await client.listProposals();
        for (const p of proposals) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          tally.proposalsSeen++;
          tally.proposalsByKind[p.kind] =
            (tally.proposalsByKind[p.kind] ?? 0) + 1;
          log.write('sim.proposal-seen', {
            proposalId: p.id,
            kind: p.kind,
            username: session.username,
            groupId: p.groupId,
            title: p.title,
            status: p.status,
          });
        }
      } catch (err) {
        log.write('sim.error', {
          phase: 'poll-proposals',
          username: session.username,
          message: String(err),
        });
      }
      await sleep(jitter(45_000, 0.3));
    }
  }

  // Adversarial cross-group access. For each seeded group, a user who is NOT
  // a member tries to read/mutate that group's entities by id. Every attempt
  // must be refused (404/403); a 2xx is a scope leak (ADR 0004 / 0032). A
  // positive control (a real member mutating the same entity) confirms the
  // probe harness isn't just hitting blanket denials.
  async function adversarialPhase() {
    for (const g of groups) {
      const t = g.targets;
      if (!t) continue;
      const attackerIdx = sessions.findIndex((_, i) => !g.memberIdxs.includes(i));
      if (attackerIdx < 0) continue;
      const attacker = new ChordClient(args.base, sessions[attackerIdx]!.token);
      const attackerName = sessions[attackerIdx]!.username;

      // Positive control first (before any destructive probe), so a legit
      // member edit is observed against a still-existing entity.
      try {
        const member = new ChordClient(args.base, sessions[g.ownerIdx]!.token);
        const status = await member.tryReq('PATCH', API.task(t.taskId), { title: 'legit rename' });
        if (status >= 200 && status < 300) tally.idorControlOk++;
        else {
          tally.idorControlFail++;
          log.write('sim.idor-control-fail', { groupId: g.id, status });
        }
      } catch (err) {
        log.write('sim.error', { phase: 'idor-control', groupId: g.id, message: String(err) });
      }

      const probes: Array<[string, string, unknown?]> = [
        ['GET', API.eventRsvps(t.eventId)],
        ['POST', API.listItems(t.listId), { text: 'pwned' }],
        ['POST', API.eventRsvps(t.eventId), { displayName: 'mallory', status: 'yes' }],
        ['PATCH', API.task(t.taskId), { title: 'pwned' }],
        ['PATCH', API.list(t.listId), { name: 'pwned' }],
        ['PATCH', API.listItem(t.itemId), { text: 'pwned' }],
        ['PATCH', API.save(t.saveId), { title: 'pwned' }],
        ['PATCH', API.event(t.eventId), { title: 'pwned' }],
        ['DELETE', API.listItem(t.itemId)],
        ['DELETE', API.list(t.listId)],
        ['DELETE', API.task(t.taskId)],
        ['DELETE', API.save(t.saveId)],
        ['DELETE', API.event(t.eventId)],
      ];
      for (const [method, path, body] of probes) {
        try {
          const status = await attacker.tryReq(method, path, body);
          tally.idorAttempts++;
          if (status >= 200 && status < 300) {
            tally.idorLeaked++;
            tally.idorLeaks.push({ group: g.name, attacker: attackerName, method, path, status });
            log.write('sim.idor-leak', { groupId: g.id, attacker: attackerName, method, path, status });
          } else {
            tally.idorBlocked++;
          }
        } catch (err) {
          log.write('sim.error', { phase: 'idor-probe', method, path, message: String(err) });
        }
      }
    }
  }

  console.log(`[sim] launching ${sessions.length} loops…`);
  await Promise.all([
    ...sessions.map((_, i) => userLoop(i)),
    ...sessions.map((_, i) => proposalPoller(i)),
  ]);

  console.log('[sim] running adversarial cross-group probes…');
  await adversarialPhase();

  for (const s of streams) s.close();

  // 6. Report.
  const summary = {
    durationMs: args.durationMs,
    users: args.users,
    groups: groups.length,
    ...tally,
  };
  log.write('sim.summary', summary);
  console.log('\n=== SUMMARY ===');
  console.log(`messages posted:   ${tally.messagesPosted}`);
  console.log(`@Chord prompts:    ${tally.chordPrompts}`);
  console.log(
    `@Chord passed:     ${tally.chordPassed} / ${tally.chordPrompts} (${
      tally.chordPrompts ? Math.round((100 * tally.chordPassed) / tally.chordPrompts) : 0
    }%)`,
  );
  console.log('failures by code:', tally.failuresByCode);
  console.log('tool calls seen:', tally.toolCounts);
  console.log('card kinds seen:', tally.cardCounts);
  console.log(`proposals seen:    ${tally.proposalsSeen}`);
  console.log('proposals by kind:', tally.proposalsByKind);
  console.log(`setup scenarios:   ${tally.setupScenariosRun}`);
  console.log(
    `setup passed:      ${tally.setupPassed} / ${tally.setupScenariosRun} (${
      tally.setupScenariosRun
        ? Math.round((100 * tally.setupPassed) / tally.setupScenariosRun)
        : 0
    }%)`,
  );
  console.log('setup by scenario:', tally.setupByScenario);
  console.log(
    `postChecks:        ${tally.postCheckPassed} ok, ${tally.postCheckFailed} failed, ${tally.postCheckSkipped} skipped`,
  );
  console.log('\n=== CROSS-GROUP ACCESS (IDOR) ===');
  console.log(
    `probes:            ${tally.idorAttempts} (blocked ${tally.idorBlocked}, LEAKED ${tally.idorLeaked})`,
  );
  console.log(
    `member control:    ${tally.idorControlOk} ok / ${tally.idorControlFail} failed (legit edits should all be ok)`,
  );
  if (tally.idorLeaked > 0) {
    console.log(`\n⚠️  ${tally.idorLeaked} CROSS-GROUP LEAK(S) — non-member mutated/read another group's data:`);
    for (const l of tally.idorLeaks.slice(0, 40)) {
      console.log(`   ${l.method} ${l.path} → ${l.status}  (attacker ${l.attacker}, group ${l.group})`);
    }
  } else {
    console.log('✅ no cross-group leaks — every non-member probe was refused.');
  }
  console.log(`log: ${logPath}`);
  await log.close();
}

main().catch((err) => {
  console.error('[sim] fatal', err);
  process.exit(1);
});
