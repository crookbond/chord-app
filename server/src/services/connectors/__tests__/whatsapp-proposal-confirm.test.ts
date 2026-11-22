/**
 * A card the bot proposes in chat ("leave the soccer group", "send this
 * email") has to be answerable on WhatsApp.
 *
 * The bug: those cards were built for the app — a "tap to confirm" hint and no
 * buttons — so WhatsApp received `Leave Soccer (… · tap to confirm)` as plain
 * text, with nothing to tap and no way to answer short of opening the app. A
 * typed "yes" went to the model, which had no tool to confirm anything.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SSE, type BotCard } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { startOutboundPublisher } from '@/services/connectors/outbound-publisher.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { renderTelegram } from '@/services/connectors/renderers/telegram.renderer.js';
import { renderWhatsApp } from '@/services/connectors/renderers/whatsapp.renderer.js';
import {
  createGroup,
  ensurePersonalGroup,
  getMemberRole,
  joinGroupByCode,
} from '@/services/groups.service.js';
import { postMessage } from '@/services/messages.service.js';
import { createProposal, listProposalsForGroup } from '@/services/proposals.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let personal: string;
let soccer: string;
let bookClub: string;
let stopPublisher: (() => void) | null = null;

const WA_USER = 'whatsapp:+15550001111';
const WA_CHANNEL = 'whatsapp:+15550001111';

async function request(body: string, source: 'whatsapp' | null = 'whatsapp') {
  return postMessage(db, { groupId: personal, senderId: john, body, source: source ?? undefined });
}

/** Stage a card the way a bot turn does, set off by `trigger` (a message that
 *  arrived on WhatsApp, or in the app). */
async function stage(
  name: string,
  groupName: string,
  trigger?: { id: string },
) {
  trigger ??= await request(`${name.replace('_', ' ')} ${groupName}`);
  const res = await applyToolCall(db, {
    groupId: personal,
    actorUserId: john,
    call: { name, args: { groupName } } as never,
    mode: 'propose',
    triggeringMessageId: trigger.id,
    emit: () => {},
  } as never);
  const proposalId = (res.data as { proposalId: string }).proposalId;
  return { card: res.card as BotCard, proposalId };
}

function everyTextSent(r: ReturnType<typeof renderWhatsApp>): string[] {
  return [r.text, r.whatsapp?.quickReply?.body, r.whatsapp?.ctaUrl?.body].filter(
    (s): s is string => typeof s === 'string',
  );
}

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  const priya = await createUser(db, 'priya', 'Priya');
  personal = (await ensurePersonalGroup(db, john)).id;
  const s = await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: john, nameIsCustom: true });
  soccer = s.id;
  await joinGroupByCode(db, priya, s.invite_code);
  const b = await createGroup(db, { name: 'Book Club', kind: 'group', createdBy: john, nameIsCustom: true });
  bookClub = b.id;
  await joinGroupByCode(db, priya, b.invite_code);
});

afterEach(async () => {
  stopPublisher?.();
  stopPublisher = null;
  await closeTestDb(db);
  for (const c of connectorRegistry.list()) await c.shutdown().catch(() => {});
});

describe('a chat proposal rendered for WhatsApp', () => {
  it('carries real Confirm / Cancel buttons and never says "tap"', async () => {
    const { card, proposalId } = await stage('leave_group', 'soccer');
    const out = renderWhatsApp({ body: 'Want me to take you out of Soccer?', cards: [card] });

    expect(out.whatsapp?.quickReply?.buttons.map((b) => b.id)).toEqual([
      `p+:${proposalId}`,
      `p-:${proposalId}`,
    ]);
    // What the card says still reaches the reader, above the buttons.
    expect(out.whatsapp?.quickReply?.body).toContain('Leave Soccer');
    for (const text of everyTextSent(out)) expect(text).not.toMatch(/\btap\b/i);
  });

  it('when there are too many buttons for WhatsApp, says to reply YES or NO instead', async () => {
    const one = await stage('leave_group', 'soccer');
    const two = await stage('leave_group', 'book club');
    // Two cards = four buttons; WhatsApp sends at most three in a session.
    const out = renderWhatsApp({ body: 'Here you go.', cards: [one.card, two.card] });

    expect(out.whatsapp?.quickReply).toBeUndefined();
    expect(out.text).toContain('Leave Soccer');
    expect(out.text).toContain('Leave Book Club');
    expect(out.text).toMatch(/Reply YES/);
    expect(out.text).not.toMatch(/\btap\b/i);
  });

  it('Telegram puts the same buttons under a non-action card too', () => {
    const card: BotCard = {
      kind: 'email',
      title: 'Trash: Invoice 42',
      meta: 'tap to move to Trash',
      buttons: [
        { label: 'Move to Trash', callback: { verb: 'p+', id: 'p_1' } },
        { label: 'Cancel', callback: { verb: 'p-', id: 'p_1' } },
      ],
    };
    const out = renderTelegram({ body: 'Ready when you are.', cards: [card] });
    expect(out.telegram.replyMarkup?.inline_keyboard).toEqual([
      [
        { text: 'Move to Trash', callback_data: 'p+:p_1' },
        { text: 'Cancel', callback_data: 'p-:p_1' },
      ],
    ]);
    expect(out.telegram.html).toContain('Trash: Invoice 42');
    expect(out.telegram.html).not.toMatch(/\btap\b/i);
  });
});

describe('a typed YES / NO on WhatsApp', () => {
  async function connect(): Promise<MockConnector> {
    await db
      .insertInto('external_identities')
      .values({
        platform: 'whatsapp',
        external_id: WA_USER,
        external_display: 'John',
        user_id: john,
        created_at: new Date().toISOString(),
      })
      .execute();
    await bindChannel(db, 'whatsapp', WA_CHANNEL, personal, 'whatsapp');
    const conn = new MockConnector(db, 'whatsapp');
    connectorRegistry.register(conn);
    stopPublisher = startOutboundPublisher(db, connectorRegistry);
    return conn;
  }

  /** The bot's reply carrying these cards, mirrored to WhatsApp through the
   *  real outbound publisher (what records the send). */
  async function showOnWhatsApp(cards: BotCard[], body = 'Want me to do that?') {
    const msg = await postMessage(db, { groupId: personal, senderId: null, body });
    await db
      .insertInto('message_cards')
      .values({ message_id: msg.id, cards_json: JSON.stringify(cards), created_at: new Date().toISOString() })
      .execute();
    sseHub.broadcast(personal, SSE.message, msg);
    await settleBackgroundWork();
    return msg;
  }

  async function stageFromEmail(title: string) {
    // What the email suggestion pass does: the user is the proposer, there is
    // no chat message behind it, and no chat bubble ever carries the card.
    return createProposal(db, {
      groupId: personal,
      proposedByUserId: john,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title },
      provenance: 'gmail:t_forged',
    });
  }

  it('YES confirms the card the bot just showed there', async () => {
    const conn = await connect();
    const { card, proposalId } = await stage('leave_group', 'soccer');
    await showOnWhatsApp([card]);

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'Yes', isPrivate: true });

    const [p] = (await listProposalsForGroup(db, personal)).filter((x) => x.id === proposalId);
    expect(p!.status).toBe('confirmed');
    expect(await getMemberRole(db, soccer, john)).toBeNull();
    expect(conn.sent.at(-1)?.text).toMatch(/confirmed/i);
  });

  it('NO cancels it and changes nothing', async () => {
    const conn = await connect();
    const { card, proposalId } = await stage('leave_group', 'soccer');
    await showOnWhatsApp([card]);

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'no', isPrivate: true });

    const [p] = (await listProposalsForGroup(db, personal)).filter((x) => x.id === proposalId);
    expect(p!.status).toBe('rejected');
    expect(await getMemberRole(db, soccer, john)).toBe('owner');
  });

  it('YES answers every card shown together, as the message said it would', async () => {
    const conn = await connect();
    const ask = await request('take me out of soccer and book club');
    const one = await stage('leave_group', 'soccer', ask);
    const two = await stage('leave_group', 'book club', ask);
    await showOnWhatsApp([one.card, two.card]);

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'yes', isPrivate: true });

    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(0);
    expect(await getMemberRole(db, soccer, john)).toBeNull();
    expect(await getMemberRole(db, bookClub, john)).toBeNull();
  });

  it('YES answers the cards made from a photo sent on WhatsApp', async () => {
    // The upload's cards hang off the bot's "I see 2 tasks…" announcement,
    // not off the user's message, and share one bundle.
    const conn = await connect();
    await request('📎 permission slip');
    const announcement = await postMessage(db, { groupId: personal, senderId: null, body: '📎 I see 2 tasks' });
    const bundleId = 'bundle_slip';
    const staged: string[] = [];
    for (const title of ['Sign the slip', 'Pay the $12 fee']) {
      const p = await createProposal(db, {
        groupId: personal,
        proposedByUserId: john,
        proposedByMessageId: announcement.id,
        toolName: 'create_task',
        args: { title },
        provenance: 'attachment:a_1',
        bundleId,
      });
      staged.push(p.id);
    }
    // One bundle card, carrying the first member's callback.
    await db
      .insertInto('message_cards')
      .values({
        message_id: announcement.id,
        cards_json: JSON.stringify([
          { kind: 'action', title: '2 tasks', callback: { verb: 'p+', id: staged[0] } },
        ]),
        created_at: new Date().toISOString(),
      })
      .execute();
    sseHub.broadcast(personal, SSE.message, announcement);
    await settleBackgroundWork();

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'Yes!', isPrivate: true });

    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(0);
    const tasks = await db.selectFrom('tasks').select('title').where('group_id', '=', personal).execute();
    expect(tasks.map((t) => t.title).sort()).toEqual(['Pay the $12 fee', 'Sign the slip']);
  });

  it('does not touch a card the user was shown in the app, not on WhatsApp', async () => {
    const conn = await connect();
    await stage('leave_group', 'soccer', await request('leave soccer', null));

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'yes', isPrivate: true });

    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(1);
    expect(await getMemberRole(db, soccer, john)).toBe('owner');
  });

  it('does not confirm a card an email pass staged in the background', async () => {
    // The audit's shape: the user asks something on WhatsApp, and meanwhile
    // the email pass stages a card with the user as proposer (a forged email
    // asking them to act). It was never sent to WhatsApp; the "yes" that
    // follows is about something else.
    const conn = await connect();
    await request('can you remind me about the dentist?');
    await stageFromEmail('Call the number in this email');

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'yes', isPrivate: true });

    expect(await listProposalsForGroup(db, personal, { status: 'pending' })).toHaveLength(1);
    const tasks = await db.selectFrom('tasks').select('title').where('group_id', '=', personal).execute();
    expect(tasks).toHaveLength(0);
  });

  it('YES confirms the card shown there and leaves the background one alone', async () => {
    const conn = await connect();
    const { card, proposalId } = await stage('leave_group', 'soccer');
    await showOnWhatsApp([card]);
    await stageFromEmail('Call the number in this email');

    await conn.injectInbound({ externalChannelId: WA_CHANNEL, externalUserId: WA_USER, text: 'yes', isPrivate: true });

    const all = await listProposalsForGroup(db, personal);
    expect(all.find((x) => x.id === proposalId)!.status).toBe('confirmed');
    expect(all.filter((x) => x.status === 'pending').map((x) => x.toolName)).toEqual(['create_task']);
  });
});
