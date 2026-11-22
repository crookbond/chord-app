/**
 * ADR 0246 — mailing lists from chat: list them, and leave one.
 *
 * Pinned here: a sender is a mailing list only when its mail carries the
 * unsubscribe header; another user's mail never appears; a name that matches
 * no list or several is handed back as a question; and nothing is sent to the
 * sender until the card is confirmed.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { validateNativeCall } from '@/services/bot/bot.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, READONLY_TOOL_NAMES, buildToolDefs } from '@/services/bot/tools.js';
import { listSubscriptions } from '@/services/email/unsubscribe.service.js';
import { listAutoTrash } from '@/services/email/auto-trash.service.js';
import { listFilingRules } from '@/services/email/filing.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

describe('mailing lists from chat (ADR 0246)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let sharedId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    sharedId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const call = (name: string, args: Record<string, unknown>, mode: 'propose' | 'commit', groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode,
      call: { name, args } as never,
    });

  /** One thread with `count` messages from a sender, newest `daysAgo` old. */
  const seed = async (o: {
    owner?: string;
    fromName: string;
    fromEmail: string;
    count?: number;
    daysAgo?: number;
    listUnsubscribe?: string | null;
    post?: string | null;
    labels?: string[];
  }): Promise<string> => {
    const owner = o.owner ?? userId;
    const threadId = newId('et');
    const gid = newId('gt');
    const newest = Date.now() - (o.daysAgo ?? 1) * DAY;
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: owner,
        gmail_thread_id: gid,
        subject: `From ${o.fromName}`,
        snippet: '',
        from_name: o.fromName,
        from_email: o.fromEmail,
        last_message_at: new Date(newest).toISOString(),
        created_at: new Date(newest).toISOString(),
        updated_at: new Date(newest).toISOString(),
      })
      .execute();
    for (let i = 0; i < (o.count ?? 1); i += 1) {
      const at = new Date(newest - i * DAY).toISOString();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: owner,
          thread_id: threadId,
          gmail_thread_id: gid,
          gmail_message_id: newId('gm'),
          from_name: o.fromName,
          from_email: o.fromEmail,
          to_emails: JSON.stringify(['ro@example.com']),
          cc_emails: JSON.stringify([]),
          subject: `From ${o.fromName}`,
          snippet: '',
          gmail_label_ids: JSON.stringify(o.labels ?? ['INBOX']),
          list_unsubscribe: o.listUnsubscribe === undefined ? null : o.listUnsubscribe,
          list_unsubscribe_post: o.post ?? null,
          internal_date: at,
          created_at: at,
        })
        .execute();
    }
    return threadId;
  };

  const MAILTO = '<mailto:leave@target.example?subject=unsubscribe>';
  const LINK = '<https://medium.example/unsubscribe?u=1>';

  it('registers both tools as personal-only, the list as read-only, and hides the pinned sender from the model', () => {
    for (const name of [
      'list_subscriptions',
      'unsubscribe_from_sender',
      'unsubscribe_from_senders',
      'trash_future_mail',
      'stop_trashing_mail',
      'add_mail_filter',
      'list_mail_filters',
      'remove_mail_filter',
    ] as const) {
      expect(PERSONAL_ONLY_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(READONLY_TOOL_NAMES.has('list_subscriptions')).toBe(true);
    expect(READONLY_TOOL_NAMES.has('unsubscribe_from_sender')).toBe(false);
    const def = buildToolDefs().find((d) => d.name === 'unsubscribe_from_sender');
    const props = Object.keys((def?.parameters as { properties: object }).properties);
    expect(props).toEqual(['sender']);
  });

  it('lists only senders whose mail carries the header, busiest first, for this user alone', async () => {
    await seed({ fromName: 'Target', fromEmail: 'News@Target.example', count: 4, listUnsubscribe: MAILTO });
    await seed({ fromName: 'Medium Daily', fromEmail: 'noreply@medium.example', count: 2, listUnsubscribe: LINK });
    await seed({ fromName: 'Ms Chen', fromEmail: 'chen@school.org', count: 9 });
    await seed({ fromName: 'Old List', fromEmail: 'old@list.example', daysAgo: 200, listUnsubscribe: LINK });
    await seed({ fromName: 'Binned', fromEmail: 'bin@list.example', listUnsubscribe: LINK, labels: ['TRASH'] });
    const other = await createUser(db, 'someone');
    await seed({ owner: other, fromName: 'Theirs', fromEmail: 'x@theirs.example', count: 20, listUnsubscribe: LINK });

    const rows = await listSubscriptions(db, userId);
    expect(rows.map((r) => [r.senderEmail, r.senderName, r.messages, r.kind])).toEqual([
      ['news@target.example', 'Target', 4, 'mailto'],
      ['noreply@medium.example', 'Medium Daily', 2, 'link'],
    ]);

    const res = await call('list_subscriptions', {}, 'commit');
    expect((res.data as { senders: unknown[] }).senders).toHaveLength(2);
  });

  it('refuses both tools in a shared group', async () => {
    await seed({ fromName: 'Target', fromEmail: 'news@target.example', listUnsubscribe: MAILTO });
    const list = await call('list_subscriptions', {}, 'commit', sharedId);
    expect(list.data).toMatchObject({ senders: [] });
    const unsub = await call('unsubscribe_from_sender', { sender: 'target' }, 'propose', sharedId);
    expect(unsub.data).toMatchObject({ unsubscribed: false, reason: 'personal_only' });
    expect(await listProposalsForGroup(db, sharedId)).toHaveLength(0);
  });

  it('asks instead of picking when the name matches no list or several brands', async () => {
    await seed({ fromName: 'Target Deals', fromEmail: 'deals@target.example', listUnsubscribe: MAILTO });
    await seed({ fromName: 'Target Optical', fromEmail: 'news@targetoptical.example', listUnsubscribe: MAILTO });

    const many = await call('unsubscribe_from_sender', { sender: 'target' }, 'propose');
    expect(many.data).toMatchObject({ unsubscribed: false, reason: 'ambiguous' });
    expect((many.data as { candidates: unknown[] }).candidates).toHaveLength(2);

    const none = await call('unsubscribe_from_sender', { sender: 'costco' }, 'propose');
    expect(none.data).toMatchObject({ unsubscribed: false, reason: 'not_found' });
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });

  it('stages a card naming the sender and sends nothing until it is confirmed', async () => {
    await seed({ fromName: 'Target', fromEmail: 'news@target.example', listUnsubscribe: MAILTO });

    const staged = await call('unsubscribe_from_sender', { sender: 'target' }, 'propose');
    expect(staged.card?.title).toBe('Unsubscribe: Target');
    const [proposal] = await listProposalsForGroup(db, personalId);
    const stagedArgs = JSON.parse(proposal.argsJson) as Record<string, unknown>;
    expect(stagedArgs).toMatchObject({ senderEmail: 'news@target.example' });
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);

    const done = await call('unsubscribe_from_sender', stagedArgs, 'commit');
    // A mailto is a request: sent, and never reported as unsubscribed.
    expect(done.data).toMatchObject({ kind: 'mailto', unsubscribed: false, requested: true });
    const recorded = await db.selectFrom('email_unsubscribes').selectAll().execute();
    expect(recorded.map((r) => [r.sender_email, r.kind])).toEqual([['news@target.example', 'mailto']]);

    const after = await listSubscriptions(db, userId);
    expect(after[0].requestedAt).toBeTruthy();
  });

  it('hands over the page for a link-only sender, with no card to confirm and no claim', async () => {
    await seed({ fromName: 'Medium Daily', fromEmail: 'noreply@medium.example', listUnsubscribe: LINK });
    const res = await call('unsubscribe_from_sender', { sender: 'medium' }, 'propose');
    expect(res.data).toMatchObject({ kind: 'link', unsubscribed: false });
    expect(res.card?.url).toBe('https://medium.example/unsubscribe?u=1');
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);
  });

  // Prod, 28 Oct: "Unsubscribe me from the Macy's mailing list,
  // macys@e.macys.com" came back "no mailing list matches", though Macy's was
  // the first name the next answer listed: Macy's mails from a subdomain the
  // user never sees.
  it('finds a list by the address or name the user typed, not only the exact sender address', async () => {
    await seed({ fromName: "Macy's", fromEmail: 'no-reply@em.macys.com', count: 10, listUnsubscribe: MAILTO });
    await seed({ fromName: '1-800 Contacts', fromEmail: 'info@pr.1800contacts.com', count: 3, listUnsubscribe: MAILTO });
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });

    for (const sender of ["Macy's mailing list, macys@e.macys.com", 'macys@e.macys.com', "the Macy's emails", 'macys.com']) {
      const res = await call('unsubscribe_from_sender', { sender }, 'propose');
      expect(res.summary, sender).toMatch(/^proposed unsubscribe_from_sender/);
      await db.deleteFrom('proposals').execute();
    }
    const contacts = await call('unsubscribe_from_sender', { sender: '1-800 contacts' }, 'propose');
    expect(contacts.summary).toMatch(/^proposed unsubscribe_from_sender/);
  });

  // Prod, 28 Oct: asked again before tapping ("I don't think you unsubscribed
  // me"), the bot staged a second card for each sender and said it had sent the
  // requests. Nothing had been sent.
  it('answers a repeat request with the card already waiting: no second card, no claim', async () => {
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });

    const first = await call('unsubscribe_from_sender', { sender: 'crocs' }, 'propose');
    expect(first.summary).toMatch(/^proposed unsubscribe_from_sender/);
    const again = await call('unsubscribe_from_sender', { sender: 'Crocs' }, 'propose');

    expect(await listProposalsForGroup(db, personalId)).toHaveLength(1);
    expect(again.data).toMatchObject({ unsubscribed: false, requested: false, reason: 'awaiting_confirmation' });
    expect(again.summary).toMatch(/NOTHING has been sent/);
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);
  });

  // "Unsubscribe me from them": one card for several lists, one tap, and a
  // result per list. Each list leaves its own way and some cannot be confirmed.
  it('stages ONE card for several lists and reports each list after the tap', async () => {
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });
    await seed({ fromName: '1-800 Contacts', fromEmail: 'info@pr.1800contacts.com', count: 3, listUnsubscribe: MAILTO });

    const staged = await call('unsubscribe_from_senders', { senders: ['Crocs', '1-800 contacts'] }, 'propose');
    expect(staged.card?.title).toBe('Unsubscribe from 2 lists');
    const cards = await listProposalsForGroup(db, personalId);
    expect(cards).toHaveLength(1);
    const args = JSON.parse(cards[0]!.argsJson) as Record<string, unknown>;
    expect(args).toMatchObject({ senderEmails: ['email@crocs-email.com', 'info@pr.1800contacts.com'] });
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);

    const done = await call('unsubscribe_from_senders', args, 'commit');
    const results = (done.data as { results: Array<Record<string, unknown>> }).results;
    expect(results.map((r) => [r.sender, r.requested, r.unsubscribed])).toEqual([
      ['Crocs', true, false],
      ['1-800 Contacts', true, false],
    ]);
    const recorded = await db.selectFrom('email_unsubscribes').select('sender_email').orderBy('sender_email').execute();
    expect(recorded.map((r) => r.sender_email)).toEqual(['email@crocs-email.com', 'info@pr.1800contacts.com']);
  });

  // Prod 2026-10-30 00:45Z: "Can you unsubscribe from crocs and macys" -> the
  // model sent fewer than two senders, the schema's min(2) refused the call
  // ("invalid args for unsubscribe_from_senders: Array must contain at least 2
  // element(s)"), it fell back to unsubscribe_from_sender for Macy's alone and
  // Crocs was never acted on or mentioned.
  it('accepts the call the model made in prod instead of refusing it', () => {
    for (const senders of [['crocs and macys'], ['macys']]) {
      const v = validateNativeCall({ id: 't1', name: 'unsubscribe_from_senders', args: { senders } }, '-04:00', 'America/New_York');
      expect(v.ok).toBe(true);
    }
  });

  it('reads "crocs and macys" as two lists on one card', async () => {
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });
    await seed({ fromName: "Macy's", fromEmail: 'no-reply@em.macys.com', count: 3, listUnsubscribe: MAILTO });

    const staged = await call('unsubscribe_from_senders', { senders: ['crocs and macys'] }, 'propose');
    expect(staged.card?.title).toBe('Unsubscribe from 2 lists');
    const cards = await listProposalsForGroup(db, personalId);
    expect(cards).toHaveLength(1);
    const args = JSON.parse(cards[0]!.argsJson) as Record<string, unknown>;
    expect(args).toMatchObject({ senderEmails: ['email@crocs-email.com', 'no-reply@em.macys.com'] });
  });

  it('keeps a name that contains "&" whole when it is one list', async () => {
    await seed({ fromName: 'Barnes & Noble', fromEmail: 'news@bn.example', count: 3, listUnsubscribe: MAILTO });
    const staged = await call('unsubscribe_from_senders', { senders: ['Barnes & Noble'] }, 'propose');
    expect(staged.card?.title).toBe('Unsubscribe: Barnes & Noble');
  });

  it('stages a single list on its own card', async () => {
    await seed({ fromName: "Macy's", fromEmail: 'no-reply@em.macys.com', count: 3, listUnsubscribe: MAILTO });
    const staged = await call('unsubscribe_from_senders', { senders: ['macys'] }, 'propose');
    expect(staged.card?.title).toBe("Unsubscribe: Macy's");
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(1);
  });

  it('stages the lists that can go on the card and reports the rest beside it', async () => {
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });
    await seed({ fromName: '1-800 Contacts', fromEmail: 'info@pr.1800contacts.com', count: 3, listUnsubscribe: MAILTO });
    await seed({ fromName: 'Medium Daily', fromEmail: 'noreply@medium.example', listUnsubscribe: LINK });

    const res = await call('unsubscribe_from_senders', { senders: ['crocs', '1-800 contacts', 'medium', 'costco'] }, 'propose');
    expect(res.card?.title).toBe('Unsubscribe from 2 lists');
    const notOnCard = (res.data as { notOnCard: Array<{ sender: string }> }).notOnCard.map((p) => p.sender);
    expect(notOnCard).toEqual(['medium', 'costco']);
    const cards = await listProposalsForGroup(db, personalId);
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0]!.argsJson)).toMatchObject({
      senderEmails: ['email@crocs-email.com', 'info@pr.1800contacts.com'],
    });
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);
  });

  it('stages nothing and says why when no list can go on a card', async () => {
    await seed({ fromName: 'Medium Daily', fromEmail: 'noreply@medium.example', listUnsubscribe: LINK });
    const res = await call('unsubscribe_from_senders', { senders: ['medium', 'costco'] }, 'propose');
    expect(res.data).toMatchObject({ reason: 'needs_attention', ready: [] });
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });

  // Prod 2026-10-30 15:35Z: the Findings chat handed over twelve lists with
  // invented addresses ("Unsubscribe me from the Macy's mailing list,
  // macys@example.com; ..."), every one came back "no mailing list matches",
  // and the all-or-nothing card held back even the ones that could have gone.
  // Senders below are her real ones; Macy's, Amtrak and Dr. Squatch each mail
  // from several addresses.
  it('reads the prod handover of invented addresses as the twelve lists she meant', async () => {
    const lists: Array<[string, string, string | null, number]> = [
      ["Macy's", 'no-reply@em.macys.com', MAILTO, 9],
      ["Macy's", 'shop@em.macys.com', MAILTO, 4],
      ['Amtrak', 'no-reply@acn.amtrak.com', MAILTO, 5],
      ['Amtrak', 'amtrak@e-mail.amtrak.com', MAILTO, 3],
      ['Dr. Squatch', 'help@drsquatch.com', MAILTO, 5],
      ['Dr. Squatch', 'support@drsquatch.com', LINK, 2],
      ['Dr. Squatch', 'information@drsquatch.com', MAILTO, 1],
      ['Houzz Partners', 'messages@houzz.com', MAILTO, 4],
      ['TALBOTS Cyber Event', 'talbots@e.talbots.com', MAILTO, 4],
      ['IKEA', 'no.reply@order.email.ikea.com', MAILTO, 4],
      ['Zillow Rentals', 'zmail@zmail.zillow.com', MAILTO, 4],
      ['IDSA', 'info@msgs.idsociety.org', MAILTO, 4],
      ['vineyard vines Outlet', 'email@email.vineyardvines.com', MAILTO, 4],
      ['Clinique Online', 'clinique@em.clinique.com', MAILTO, 4],
      ['Vumedi', 'videos@vumedi.com', MAILTO, 4],
      ['Thursday Boot Company', 'thursday@thursdayboots.com', MAILTO, 4],
    ];
    for (const [fromName, fromEmail, listUnsubscribe, count] of lists) {
      await seed({ fromName, fromEmail, listUnsubscribe, count });
    }
    const handedOver = [
      'macys', 'amtrak', 'drsquatch', 'houzzpartners', 'talbots', 'ikea',
      'zillowrentals', 'idsa', 'vineyardvinesoutlet', 'cliniqueonline', 'vumedi', 'thursdaybootcompany',
    ].map((n) => `${n}@example.com`);

    const res = await call('unsubscribe_from_senders', { senders: handedOver }, 'propose');
    expect(res.card?.title).toBe('Unsubscribe from 12 lists');
    expect((res.data as { notOnCard?: unknown }).notOnCard).toBeUndefined();
    const [card] = await listProposalsForGroup(db, personalId);
    const args = JSON.parse(card!.argsJson) as { senderEmails: string[]; senderNames: string[] };
    expect(args.senderNames).toHaveLength(12);
    expect(args.senderEmails).toEqual(
      expect.arrayContaining(['no-reply@em.macys.com', 'shop@em.macys.com', 'amtrak@e-mail.amtrak.com']),
    );
    // A brand address with only a web page does not block the others, and is
    // not on a card that cannot leave it.
    expect(args.senderEmails).toContain('help@drsquatch.com');
    expect(args.senderEmails).not.toContain('support@drsquatch.com');
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);
  });

  it('leaves every address of one brand from a single-list request', async () => {
    await seed({ fromName: "Macy's", fromEmail: 'no-reply@em.macys.com', count: 5, listUnsubscribe: MAILTO });
    await seed({ fromName: "Macy's", fromEmail: 'shop@em.macys.com', count: 2, listUnsubscribe: MAILTO });

    const staged = await call('unsubscribe_from_sender', { sender: "Macy's" }, 'propose');
    expect(staged.card?.title).toBe("Unsubscribe: Macy's");
    const [card] = await listProposalsForGroup(db, personalId);
    expect(card!.toolName).toBe('unsubscribe_from_senders');
    const args = JSON.parse(card!.argsJson) as Record<string, unknown>;
    expect(args).toMatchObject({ senderEmails: ['no-reply@em.macys.com', 'shop@em.macys.com'] });

    const done = await call('unsubscribe_from_senders', args, 'commit');
    expect((done.data as { results: unknown[] }).results).toHaveLength(2);
    const recorded = await db.selectFrom('email_unsubscribes').select('sender_email').orderBy('sender_email').execute();
    expect(recorded.map((r) => r.sender_email)).toEqual(['no-reply@em.macys.com', 'shop@em.macys.com']);

    // That card is waiting for both addresses, so asking again makes no second card.
    await db.deleteFrom('email_unsubscribes').execute();
    const again = await call('unsubscribe_from_senders', { senders: ['shop@em.macys.com'] }, 'propose');
    expect(again.data).toMatchObject({ reason: 'needs_attention' });
  });

  it('never groups different senders who share a mail platform', async () => {
    await seed({ fromName: 'Money Stuff', fromEmail: 'moneystuff@substack.com', listUnsubscribe: MAILTO });
    await seed({ fromName: 'Garbage Day', fromEmail: 'garbageday@substack.com', listUnsubscribe: MAILTO });
    const res = await call('unsubscribe_from_sender', { sender: 'substack' }, 'propose');
    expect(res.data).toMatchObject({ reason: 'ambiguous' });
  });

  // A list Chord could not leave is the user's to finish: the bot says so and
  // offers the sender's page and "send their future mail to Trash".
  it('marks a list it could not leave, attaches its page, and offers Trash', async () => {
    // One-click to a host that does not resolve: the unattended request fails.
    const ONE_CLICK = '<https://unsub.invalid/u/1>';
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 3, listUnsubscribe: ONE_CLICK, post: 'List-Unsubscribe=One-Click' });
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });

    const done = await call(
      'unsubscribe_from_senders',
      { senders: ['valpak', 'crocs'], senderEmails: ['offers@valpak.example', 'email@crocs-email.com'] },
      'commit',
    );
    const results = (done.data as { results: Array<Record<string, unknown>> }).results;
    expect(results.find((r) => r.sender === 'Valpak')).toMatchObject({ unsubscribed: false, needsYou: true });
    expect(results.find((r) => r.sender === 'Crocs')).toMatchObject({ requested: true });
    expect(results.find((r) => r.sender === 'Crocs')).not.toHaveProperty('needsYou');
    expect(done.cards?.map((c) => c.url)).toEqual(['https://unsub.invalid/u/1']);
    expect((done.data as { instruction: string }).instruction).toMatch(/trash_future_mail/);

    // The Trash offer: one card, nothing changed until it is tapped.
    const staged = await call('trash_future_mail', { senders: ['offers@valpak.example'] }, 'propose');
    expect(staged.card?.title).toBe('Send future mail to Trash: Valpak');
    const [card] = (await listProposalsForGroup(db, personalId)).filter((p) => p.toolName === 'trash_future_mail');
    expect(await listAutoTrash(db, userId)).toEqual([]);

    await call('trash_future_mail', JSON.parse(card!.argsJson) as Record<string, unknown>, 'commit');
    expect((await listAutoTrash(db, userId)).map((r) => r.sender)).toEqual(['offers@valpak.example']);
    expect((await listSubscriptions(db, userId)).find((l) => l.senderEmail === 'offers@valpak.example')?.autoTrash).toBe(true);

    const stopped = await call('stop_trashing_mail', { senders: ['Valpak'] }, 'commit');
    expect(stopped.data).toMatchObject({ ok: true, stopped: ['offers@valpak.example'] });
    expect(await listAutoTrash(db, userId)).toEqual([]);
  });

  // ADR 0309 — "send emails from school.org to School" from chat.
  it('stages a filter card, adds the rule on the tap, lists and removes it', async () => {
    const staged = await call('add_mail_filter', { from: 'school.org', folder: 'School' }, 'propose');
    expect(staged.card?.title).toBe('File mail from school.org into "School"');
    expect(await listFilingRules(db, userId)).toEqual([]);

    const [card] = (await listProposalsForGroup(db, personalId)).filter((p) => p.toolName === 'add_mail_filter');
    const done = await call('add_mail_filter', JSON.parse(card!.argsJson) as Record<string, unknown>, 'commit');
    expect(done.data).toMatchObject({ ok: true, folder: 'School' });
    expect((await listFilingRules(db, userId)).map((r) => [r.kind, r.value, r.folder])).toEqual([
      ['domain', 'school.org', 'School'],
    ]);

    const listed = await call('list_mail_filters', {}, 'commit');
    expect((listed.data as { filters: unknown[] }).filters).toEqual([
      expect.objectContaining({ from: 'anyone at school.org', folder: 'School' }),
    ]);

    const removed = await call('remove_mail_filter', { folder: 'school' }, 'commit');
    expect(removed.data).toMatchObject({ ok: true });
    expect(await listFilingRules(db, userId)).toEqual([]);
  });

  it('refuses a filter into Inbox or Trash, and asks when the name matches nobody', async () => {
    const reserved = await call('add_mail_filter', { from: 'school.org', folder: 'Trash' }, 'propose');
    expect(reserved.data).toMatchObject({ reason: 'reserved_folder' });
    const nobody = await call('add_mail_filter', { from: 'Zebulon Quux', folder: 'Zoo' }, 'propose');
    expect(nobody.data).toMatchObject({ reason: 'not_found' });
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });

  it('will not set the Trash rule for a sender the user has no mail from', async () => {
    const res = await call('trash_future_mail', { senders: ['stranger@nowhere.example'] }, 'propose');
    expect(res.data).toMatchObject({ reason: 'needs_attention' });
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });

  it('says a sender was already asked to stop rather than offering another card', async () => {
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs-email.com', count: 3, listUnsubscribe: MAILTO });
    await db
      .insertInto('email_unsubscribes')
      .values({ user_id: userId, sender_email: 'email@crocs-email.com', kind: 'mailto', requested_at: new Date(Date.now() - 2 * DAY).toISOString() } as never)
      .execute();

    const res = await call('unsubscribe_from_sender', { sender: 'crocs' }, 'propose');
    expect(res.data).toMatchObject({ reason: 'already_requested' });
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });
});
