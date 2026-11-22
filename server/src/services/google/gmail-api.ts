/**
 * Gmail REST seam (ADR 0060). One narrow interface, two implementations:
 *   - real: bare fetch() to gmail.googleapis.com with the user's bearer (SSRF-safe
 *     — only ever the Gmail API, keyed by the user's own token; never a URL from
 *     an email body). Small retry on 429 / 5xx.
 *   - mock: deterministic in-memory fixtures so the reader + sync + reply flow
 *     runs with no Google account (tests, mock-LLM demos). Selected by
 *     env.GMAIL_PROVIDER, mirroring LLM_PROVIDER=mock.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import type { GmailHistoryRecord, GmailPayload, GmailRawMessage } from './gmail-sync.js';
import { getAccessToken } from './oauth.service.js';
import { fetchWithTimeout } from '../../utils/fetch-timeout.js';

export type { GmailRawMessage } from './gmail-sync.js';

/**
 * One address this mailbox may send as (ADR 0130).
 *
 * `verificationStatus` is the load-bearing field: Gmail silently REWRITES the
 * From header to the authenticated address when an alias is not verified, so
 * offering an unverified one would promise something that does not happen.
 */
export interface GmailSendAs {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  treatAsAlias?: boolean;
  /** 'accepted' | 'pending' | 'custom' | undefined (undefined for the primary). */
  verificationStatus?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
}

export interface GmailApi {
  listMessages(opts: {
    q?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ messages: { id: string; threadId: string }[]; nextPageToken?: string }>;
  /** The mailbox's current historyId (users.getProfile, 1 quota unit), and
   *  its own address - which for a Microsoft or Apple sign-in is not the
   *  account's sign-in email. */
  getProfile(): Promise<{ historyId: string; emailAddress?: string }>;
  /** null = the message no longer exists (deleted between list/history and fetch). */
  getMessage(id: string, format: 'metadata' | 'full'): Promise<GmailRawMessage | null>;
  listHistory(opts: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<{ history?: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string; notFound?: boolean }>;
  sendMessage(raw: string, threadId?: string): Promise<GmailRawMessage>;
  /** Download one attachment body (base64url `data`) by part id. */
  getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }>;
  modifyThread(
    threadId: string,
    mod: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<void>;
  /** Change labels on single messages (the reader marks each one read as it
   *  is seen). Gmail's batchModify, up to 1000 ids. */
  modifyMessages(
    messageIds: string[],
    mod: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<void>;
  /** Move a thread to Trash (ADR 0215). Covered by gmail.modify; Gmail purges
   *  it after 30 days. Permanent delete would need the full-mail scope. */
  trashThread(threadId: string): Promise<void>;
  listLabels(): Promise<GmailLabel[]>;
  /** Addresses this mailbox may send as. Covered by gmail.modify - no new scope. */
  listSendAs(): Promise<GmailSendAs[]>;
  createLabel(name: string): Promise<GmailLabel>;
  /**
   * Ask Gmail to publish change notifications to a Pub/Sub topic
   * (ADR 0118). Returns the mailbox's current historyId and the watch's
   * expiry — Gmail caps it at 7 days and renewal is our problem.
   *
   * Addressed by mailbox rather than by an id: calling it again replaces
   * the existing watch, which is what makes renewal a re-call.
   */
  watch(topicName: string): Promise<{ historyId: string; expiration: string }>;
  /** Stop publishing. Used when a mailbox disconnects. */
  stopWatch(): Promise<void>;
  /**
   * ADR 0303 — the mailbox's own Drafts folder, covered by gmail.modify.
   * Optional so a partial test double need not carry them; a mailbox without
   * them simply gets no provider copy.
   */
  createDraft?(raw: string, threadId?: string): Promise<{ id: string }>;
  /** Replace a draft's message. null = the draft is gone (sent or deleted in Gmail). */
  updateDraft?(id: string, raw: string, threadId?: string): Promise<{ id: string } | null>;
  /** Already gone is a success. */
  deleteDraft?(id: string): Promise<void>;
  /** The ids, of those given, that are no longer drafts (deleted or sent in Gmail). */
  missingDrafts?(ids: string[]): Promise<Set<string>>;
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
// List-Unsubscribe / List-Id are the ADR 0109 bulk signals. Metadata format
// returns ONLY the headers named here, which is why they were invisible.
const METADATA_HEADERS = [
  'From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'References', 'In-Reply-To',
  'List-Unsubscribe', 'List-Id',
];

async function gfetch<T>(
  accessToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string | string[]>; body?: unknown; allow404?: boolean } = {},
): Promise<{ ok: true; json: T } | { ok: false; status: number }> {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, v);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchWithTimeout(
      url.toString(),
      {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      },
      `gmail ${method} ${path}`,
    );
    if (res.ok) return { ok: true, json: (await res.json().catch(() => ({}))) as T };
    if (opts.allow404 && res.status === 404) return { ok: false, status: 404 };
    // 429 (rateLimitExceeded) / 5xx — capped backoff then retry.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`gmail ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error(`gmail ${method} ${path}: exhausted retries`);
}

export function realGmailApi(accessToken: string): GmailApi {
  return {
    async listMessages({ q, pageToken, maxResults }) {
      const query: Record<string, string> = { maxResults: String(maxResults ?? 100) };
      if (q) query.q = q;
      if (pageToken) query.pageToken = pageToken;
      const r = await gfetch<{
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
      }>(accessToken, 'GET', '/messages', { query });
      if (!r.ok) throw new Error('gmail messages.list failed');
      return { messages: r.json.messages ?? [], nextPageToken: r.json.nextPageToken };
    },
    async getProfile() {
      const r = await gfetch<{ historyId?: string; emailAddress?: string }>(accessToken, 'GET', '/profile');
      if (!r.ok || !r.json.historyId) throw new Error('gmail users.getProfile failed');
      return {
        historyId: r.json.historyId,
        ...(r.json.emailAddress ? { emailAddress: r.json.emailAddress } : {}),
      };
    },
    async getMessage(id, format) {
      const query: Record<string, string | string[]> = { format };
      if (format === 'metadata') query.metadataHeaders = METADATA_HEADERS;
      const r = await gfetch<GmailRawMessage>(accessToken, 'GET', `/messages/${id}`, {
        query,
        allow404: true,
      });
      if (!r.ok) return null;
      return r.json;
    },
    async listHistory({ startHistoryId, pageToken }) {
      const query: Record<string, string> = { startHistoryId };
      if (pageToken) query.pageToken = pageToken;
      const r = await gfetch<{
        history?: GmailHistoryRecord[];
        historyId?: string;
        nextPageToken?: string;
      }>(accessToken, 'GET', '/history', { query, allow404: true });
      if (!r.ok) return { notFound: true };
      return r.json;
    },
    async sendMessage(raw, threadId) {
      const r = await gfetch<GmailRawMessage>(accessToken, 'POST', '/messages/send', {
        body: threadId ? { raw, threadId } : { raw },
      });
      if (!r.ok) throw new Error('gmail messages.send failed');
      return r.json;
    },
    async getAttachment(messageId, attachmentId) {
      const r = await gfetch<{ data?: string; size?: number }>(
        accessToken,
        'GET',
        `/messages/${messageId}/attachments/${attachmentId}`,
      );
      if (!r.ok || !r.json.data) throw new Error('gmail attachments.get failed');
      return { data: r.json.data, size: r.json.size ?? 0 };
    },
    async modifyThread(threadId, mod) {
      await gfetch(accessToken, 'POST', `/threads/${threadId}/modify`, { body: mod });
    },
    async modifyMessages(messageIds, mod) {
      if (messageIds.length === 0) return;
      await gfetch(accessToken, 'POST', '/messages/batchModify', { body: { ids: messageIds, ...mod } });
    },
    async trashThread(threadId) {
      await gfetch(accessToken, 'POST', `/threads/${threadId}/trash`);
    },
    async watch(topicName) {
      const r = await gfetch<{ historyId?: string; expiration?: string }>(
        accessToken,
        'POST',
        '/watch',
        { body: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' } },
      );
      if (!r.ok) throw new Error('gmail users.watch failed');
      return {
        historyId: r.json.historyId ?? '0',
        // Gmail returns epoch millis as a string.
        expiration: r.json.expiration ?? String(Date.now() + 7 * 24 * 3600_000),
      };
    },
    async stopWatch() {
      await gfetch(accessToken, 'POST', '/stop', { body: {} });
    },
    async createDraft(raw, threadId) {
      const r = await gfetch<{ id?: string }>(accessToken, 'POST', '/drafts', {
        body: { message: threadId ? { raw, threadId } : { raw } },
      });
      if (!r.ok || !r.json.id) throw new Error('gmail drafts.create failed');
      return { id: r.json.id };
    },
    async updateDraft(id, raw, threadId) {
      const r = await gfetch<{ id?: string }>(accessToken, 'PUT', `/drafts/${encodeURIComponent(id)}`, {
        body: { message: threadId ? { raw, threadId } : { raw } },
        allow404: true,
      });
      if (!r.ok) return null;
      return { id: r.json.id ?? id };
    },
    async deleteDraft(id) {
      await gfetch(accessToken, 'DELETE', `/drafts/${encodeURIComponent(id)}`, { allow404: true });
    },
    async missingDrafts(ids) {
      const missing = new Set<string>();
      for (const id of ids) {
        const r = await gfetch(accessToken, 'GET', `/drafts/${encodeURIComponent(id)}`, {
          query: { format: 'minimal' },
          allow404: true,
        });
        // Any other failure throws inside gfetch: an outage is not a deletion.
        if (!r.ok) missing.add(id);
      }
      return missing;
    },
    async listLabels() {
      const r = await gfetch<{ labels?: GmailLabel[] }>(accessToken, 'GET', '/labels');
      if (!r.ok) throw new Error('gmail labels.list failed');
      return r.json.labels ?? [];
    },
    async listSendAs() {
      const r = await gfetch<{ sendAs?: GmailSendAs[] }>(accessToken, 'GET', '/settings/sendAs');
      if (!r.ok) throw new Error('gmail settings.sendAs.list failed');
      return r.json.sendAs ?? [];
    },
    async createLabel(name) {
      const r = await gfetch<GmailLabel>(accessToken, 'POST', '/labels', {
        body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      if (!r.ok) throw new Error('gmail labels.create failed');
      return r.json;
    },
  };
}

// ── mock provider ─────────────────────────────────────────────────────
interface MockMailbox {
  messages: Map<string, GmailRawMessage>;
  /** Spam-labeled messages — served only by an `in:spam` list (junk peek). */
  junk: Map<string, GmailRawMessage>;
  labels: Map<string, GmailLabel>;
  /** attachmentId → base64url content, served by getAttachment. */
  attachments: Map<string, string>;
  historyId: number;
  /** Arrivals recorded by `__pushGmailMockArrival`, served by listHistory. */
  history: { id: number; rec: GmailHistoryRecord }[];
  /** Test hook: the next N modifyThread calls fail like a Gmail outage. */
  modifyFailures?: number;
  /** Test hook: every listHistory call throws this message, as Gmail's quota 403 does. */
  historyError?: string;
  /** listHistory calls made, failed or not. */
  historyCalls?: number;
  /** Test hook: hand out a new attachment id on every read, as Gmail does
   *  (the old ids keep working). */
  rotateAttachmentIds?: number;
  /** ADR 0303 — draft id → the decoded RFC 822 text and Gmail thread id. */
  drafts?: Map<string, { mime: string; threadId: string | null }>;
  /** Test hook: the next N draft writes fail like a Gmail outage. */
  draftFailures?: number;
}
const mockStore = new Map<string, MockMailbox>();

/** Test helper — the drafts Gmail holds for this mailbox. */
export function __gmailMockDrafts(key: string): Map<string, { mime: string; threadId: string | null }> {
  const mb = mockMailboxFor(key);
  mb.drafts ??= new Map();
  return mb.drafts;
}

/** Test helper — the user deletes a label in Gmail. */
export function __deleteGmailMockLabel(key: string, name: string): void {
  const mb = mockMailboxFor(key);
  for (const [id, l] of mb.labels) if (l.name === name) mb.labels.delete(id);
}

/** Test helper — the next `n` draft writes fail (503). */
export function __failGmailMockDrafts(key: string, n: number): void {
  mockMailboxFor(key).draftFailures = n;
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Test/dev helper — wipe the in-memory mock mailboxes. */
/** Test helper — from now on every read of a message gives its attachments new ids. */
export function __rotateGmailMockAttachmentIds(userId: string): void {
  mockMailboxFor(userId).rotateAttachmentIds = 0;
}

export function __resetGmailMock(): void {
  mockStore.clear();
}

/** Test/dev helper — remove a message from a user's mock mailbox, simulating
 *  a Google-side permanent delete (or trash purge) between syncs. */
export function __deleteGmailMockMessage(userId: string, messageId: string): void {
  mockStore.get(userId)?.messages.delete(messageId);
}

/** Test/dev helper — inject a raw message into a user's mock mailbox (e.g. a
 *  calendar-invite email that the seeded fixture deliberately lacks). */
export function __addGmailMockMessage(userId: string, raw: GmailRawMessage): void {
  mockMailboxFor(userId).messages.set(raw.id, raw);
}

/**
 * Load-test helper: deliver a NEW message after the mailbox was first synced,
 * the way Gmail does. The message lands and a history record says so, so an
 * incremental sync finds it. `__addGmailMockMessage` stays silent on purpose
 * (existing tests add fixtures that the backfill lists).
 */
export function __pushGmailMockArrival(userId: string, raw: GmailRawMessage): void {
  const mb = mockMailboxFor(userId);
  mb.messages.set(raw.id, raw);
  mb.historyId += 1;
  mb.history.push({
    id: mb.historyId,
    rec: {
      id: String(mb.historyId),
      messagesAdded: [{ message: { id: raw.id, threadId: raw.threadId } }],
    },
  });
}

/** Test helper — the next `n` modifyThread calls fail (503). */
export function __failGmailMockModify(key: string, n: number): void {
  mockMailboxFor(key).modifyFailures = n;
}

/** Test helper — every listHistory call fails with `message` until called with null. */
export function __failGmailMockHistory(key: string, message: string | null): void {
  mockMailboxFor(key).historyError = message ?? undefined;
}

/** Test helper — how many times listHistory has been called for this mailbox. */
export function __gmailMockHistoryCalls(key: string): number {
  return mockMailboxFor(key).historyCalls ?? 0;
}

/** Test helper — the label set Gmail itself holds for a message. */
export function __gmailMockLabels(key: string, messageId: string): string[] | null {
  return mockMailboxFor(key).messages.get(messageId)?.labelIds ?? null;
}

/** Test/dev helper — the bytes `getAttachment` serves for `attachmentId`. */
export function __setGmailMockAttachment(key: string, attachmentId: string, bytes: Buffer): void {
  mockMailboxFor(key).attachments.set(attachmentId, bytes.toString('base64url'));
}

/** Test/dev helper — inject a spam message (served by the junk peek only). */
export function __addGmailMockJunk(userId: string, raw: GmailRawMessage): void {
  mockMailboxFor(userId).junk.set(raw.id, raw);
}

function hdr(name: string, value: string) {
  return { name, value };
}

function mockMessage(
  id: string,
  threadId: string,
  opts: {
    from: string;
    to: string;
    subject: string;
    date: number; // ms epoch
    body: string;
    labels: string[];
    messageId: string;
    references?: string;
    inReplyTo?: string;
  },
): GmailRawMessage {
  const headers = [
    hdr('From', opts.from),
    hdr('To', opts.to),
    hdr('Subject', opts.subject),
    hdr('Date', new Date(opts.date).toUTCString()),
    hdr('Message-ID', opts.messageId),
  ];
  if (opts.references) headers.push(hdr('References', opts.references));
  if (opts.inReplyTo) headers.push(hdr('In-Reply-To', opts.inReplyTo));
  return {
    id,
    threadId,
    labelIds: opts.labels,
    snippet: opts.body.slice(0, 80),
    internalDate: String(opts.date),
    historyId: '1',
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: Buffer.from(opts.body, 'utf8').toString('base64url') },
    },
  };
}

/** Deterministic seed: a handful of threads across categories the mock
 *  classifier also knows about (Finance / Travel / Deliveries / Family). */
function seedMailbox(): MockMailbox {
  const day = 86_400_000;
  const base = 1_700_000_000_000; // fixed epoch — deterministic, no Date.now()
  const msgs: GmailRawMessage[] = [
    mockMessage('m_stmt1', 't_finance1', {
      from: 'Chase <no-reply@chase.com>',
      to: 'you@example.com',
      subject: 'Your April statement is ready',
      date: base + 1 * day,
      body: 'Your statement balance is $1,204.55, due May 6.',
      labels: ['INBOX', 'UNREAD'],
      messageId: '<stmt1@chase.com>',
    }),
    mockMessage('m_flight1', 't_travel1', {
      from: 'United <no-reply@united.com>',
      to: 'you@example.com',
      subject: 'Your trip to SFO — check in now',
      date: base + 2 * day,
      body: 'Confirmation KX8QP2. Flight UA 512 departs Fri 6:40am, seat 14C.',
      labels: ['INBOX', 'UNREAD'],
      messageId: '<flight1@united.com>',
    }),
    mockMessage('m_ship1', 't_ship1', {
      from: 'Amazon <ship-confirm@amazon.com>',
      to: 'you@example.com',
      subject: 'Your package is arriving today',
      date: base + 3 * day,
      body: 'Your order of "USB-C hub" is out for delivery.',
      labels: ['INBOX'],
      messageId: '<ship1@amazon.com>',
    }),
    mockMessage('m_fam1', 't_fam1', {
      from: 'Grandma <grandma@example.com>',
      to: 'you@example.com',
      subject: 'Sunday dinner?',
      date: base + 4 * day,
      body: 'Are you all coming over this Sunday at 5pm? Let me know!',
      labels: ['INBOX', 'UNREAD'],
      messageId: '<fam1@example.com>',
    }),
  ];
  const mailbox: MockMailbox = {
    messages: new Map(),
    junk: new Map(),
    labels: new Map(),
    attachments: new Map(),
    historyId: 100,
    history: [],
  };
  for (const m of msgs) mailbox.messages.set(m.id, m);

  // One seeded junk message — the on-demand junk peek (codes land in spam
  // constantly) is demonstrable with no Google account.
  const junkMsg = mockMessage('m_junk1', 't_junk1', {
    from: 'Acme Accounts <no-reply@service.example>',
    to: 'you@example.com',
    subject: 'Your verification code is 774051',
    date: base + 5 * day,
    body: 'Your verification code is 774051. It expires in 10 minutes.',
    labels: ['SPAM', 'UNREAD'],
    messageId: '<junk1@service.example>',
  });
  mailbox.junk.set(junkMsg.id, junkMsg);

  // One seeded attachment (ADR 0071): the flight email carries an itinerary
  // file so the email→knowledge-base import path is exercised with no Google.
  const itinerary = [
    'United Airlines itinerary — confirmation KX8QP2',
    'Flight UA 512, Friday 6:40am, SFO, seat 14C.',
    'Baggage: 1 checked bag included.',
  ].join('\n');
  const itineraryB64 = Buffer.from(itinerary, 'utf8').toString('base64url');
  mailbox.attachments.set('att_flight1', itineraryB64);
  const flight = mailbox.messages.get('m_flight1')!;
  flight.payload = {
    mimeType: 'multipart/mixed',
    headers: flight.payload?.headers,
    parts: [
      { mimeType: 'text/plain', body: flight.payload?.body },
      {
        mimeType: 'text/plain',
        filename: 'UA512-itinerary.txt',
        body: { attachmentId: 'att_flight1', size: itinerary.length },
      },
    ],
  };
  return mailbox;
}

function mockMailboxFor(userId: string): MockMailbox {
  let mb = mockStore.get(userId);
  if (!mb) {
    mb = seedMailbox();
    mockStore.set(userId, mb);
  }
  return mb;
}

/** The address the mock mailbox reports as its own. */
export const MOCK_GMAIL_ADDRESS = 'me@gmail.example';

export function mockGmailApi(userId: string): GmailApi {
  const mb = mockMailboxFor(userId);
  return {
    async listMessages({ q, pageToken }) {
      if (pageToken) return { messages: [] };
      // The junk peek lists `in:spam`; everything else is the normal mailbox
      // (whose real API counterpart already excludes spam by default).
      const source = /in:spam/.test(q ?? '') ? mb.junk : mb.messages;
      // The two label searches the backfill's read/inbox reconcile issues.
      const wanted = [
        ...(/is:unread/.test(q ?? '') ? ['UNREAD'] : []),
        ...(/in:inbox/.test(q ?? '') ? ['INBOX'] : []),
      ];
      // Like the real API (includeSpamTrash defaults to false), trashed mail
      // is left out of a listing.
      const messages = [...source.values()]
        .filter((m) => !(m.labelIds ?? []).includes('TRASH'))
        .filter((m) => wanted.every((l) => (m.labelIds ?? []).includes(l)))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
        .map((m) => ({ id: m.id, threadId: m.threadId }));
      return { messages };
    },
    async getProfile() {
      return { historyId: String(mb.historyId), emailAddress: MOCK_GMAIL_ADDRESS };
    },
    async getMessage(id) {
      const m = mb.messages.get(id) ?? mb.junk.get(id) ?? null;
      if (!m || mb.rotateAttachmentIds === undefined) return m;
      const read = ++mb.rotateAttachmentIds;
      const rotate = (part: GmailPayload): GmailPayload => {
        const attachmentId = part.body?.attachmentId;
        if (!attachmentId) return { ...part, ...(part.parts ? { parts: part.parts.map(rotate) } : {}) };
        const base = attachmentId.split('~')[0]!;
        const fresh = `${base}~${read}`;
        mb.attachments.set(fresh, mb.attachments.get(base)!);
        return { ...part, body: { ...part.body, attachmentId: fresh } };
      };
      return m.payload ? { ...m, payload: rotate(m.payload) } : m;
    },
    async listHistory({ startHistoryId }) {
      mb.historyCalls = (mb.historyCalls ?? 0) + 1;
      if (mb.historyError) throw new Error(mb.historyError);
      // No external drift unless a load test pushed arrivals: report the
      // current cursor plus any arrival recorded after the caller's.
      const from = Number(startHistoryId) || 0;
      return {
        history: mb.history.filter((h) => h.id > from).map((h) => h.rec),
        historyId: String(Math.max(mb.historyId, from)),
      };
    },
    async sendMessage(raw, threadId) {
      const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const [head = '', ...rest] = decoded.split('\r\n\r\n');
      const body = rest.join('\r\n\r\n');
      // Read the headers we were actually handed. The old mock hardcoded a
      // subject and a recipient, which was survivable while the only caller was
      // the reply path — but it meant a compose test could not tell a preserved
      // subject from a discarded one.
      const header = (name: string): string | null => {
        const m = head.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
        return m ? m[1].trim() : null;
      };
      mb.historyId += 1;
      const id = `m_sent_${mb.historyId}`;
      const tid = threadId ?? `t_sent_${mb.historyId}`;
      const sent = mockMessage(id, tid, {
        from: header('From') ?? 'you@example.com',
        to: header('To') ?? 'recipient@example.com',
        subject: header('Subject') ?? '(no subject)',
        date: 1_700_000_000_000 + mb.historyId * 1000,
        body,
        labels: ['SENT'],
        messageId: `<${id}@example.com>`,
      });
      mb.messages.set(id, sent);
      return sent;
    },
    async getAttachment(_messageId, attachmentId) {
      const data = mb.attachments.get(attachmentId);
      if (!data) throw new Error(`gmail GET /messages/${_messageId}/attachments/${attachmentId} 404: not found`);
      return { data, size: Buffer.from(data, 'base64url').byteLength };
    },
    async watch() {
      return {
        historyId: String(mb.historyId),
        expiration: String(Date.now() + 7 * 24 * 3600_000),
      };
    },
    async stopWatch() {
      /* nothing registered in the mock */
    },
    async createDraft(raw, threadId) {
      if ((mb.draftFailures ?? 0) > 0) {
        mb.draftFailures = (mb.draftFailures ?? 0) - 1;
        throw new Error('gmail POST /drafts 503: backend error');
      }
      mb.drafts ??= new Map();
      mb.historyId += 1;
      const id = `r_draft_${mb.historyId}`;
      mb.drafts.set(id, { mime: decodeRaw(raw), threadId: threadId ?? null });
      return { id };
    },
    async updateDraft(id, raw, threadId) {
      if ((mb.draftFailures ?? 0) > 0) {
        mb.draftFailures = (mb.draftFailures ?? 0) - 1;
        throw new Error(`gmail PUT /drafts/${id} 503: backend error`);
      }
      if (!mb.drafts?.has(id)) return null;
      mb.drafts.set(id, { mime: decodeRaw(raw), threadId: threadId ?? null });
      return { id };
    },
    async deleteDraft(id) {
      mb.drafts?.delete(id);
    },
    async missingDrafts(ids) {
      return new Set(ids.filter((id) => !mb.drafts?.has(id)));
    },
    async modifyMessages(messageIds, mod) {
      if ((mb.modifyFailures ?? 0) > 0) {
        mb.modifyFailures = (mb.modifyFailures ?? 0) - 1;
        throw new Error('gmail POST /messages/batchModify 503: backend error');
      }
      for (const id of messageIds) {
        const m = mb.messages.get(id);
        if (!m) continue;
        const set = new Set(m.labelIds ?? []);
        for (const l of mod.removeLabelIds ?? []) set.delete(l);
        for (const l of mod.addLabelIds ?? []) set.add(l);
        m.labelIds = [...set];
      }
    },
    async modifyThread(threadId, mod) {
      if ((mb.modifyFailures ?? 0) > 0) {
        mb.modifyFailures = (mb.modifyFailures ?? 0) - 1;
        throw new Error(`gmail POST /threads/${threadId}/modify 503: backend error`);
      }
      for (const m of mb.messages.values()) {
        if (m.threadId !== threadId) continue;
        const set = new Set(m.labelIds ?? []);
        for (const l of mod.removeLabelIds ?? []) set.delete(l);
        for (const l of mod.addLabelIds ?? []) set.add(l);
        m.labelIds = [...set];
      }
      // Rescuing out of spam moves the message into the normal mailbox.
      if ((mod.removeLabelIds ?? []).includes('SPAM')) {
        for (const [id, m] of [...mb.junk]) {
          if (m.threadId !== threadId) continue;
          const set = new Set(m.labelIds ?? []);
          set.delete('SPAM');
          for (const l of mod.addLabelIds ?? []) set.add(l);
          m.labelIds = [...set];
          mb.junk.delete(id);
          mb.messages.set(id, m);
        }
      }
      mb.historyId += 1;
    },
    async trashThread(threadId) {
      for (const m of mb.messages.values()) {
        if (m.threadId !== threadId) continue;
        m.labelIds = [...(m.labelIds ?? []).filter((l) => l !== 'INBOX'), 'TRASH'];
      }
      mb.historyId += 1;
    },
    async listLabels() {
      return [...mb.labels.values()];
    },
    async listSendAs() {
      // One verified alias and one that is not, so a test can tell that the
      // unverified one is filtered rather than merely absent.
      return [
        { sendAsEmail: 'me@example.com', isPrimary: true, isDefault: true },
        {
          sendAsEmail: 'alias@example.com',
          displayName: 'Alias',
          treatAsAlias: true,
          verificationStatus: 'accepted',
        },
        {
          sendAsEmail: 'unverified@example.com',
          treatAsAlias: true,
          verificationStatus: 'pending',
        },
      ];
    },
    async createLabel(name) {
      // Gmail refuses a name it already has, ignoring case and spacing.
      const key = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();
      if ([...mb.labels.values()].some((l) => key(l.name) === key(name))) {
        throw new Error('gmail POST /labels 409: Label name exists or conflicts');
      }
      const label = { id: `Label_${mb.labels.size + 1}`, name };
      mb.labels.set(label.id, label);
      return label;
    },
  };
}

/** Build the Gmail API client for a user — mock or real per env.GMAIL_PROVIDER. */
export async function getGmailApi(db: Kysely<DB>, userId: string): Promise<GmailApi> {
  if (env.GMAIL_PROVIDER === 'mock') return mockGmailApi(userId);
  const accessToken = await getAccessToken(db, userId);
  return realGmailApi(accessToken);
}
