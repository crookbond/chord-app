/**
 * IMAP/SMTP seam (ADR 0080) — the one provider where hand-rolling the protocol
 * would obscure more than it helps: real implementation uses imapflow (read),
 * mailparser (MIME), and nodemailer (send). A deterministic mock mirrors
 * GMAIL_PROVIDER=mock so Yahoo/AOL/iCloud flows run keyless in tests/demos.
 * Connections are per-operation (open → work → logout) — sync is minutes-apart
 * polling, not a held-open IDLE session.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';

import {
  addressOf,
  normalizeContentId,
  parseAuthenticationResults,
  type EmailAttachmentRef,
  type SenderAuth,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { decodeText } from '../../utils/text-decode.js';
import { isAutoSubmitted } from '../google/gmail-sync.js';
import { AccountAuthError, type ImapAuth } from './account-utils.js';
import type { ImapFolder } from './imap-sync.js';

/** One fetched + parsed message, ready to normalize into the mirror. */
export interface ImapFetchedMessage {
  uid: number;
  flags: string[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  /** ISO date (header date, falling back to internal). */
  date: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Raw iCalendar payload when the message carries a text/calendar or .ics
   *  part — the ADR 0074 invite probe parses it deterministically. */
  icsText?: string | null;
  /** Non-calendar attachment metadata; ids are `i<index>` into the same
   *  filtered part list `fetchAttachment` indexes. */
  attachments?: EmailAttachmentRef[];
  /** ADR 0109 bulk signals, raw. IMAP parses the whole source at sync, so these
   *  cost nothing extra here. */
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  listId?: string | null;
  /** ADR 0294 — Reply-To address and the topmost Authentication-Results. */
  replyTo?: string | null;
  authResults?: SenderAuth | null;
  /** ADR 0314 — the message carries `Auto-Submitted` (other than "no"). */
  autoReply?: boolean;
}

export interface ImapSendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** Files to send (ADR 0111). nodemailer takes the buffers as they are. */
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
  /** RFC 3834 — an automatic reply says so (`Auto-Submitted: auto-replied`). */
  autoSubmitted?: boolean;
}

export interface ImapApi {
  /** Login check at connect time — throws AccountAuthError on bad credentials. */
  verify(): Promise<void>;
  /** UIDVALIDITY + every UID in the INBOX window (newest last). */
  listWindow(windowDays: number): Promise<{ uidValidity: string; uids: number[] }>;
  /**
   * The Sent mailbox's window (ADR 0116), so the mirror holds mail the user
   * sent from anywhere rather than only what Chord sent. Null when the
   * account has no Sent folder to read — a real state on a bare IMAP host,
   * and not one to guess around.
   */
  listSentWindow(windowDays: number): Promise<{ uidValidity: string; uids: number[] } | null>;
  /** Fetch + parse messages from the Sent mailbox. */
  fetchSent(uids: number[]): Promise<ImapFetchedMessage[]>;
  /** Fetch + parse full messages for the given UIDs. */
  fetch(uids: number[]): Promise<ImapFetchedMessage[]>;
  /** Current flags for the given UIDs (read-state convergence). */
  fetchFlags(uids: number[]): Promise<Map<number, string[]>>;
  setSeen(uids: number[], seen: boolean): Promise<void>;
  /**
   * ADR 0142 — add/remove custom keywords on a batch of UIDs in one open.
   * Caller must have already probed that the server accepts custom keywords.
   */
  setKeywords(uids: number[], add: string[], remove: string[]): Promise<void>;
  /**
   * ADR 0142 — true when INBOX PERMANENTFLAGS includes `\*` (custom keywords).
   */
  probeKeywordSupport(): Promise<boolean>;
  /**
   * Move messages between INBOX and the Archive folder. Returns false when the
   * mailbox has no archive folder to move to — the caller must NOT then record
   * the thread as archived locally (ADR 0107: a write we did not perform must
   * not report that we performed it).
   */
  setArchived(uids: number[], archived: boolean): Promise<boolean>;
  /** Move INBOX messages to the Trash folder (ADR 0215). False when the
   *  mailbox has none — same contract as `setArchived`. */
  moveToTrash(uids: number[]): Promise<boolean>;
  /** ADR 0309 — move INBOX messages into the mailbox named `folder` (any
   *  case), creating it when there is none. With `create: false` and no such
   *  mailbox, nothing moves and the answer is false. */
  moveToFolder(uids: number[], folder: string, opts?: { create?: boolean }): Promise<boolean>;
  /** SMTP send (reply headers included by the caller). Returns the
   *  Message-ID the message went out with, so the copy the server later files
   *  in Sent can be recognised as this one. */
  send(input: ImapSendInput): Promise<{ messageId: string | null }>;
  /** SMTP send of a ready-made RFC 822 message (ADR 0312: an iTIP reply). */
  sendRaw(input: { from: string; to: string[]; raw: string }): Promise<void>;
  /** Newest messages in the junk/spam/bulk folder (live peek, not mirrored). */
  listJunk(windowDays: number, limit: number): Promise<ImapFetchedMessage[]>;
  /** "Not junk" — move a junk-folder UID into INBOX. */
  rescueJunk(uid: number): Promise<void>;
  /**
   * Which of these vanished-from-INBOX messages landed in Trash? IMAP reports
   * a move-to-Archive and a delete identically (the UID is simply gone), and
   * only a delete should retract the thread's pending to-dos (ADR 0073).
   * Matched on Message-ID, since the UID changes across folders.
   *
   * Takes the whole batch because it resolves in ONE connection: Yahoo
   * throttles on login rate, and asking per message made a mass-archive cost
   * one login apiece.
   */
  findInTrash(rfc822MessageIds: string[]): Promise<Set<string>>;
  /** One attachment's bytes by `i<index>` id (re-fetches + parses the source).
   *  `folder` says which mailbox the UID belongs to — UIDs are per mailbox. */
  fetchAttachment(
    uid: number,
    index: number,
    folder?: ImapFolder,
  ): Promise<{ filename: string; mimeType: string; content: Buffer } | null>;
  /**
   * ADR 0303 - file `mime` in the Drafts folder (flagged \Draft), then remove
   * the copy `replaceRef` names. Returns the new copy's ref, or null when the
   * account has no Drafts folder or no UIDPLUS (it could not say where the
   * copy went). Optional for test doubles.
   */
  /**
   * `{ gone: true }` when `replaceRef` names a copy no longer in its folder
   * (deleted in another mail app): nothing is written, so the caller can
   * honour that deletion instead of putting the draft back.
   */
  saveDraft?(mime: string, replaceRef: string | null): Promise<string | null | { gone: true }>;
  /** Remove a copy `saveDraft` made. Already gone is a success. */
  deleteDraft?(ref: string): Promise<void>;
  /**
   * The refs, of those given, whose copy is no longer in its folder. A folder
   * whose UIDVALIDITY changed cannot be judged and is never reported.
   */
  missingDrafts?(refs: string[]): Promise<Set<string>>;
}

/** Where an IMAP draft copy lives: UIDs are only meaningful per mailbox and
 *  per UIDVALIDITY, so the ref carries all three. */
interface ImapDraftRef {
  path: string;
  uidValidity: string;
  uid: number;
}

export function encodeImapDraftRef(r: ImapDraftRef): string {
  return JSON.stringify(r);
}

export function decodeImapDraftRef(ref: string): ImapDraftRef | null {
  try {
    const r = JSON.parse(ref) as Partial<ImapDraftRef>;
    return typeof r.path === 'string' && typeof r.uid === 'number' && typeof r.uidValidity === 'string'
      ? (r as ImapDraftRef)
      : null;
  } catch {
    return null;
  }
}

// ── real implementation ───────────────────────────────────────────────
/**
 * Yahoo answers connection throttling with an auth-SHAPED failure — it sets
 * `authenticationFailed` on a `[UNAVAILABLE]` / rate-limit response — so
 * reading "auth-shaped" as "the app password is dead" costs the user a
 * credential that was never wrong. Transient markers therefore win over the
 * auth shape, and the positive arm matches real rejections rather than any
 * message containing the word "login".
 */
const TRANSIENT_IMAP =
  /\[(UNAVAILABLE|INUSE|LIMIT|SERVERBUG|CONTACTADMIN)\]|too many|rate.?limit|throttl|temporar|try again|timed? ?out|socket|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i;

const REJECTED_IMAP = /AUTHENTICATIONFAILED|invalid credential|invalid password|incorrect password|authentication failed|LOGIN failed/i;

export function isAuthFailure(err: unknown): boolean {
  const e = err as {
    authenticationFailed?: boolean;
    responseText?: string;
    message?: string;
    code?: string;
  };
  const text = `${e?.responseText ?? ''} ${e?.message ?? ''} ${e?.code ?? ''}`;
  if (TRANSIENT_IMAP.test(text)) return false;
  return e?.authenticationFailed === true || REJECTED_IMAP.test(text);
}

/**
 * The other half of the same reading: the provider is momentarily refusing us
 * (throttled, busy, socket trouble) and the credential is fine.
 *
 * `isAuthFailure` returning false is NOT this — it also covers every ordinary
 * bug — so the positive test is its own function. Routes need it because such
 * a failure was reaching the express handler as a 500 "unhandled error",
 * blaming Chord for Yahoo's rate limiter and telling the client nothing it
 * could act on.
 */
export function isTransientProviderFailure(err: unknown): boolean {
  const e = err as { responseText?: string; message?: string; code?: string };
  return TRANSIENT_IMAP.test(`${e?.responseText ?? ''} ${e?.message ?? ''} ${e?.code ?? ''}`);
}

/**
 * A login held open across operations. IMAP is a stateful session protocol —
 * unlike the Gmail/Graph adapters this seam was modelled on, where every method
 * is an independent stateless HTTP call. Connecting costs a TLS handshake plus
 * LOGIN, and on Yahoo the login RATE is the throttled metric, so the unit of
 * work is a session rather than a call.
 *
 * Lazily connected (constructing one is free, so an SMTP-only path pays
 * nothing) and re-established if the socket dies mid-session.
 */
interface ImapConnection {
  /** Run against the live client; no mailbox selected. */
  use<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  /** Run with INBOX locked. */
  useInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  /** Run with `path` locked. */
  useMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function imapConnection(auth: ImapAuth): ImapConnection {
  let client: ImapFlow | null = null;

  const connect = async (): Promise<ImapFlow> => {
    const next = new ImapFlow({
      host: auth.host,
      port: auth.port,
      secure: auth.port === 993,
      auth: { user: auth.username, pass: auth.password },
      logger: false,
    });
    // Once connect() has settled, imapflow has no promise left to reject, so a
    // late failure (a login still running on a socket the server just dropped)
    // arrives as an 'error' event - and an 'error' event nobody listens for
    // ends the process. The awaited call still rejects; this only keeps the
    // event from being fatal.
    next.on('error', (err: Error) => {
      logger.warn('imap session error', { host: auth.host, err: err.message });
    });
    try {
      await next.connect();
    } catch (err) {
      if (isAuthFailure(err)) {
        throw new AccountAuthError(`imap login failed for ${auth.username}@${auth.host}`, {
          needsReconnect: true,
        });
      }
      throw err;
    }
    return next;
  };

  const ensure = async (): Promise<ImapFlow> => {
    // `usable` goes false when the server drops us — a long tick can outlive
    // an idle timeout, and silently reusing a dead socket would surface as a
    // spurious sync failure.
    if (client?.usable) return client;
    client = await connect();
    return client;
  };

  const withLock = async <T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> => {
    const live = await ensure();
    const lock = await live.getMailboxLock(path);
    try {
      return await fn(live);
    } finally {
      lock.release();
    }
  };

  return {
    async use(fn) {
      return fn(await ensure());
    },
    useInbox(fn) {
      return withLock('INBOX', fn);
    },
    useMailbox(path, fn) {
      return withLock(path, fn);
    },
    async close() {
      const live = client;
      client = null;
      if (live) await live.logout().catch(() => {});
    },
  };
}

/** The junk mailbox path: SPECIAL-USE \Junk, else a name-based guess. */
async function findJunkPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Junk');
  if (special) return special.path;
  const named = boxes.find((b) => /junk|spam|bulk/i.test(b.path));
  return named?.path ?? null;
}

/**
 * The archive mailbox path: SPECIAL-USE \Archive, else a name-based guess.
 * Deliberately does NOT fall back to Trash — archiving into the bin is a
 * destructive surprise, and no archive folder is a real answer (see
 * `setArchived`, which reports it rather than pretending).
 */
async function findArchivePath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Archive');
  if (special) return special.path;
  const named = boxes.find((b) => /^(archive|archived|all mail)$/i.test(b.path));
  return named?.path ?? null;
}

/** The sent mailbox path: SPECIAL-USE \Sent, else a name-based guess. */
async function findSentPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Sent');
  if (special) return special.path;
  const named = boxes.find((b) => /^(sent|sent items|sent mail|sent messages)$/i.test(b.path));
  return named?.path ?? null;
}

/** The drafts mailbox path: SPECIAL-USE \Drafts, else a name-based guess. */
async function findDraftsPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Drafts');
  if (special) return special.path;
  const named = boxes.find((b) => /^(drafts?|draft messages)$/i.test(b.path));
  return named?.path ?? null;
}

/** ADR 0309 — the path of the top-level mailbox named `name` (any case),
 *  created when there is none. Matched on the whole path, never the leaf
 *  name: "Receipts" must not land in "Work/Receipts". A server with a
 *  personal namespace ("INBOX.") files a top-level box under that prefix,
 *  which is also where `mailboxCreate` puts it. */
export async function ensureMailboxPath(client: ImapFlow, name: string, create = true): Promise<string | null> {
  const key = name.trim().toLowerCase();
  const prefix = ((client as unknown as { namespace?: { prefix?: string } }).namespace?.prefix ?? '').toLowerCase();
  const boxes = await client.list();
  const hit = boxes.find((b) => {
    const path = b.path.toLowerCase();
    return path === key || (prefix !== '' && path === prefix + key);
  });
  if (hit) return hit.path;
  if (!create) return null;
  const created = await client.mailboxCreate(name.trim());
  return created.path;
}

/** The trash mailbox path: SPECIAL-USE \Trash, else a name-based guess. */
async function findTrashPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Trash');
  if (special) return special.path;
  const named = boxes.find((b) => /^(trash|deleted items|deleted messages)$/i.test(b.path));
  return named?.path ?? null;
}

function addressList(a: AddressObject | AddressObject[] | undefined): string[] {
  const objs = Array.isArray(a) ? a : a ? [a] : [];
  return objs
    .flatMap((o) => o.value)
    .map((v) => v.address?.toLowerCase())
    .filter((v): v is string => !!v);
}

function isCalendarPart(a: { contentType?: string; filename?: string }): boolean {
  return (
    /text\/calendar|application\/ics/i.test(a.contentType ?? '') ||
    /\.ics$/i.test(a.filename ?? '')
  );
}

/**
 * One header, exactly as the sender wrote it.
 *
 * Read off `headerLines` rather than `parsed.headers`, which hands back a
 * parsed shape for the headers mailparser knows and a bare string for the rest
 * - and a `String(...)` over that union yields `[object Object]` the day
 * mailparser learns to structure one of these.
 */
function rawHeader(
  lines: readonly { readonly key: string; readonly line: string }[] | undefined,
  name: string,
): string | null {
  const hit = (lines ?? []).find((h) => h.key === name);
  if (!hit) return null;
  const value = hit.line.slice(hit.line.indexOf(':') + 1).trim();
  return value || null;
}

/** Parse one fetched raw message (shared by the INBOX fetch and junk peek). */
export async function parseFetchedMessage(msg: {
  uid: number;
  flags?: Set<string>;
  source?: Buffer;
}): Promise<ImapFetchedMessage | null> {
  if (!msg.source) return null;
  const parsed = await simpleParser(msg.source);
  const text = parsed.text ?? null;
  const icsPart = (parsed.attachments ?? []).find(isCalendarPart);
  const fileParts = (parsed.attachments ?? []).filter((a) => !isCalendarPart(a));
  return {
    uid: msg.uid,
    flags: [...(msg.flags ?? new Set<string>())],
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : parsed.references ?? null,
    subject: parsed.subject ?? '',
    fromName: parsed.from?.value?.[0]?.name || null,
    fromEmail: parsed.from?.value?.[0]?.address?.toLowerCase() ?? null,
    toEmails: addressList(parsed.to),
    ccEmails: addressList(parsed.cc),
    date: (parsed.date ?? new Date()).toISOString(),
    snippet: (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    bodyText: text,
    bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
    icsText: icsPart ? decodeText(icsPart.content) : null,
    listUnsubscribe: rawHeader(parsed.headerLines, 'list-unsubscribe'),
    listUnsubscribePost: rawHeader(parsed.headerLines, 'list-unsubscribe-post'),
    listId: rawHeader(parsed.headerLines, 'list-id'),
    // rawHeader takes the first, which for Authentication-Results is the
    // receiving provider's own (every relay prepends one).
    replyTo: ((r) => (r ? addressOf(r) : null))(rawHeader(parsed.headerLines, 'reply-to')),
    authResults: parseAuthenticationResults(rawHeader(parsed.headerLines, 'authentication-results')),
    autoReply: isAutoSubmitted(rawHeader(parsed.headerLines, 'auto-submitted')),
    attachments: fileParts.map((a, i) => ({
      id: `i${i}`,
      filename: a.filename ?? `attachment-${i + 1}`,
      mimeType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? a.content?.byteLength ?? 0,
      ...(a.cid ? { contentId: normalizeContentId(a.cid) } : {}),
    })),
  };
}

/** Every method bound to ONE connection; the session owner closes it. */
function imapApiOn(auth: ImapAuth, conn: ImapConnection): ImapApi {
  return {
    async verify() {
      await conn.useInbox(async () => {});
    },

    async listWindow(windowDays) {
      return conn.useInbox(async (client) => {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const uids = (await client.search({ since }, { uid: true })) || [];
        const uidValidity = String(client.mailbox && typeof client.mailbox === 'object'
          ? client.mailbox.uidValidity ?? '0'
          : '0');
        return { uidValidity, uids: [...uids].sort((a, b) => a - b) };
      });
    },

    async listSentWindow(windowDays) {
      const path = await conn.use(findSentPath);
      // No Sent folder is a real state on a bare IMAP host. Returning null
      // lets the sync skip the stream instead of guessing at a mailbox name
      // and syncing somebody's Drafts into their Sent (ADR 0116).
      if (!path) return null;
      return conn.useMailbox(path, async (client) => {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const uids = (await client.search({ since }, { uid: true })) || [];
        const uidValidity = String(
          client.mailbox && typeof client.mailbox === 'object'
            ? client.mailbox.uidValidity ?? '0'
            : '0',
        );
        return { uidValidity, uids: [...uids].sort((a, b) => a - b) };
      });
    },

    async fetchSent(uids) {
      if (uids.length === 0) return [];
      const path = await conn.use(findSentPath);
      if (!path) return [];
      return conn.useMailbox(path, async (client) => {
        const out: ImapFetchedMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(','),
          { uid: true, flags: true, source: true },
          { uid: true },
        )) {
          const parsed = await parseFetchedMessage(msg);
          if (parsed) out.push(parsed);
        }
        return out;
      });
    },

    async fetch(uids) {
      if (uids.length === 0) return [];
      return conn.useInbox(async (client) => {
        const out: ImapFetchedMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(','),
          { uid: true, flags: true, source: true },
          { uid: true },
        )) {
          const parsed = await parseFetchedMessage(msg);
          if (parsed) out.push(parsed);
        }
        return out;
      });
    },

    async fetchFlags(uids) {
      if (uids.length === 0) return new Map();
      return conn.useInbox(async (client) => {
        const map = new Map<number, string[]>();
        for await (const msg of client.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) {
          map.set(msg.uid, [...(msg.flags ?? new Set<string>())]);
        }
        return map;
      });
    },

    async setSeen(uids, seen) {
      if (uids.length === 0) return;
      await conn.useInbox(async (client) => {
        if (seen) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
      });
    },

    async setKeywords(uids, add, remove) {
      if (uids.length === 0) return;
      if (add.length === 0 && remove.length === 0) return;
      await conn.useInbox(async (client) => {
        if (add.length > 0) await client.messageFlagsAdd(uids.join(','), add, { uid: true });
        if (remove.length > 0) await client.messageFlagsRemove(uids.join(','), remove, { uid: true });
      });
    },

    async probeKeywordSupport() {
      return conn.useInbox(async (client) => {
        // imapflow exposes permanentFlags on the locked mailbox object.
        const flags = (client.mailbox as { permanentFlags?: Set<string> } | null)?.permanentFlags;
        if (!flags) return false;
        return flags.has('\\*') || flags.has('*');
      });
    },

    async setArchived(uids, archived) {
      if (uids.length === 0) return true;
      const path = await conn.use(findArchivePath);
      if (!path) return false;
      // Archiving moves OUT of the inbox; un-archiving moves back IN, so the
      // mailbox we open and the destination swap round.
      const [from, to] = archived ? ['INBOX', path] : [path, 'INBOX'];
      return conn.useMailbox(from, async (client) => {
        try {
          await client.messageMove(uids.join(','), to, { uid: true });
        } catch (err) {
          // Already moved (a repeat sent while the first was in flight): done.
          const left = (await client.search({ uid: uids.join(',') }, { uid: true })) || [];
          if (left.length > 0) throw err;
        }
        return true;
      });
    },

    async moveToFolder(uids, folder, opts) {
      if (uids.length === 0) return true;
      const path = await conn.use((client) => ensureMailboxPath(client, folder, opts?.create !== false));
      if (!path) return false;
      await conn.useMailbox('INBOX', async (client) => {
        try {
          await client.messageMove(uids.join(','), path, { uid: true });
        } catch (err) {
          // Already moved (a second pass while the first was still moving it).
          const left = (await client.search({ uid: uids.join(',') }, { uid: true })) || [];
          if (left.length > 0) throw err;
        }
      });
      return true;
    },

    async moveToTrash(uids) {
      if (uids.length === 0) return true;
      const path = await conn.use(findTrashPath);
      if (!path) return false;
      return conn.useMailbox('INBOX', async (client) => {
        try {
          await client.messageMove(uids.join(','), path, { uid: true });
        } catch (err) {
          // A move of messages that have already left the inbox fails
          // ("Command failed"): a second Trash for the same email, sent while
          // the first was still moving it. Done is done; only a message still
          // in the inbox makes this a real failure.
          const left = (await client.search({ uid: uids.join(',') }, { uid: true })) || [];
          if (left.length > 0) throw err;
        }
        return true;
      });
    },

    async send(input) {
      const transport = nodemailer.createTransport({
        host: auth.smtpHost,
        port: auth.smtpPort,
        secure: auth.smtpPort === 465,
        auth: { user: auth.username, pass: auth.password },
      });
      try {
        const info = await transport.sendMail({
          from: input.from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html ?? undefined,
          inReplyTo: input.inReplyTo ?? undefined,
          references: input.references ?? undefined,
          ...(input.autoSubmitted ? { headers: { 'Auto-Submitted': 'auto-replied' } } : {}),
          attachments: input.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.mimeType,
          })),
        });
        return { messageId: (info as { messageId?: string }).messageId ?? null };
      } catch (err) {
        if (isAuthFailure(err)) {
          throw new AccountAuthError(`smtp login failed for ${auth.username}@${auth.smtpHost}`, {
            needsReconnect: true,
          });
        }
        throw err;
      } finally {
        transport.close();
      }
    },

    async sendRaw(input) {
      const transport = nodemailer.createTransport({
        host: auth.smtpHost,
        port: auth.smtpPort,
        secure: auth.smtpPort === 465,
        auth: { user: auth.username, pass: auth.password },
      });
      try {
        await transport.sendMail({ envelope: { from: input.from, to: input.to }, raw: input.raw });
      } catch (err) {
        if (isAuthFailure(err)) {
          throw new AccountAuthError(`smtp login failed for ${auth.username}@${auth.smtpHost}`, {
            needsReconnect: true,
          });
        }
        throw err;
      } finally {
        transport.close();
      }
    },

    async listJunk(windowDays, limit) {
      const path = await conn.use(findJunkPath);
      if (!path) return [];
      return conn.useMailbox(path, async (client) => {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const uids = (await client.search({ since }, { uid: true })) || [];
        const latest = [...uids].sort((a, b) => a - b).slice(-Math.max(limit, 1));
        if (latest.length === 0) return [];
        const out: ImapFetchedMessage[] = [];
        for await (const msg of client.fetch(
          latest.join(','),
          { uid: true, flags: true, source: true },
          { uid: true },
        )) {
          const parsed = await parseFetchedMessage(msg);
          if (parsed) out.push(parsed);
        }
        return out.sort((a, b) => b.date.localeCompare(a.date));
      });
    },

    async rescueJunk(uid) {
      const path = await conn.use(findJunkPath);
      if (!path) throw new Error('junk folder not found');
      await conn.useMailbox(path, async (client) => {
        await client.messageMove(String(uid), 'INBOX', { uid: true });
      });
    },

    async findInTrash(rfc822MessageIds) {
      const found = new Set<string>();
      if (rfc822MessageIds.length === 0) return found;
      const path = await conn.use(findTrashPath);
      if (!path) return found;
      return conn.useMailbox(path, async (client) => {
        // Repeated searches share the one session — the login is the expensive
        // part, not the SEARCH.
        for (const id of rfc822MessageIds) {
          const hits = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
          if (hits.length > 0) found.add(id);
        }
        return found;
      });
    },

    async fetchAttachment(uid, index, folder = 'inbox') {
      const path = folder === 'sent' ? await conn.use(findSentPath) : 'INBOX';
      if (!path) return null;
      return conn.useMailbox(path, async (client) => {
        for await (const msg of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
          if (!msg.source) return null;
          const parsed = await simpleParser(msg.source);
          const fileParts = (parsed.attachments ?? []).filter((a) => !isCalendarPart(a));
          const part = fileParts[index];
          if (!part) return null;
          return {
            filename: part.filename ?? `attachment-${index + 1}`,
            mimeType: part.contentType ?? 'application/octet-stream',
            content: part.content,
          };
        }
        return null;
      });
    },

    async saveDraft(mime, replaceRef) {
      const path = await conn.use(findDraftsPath);
      if (!path) return null;
      // A server without UIDPLUS does not say where the copy went, so it could
      // never be replaced or removed - better none than one per save. Asked
      // BEFORE appending: checking the answer afterwards left an orphan in
      // Drafts on every retry.
      const uidplus = await conn.use(async (client) => client.capabilities?.has('UIDPLUS') === true);
      if (!uidplus) return null;
      if (replaceRef && (await missingImapDrafts(conn, [replaceRef])).has(replaceRef)) return { gone: true };
      const appended = await conn.use((client) =>
        client.append(path, Buffer.from(mime, 'utf8'), ['\\Draft', '\\Seen']),
      );
      const uid = appended ? appended.uid : undefined;
      const uidValidity = appended ? appended.uidValidity : undefined;
      if (!uid || uidValidity === undefined) {
        throw new Error('imap server did not return the draft uid (no UIDPLUS)');
      }
      const old = replaceRef ? decodeImapDraftRef(replaceRef) : null;
      if (old) await removeImapDraft(conn, old);
      return encodeImapDraftRef({ path, uidValidity: String(uidValidity), uid });
    },

    async deleteDraft(ref) {
      const old = decodeImapDraftRef(ref);
      if (old) await removeImapDraft(conn, old);
    },

    async missingDrafts(refs) {
      return missingImapDrafts(conn, refs);
    },
  };
}

/** One SELECT per folder, one UID SEARCH for every copy in it. */
async function missingImapDrafts(conn: ImapConnection, refs: string[]): Promise<Set<string>> {
  const byFolder = new Map<string, { ref: string; draft: ImapDraftRef }[]>();
  for (const ref of refs) {
    const draft = decodeImapDraftRef(ref);
    if (!draft) continue;
    const key = JSON.stringify([draft.path, draft.uidValidity]);
    byFolder.set(key, [...(byFolder.get(key) ?? []), { ref, draft }]);
  }
  const missing = new Set<string>();
  for (const group of byFolder.values()) {
    const { path, uidValidity } = group[0]!.draft;
    await conn.useMailbox(path, async (client) => {
      if (!client.mailbox || String(client.mailbox.uidValidity) !== uidValidity) return;
      const uids = group.map((g) => g.draft.uid).join(',');
      const left = new Set(((await client.search({ uid: uids }, { uid: true })) || []).map(Number));
      for (const g of group) if (!left.has(g.draft.uid)) missing.add(g.ref);
    });
  }
  return missing;
}

async function removeImapDraft(conn: ImapConnection, ref: ImapDraftRef): Promise<void> {
  await conn.useMailbox(ref.path, async (client) => {
    const mailbox = client.mailbox;
    // A changed UIDVALIDITY means the UID now names some other message.
    if (mailbox && String(mailbox.uidValidity) !== ref.uidValidity) return;
    await client.messageDelete(String(ref.uid), { uid: true });
  });
}

/**
 * One-shot API: each call opens and closes its own connection. Correct for the
 * single-operation route paths (send a reply, peek at junk, download an
 * attachment) where there is nothing to amortise a session over.
 */
export function realImapApi(auth: ImapAuth): ImapApi {
  const oneShot = <K extends keyof ImapApi>(key: K): ImapApi[K] =>
    (async (...args: unknown[]) => {
      const conn = imapConnection(auth);
      try {
        return await (imapApiOn(auth, conn)[key] as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        await conn.close();
      }
    }) as ImapApi[K];

  return {
    verify: oneShot('verify'),
    listWindow: oneShot('listWindow'),
    listSentWindow: oneShot('listSentWindow'),
    fetch: oneShot('fetch'),
    fetchSent: oneShot('fetchSent'),
    fetchFlags: oneShot('fetchFlags'),
    setSeen: oneShot('setSeen'),
    setArchived: oneShot('setArchived'),
    moveToTrash: oneShot('moveToTrash'),
    moveToFolder: oneShot('moveToFolder'),
    send: oneShot('send'),
    sendRaw: oneShot('sendRaw'),
    listJunk: oneShot('listJunk'),
    rescueJunk: oneShot('rescueJunk'),
    findInTrash: oneShot('findInTrash'),
    fetchAttachment: oneShot('fetchAttachment'),
    setKeywords: oneShot('setKeywords'),
    probeKeywordSupport: oneShot('probeKeywordSupport'),
    saveDraft: oneShot('saveDraft'),
    deleteDraft: oneShot('deleteDraft'),
    missingDrafts: oneShot('missingDrafts'),
  };
}

/** ONE login for the whole callback — the sync tick's unit of work. */
export async function withRealImapSession<T>(
  auth: ImapAuth,
  fn: (api: ImapApi) => Promise<T>,
): Promise<T> {
  const conn = imapConnection(auth);
  try {
    return await fn(imapApiOn(auth, conn));
  } finally {
    await conn.close();
  }
}

// ── mock implementation ───────────────────────────────────────────────
interface MockImapMailbox {
  uidValidity: string;
  messages: ImapFetchedMessage[];
  junk: ImapFetchedMessage[];
  /** `${uid}:i${index}` → attachment bytes for fetchAttachment. */
  attachmentBlobs: Map<string, { filename: string; mimeType: string; content: Buffer }>;
  /** Message-IDs sitting in Trash (a delete, not an archive). */
  trashed: Set<string>;
  /** Messages moved out of INBOX by `setArchived`. */
  archived: ImapFetchedMessage[];
  /** The Sent mailbox (ADR 0116). Empty means the account has no Sent folder,
   *  which `listSentWindow` reports as null rather than as "nothing sent". */
  sent: ImapFetchedMessage[];
  sentCount: number;
  /** Message-ID of the last message `send` sent. */
  lastSentMessageId: string | null;
  /** Every `sendRaw` message, oldest first. */
  sentRaw: string[];
  /** When true the mailbox has no archive folder, so `setArchived` reports false. */
  noArchiveFolder: boolean;
  /** When true the mailbox has no Trash folder, so `moveToTrash` reports false. */
  noTrashFolder: boolean;
  /** ADR 0142 — mock PERMANENTFLAGS `\*` support. Default true. */
  keywordSupport: boolean;
  /** ADR 0142 — recorded setKeywords calls (for login/batch tests). */
  keywordOps: { uids: number[]; add: string[]; remove: string[] }[];
  /** ADR 0303 — the Drafts folder: uid → RFC 822 text. */
  drafts: Map<number, string>;
  nextDraftUid: number;
  noDraftsFolder: boolean;
  /** ADR 0309 — mailbox name → subjects filed there by `moveToFolder`. */
  filed: Map<string, string[]>;
}

/** Test helper — what was filed where in this mock IMAP mailbox. */
export function __imapMockFiled(accountKey: string): Map<string, string[]> {
  return mockImapBox(accountKey).filed;
}

const mockImapBoxes = new Map<string, MockImapMailbox>();

function mockBlobKey(folder: ImapFolder, uid: number, index: number): string {
  return `${folder === 'sent' ? 'sent:' : ''}${uid}:i${index}`;
}

function seedImapMailbox(): MockImapMailbox {
  const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  return {
    uidValidity: '1',
    sentCount: 0,
    lastSentMessageId: null,
    sentRaw: [],
    attachmentBlobs: new Map(),
    trashed: new Set(),
    archived: [],
    sent: [],
    noArchiveFolder: false,
    noTrashFolder: false,
    keywordSupport: true,
    keywordOps: [],
    drafts: new Map(),
    nextDraftUid: 1,
    noDraftsFolder: false,
    filed: new Map(),
    junk: [
      {
        uid: 901,
        flags: [],
        messageId: '<yh-901@service.example>',
        inReplyTo: null,
        references: null,
        subject: 'Your verification code is 481902',
        fromName: 'Acme Accounts',
        fromEmail: 'no-reply@service.example',
        toEmails: ['family@yahoo.example'],
        ccEmails: [],
        date: hourAgo(2),
        snippet: 'Your verification code is 481902. It expires in 10 minutes.',
        bodyText: 'Your verification code is 481902. It expires in 10 minutes.',
        bodyHtml: null,
        icsText: null,
      },
    ],
    messages: [
      {
        uid: 101,
        flags: [],
        messageId: '<yh-101@school.example>',
        inReplyTo: null,
        references: null,
        subject: 'Picture day is next Friday',
        fromName: 'Lincoln Elementary',
        fromEmail: 'office@school.example',
        toEmails: ['family@yahoo.example'],
        ccEmails: [],
        date: hourAgo(30),
        snippet: 'Picture day is next Friday — order forms attached to the newsletter.',
        bodyText: 'Picture day is next Friday — order forms attached to the newsletter.',
        bodyHtml: null,
      },
      {
        uid: 102,
        flags: ['\\Seen'],
        messageId: '<yh-102@pharmacy.example>',
        inReplyTo: null,
        references: null,
        subject: 'Your prescription is ready',
        fromName: 'Bay Pharmacy',
        fromEmail: 'noreply@pharmacy.example',
        toEmails: ['family@yahoo.example'],
        ccEmails: [],
        date: hourAgo(8),
        snippet: 'Your prescription is ready for pickup until 8pm.',
        bodyText: 'Your prescription is ready for pickup until 8pm.',
        bodyHtml: null,
      },
    ],
  };
}

function mockImapBox(accountKey: string): MockImapMailbox {
  let box = mockImapBoxes.get(accountKey);
  if (!box) {
    box = seedImapMailbox();
    mockImapBoxes.set(accountKey, box);
  }
  return box;
}

export function mockImapApi(accountKey: string, auth?: Pick<ImapAuth, 'password'>): ImapApi {
  return {
    async verify() {
      if (auth?.password === 'bad-password') {
        throw new AccountAuthError('imap login failed (mock)', { needsReconnect: true });
      }
    },
    async listWindow() {
      const box = mockImapBox(accountKey);
      return {
        uidValidity: box.uidValidity,
        uids: box.messages.map((m) => m.uid).sort((a, b) => a - b),
      };
    },
    async fetch(uids) {
      const box = mockImapBox(accountKey);
      const want = new Set(uids);
      return box.messages.filter((m) => want.has(m.uid));
    },
    async listSentWindow() {
      const box = mockImapBox(accountKey);
      if (!box.sent.length) return null;
      return {
        uidValidity: box.uidValidity,
        uids: box.sent.map((m) => m.uid).sort((a, b) => a - b),
      };
    },
    async fetchSent(uids) {
      const box = mockImapBox(accountKey);
      const want = new Set(uids);
      return box.sent.filter((m) => want.has(m.uid));
    },
    async fetchFlags(uids) {
      const box = mockImapBox(accountKey);
      const want = new Set(uids);
      return new Map(box.messages.filter((m) => want.has(m.uid)).map((m) => [m.uid, m.flags]));
    },
    async setSeen(uids, seen) {
      const box = mockImapBox(accountKey);
      const want = new Set(uids);
      for (const m of box.messages) {
        if (!want.has(m.uid)) continue;
        m.flags = seen
          ? Array.from(new Set([...m.flags, '\\Seen']))
          : m.flags.filter((f) => f !== '\\Seen');
      }
    },
    async setKeywords(uids, add, remove) {
      const box = mockImapBox(accountKey);
      box.keywordOps.push({ uids: [...uids], add: [...add], remove: [...remove] });
      if (!box.keywordSupport) return;
      const want = new Set(uids);
      const drop = new Set(remove);
      for (const m of box.messages) {
        if (!want.has(m.uid)) continue;
        m.flags = Array.from(
          new Set([...m.flags.filter((f) => !drop.has(f)), ...add]),
        );
      }
    },
    async probeKeywordSupport() {
      return mockImapBox(accountKey).keywordSupport;
    },
    async setArchived(uids, archived) {
      const box = mockImapBox(accountKey);
      if (box.noArchiveFolder) return false;
      const want = new Set(uids);
      const [from, to] = archived
        ? ([box.messages, box.archived] as const)
        : ([box.archived, box.messages] as const);
      for (let i = from.length - 1; i >= 0; i--) {
        if (!want.has(from[i].uid)) continue;
        const [m] = from.splice(i, 1);
        // A move assigns the next UID of the destination mailbox, as a real
        // server does: the message comes back to INBOX under a new UID.
        if (!archived) m.uid = Math.max(0, ...box.messages.map((x) => x.uid)) + 1;
        to.push(m);
      }
      return true;
    },
    async moveToFolder(uids, folder, opts) {
      const box = mockImapBox(accountKey);
      const existing = [...box.filed.keys()].find((k) => k.toLowerCase() === folder.trim().toLowerCase());
      if (!existing && opts?.create === false) return false;
      const key = existing ?? folder.trim();
      if (!box.filed.has(key)) box.filed.set(key, []);
      const want = new Set(uids);
      for (let i = box.messages.length - 1; i >= 0; i--) {
        if (!want.has(box.messages[i].uid)) continue;
        const [m] = box.messages.splice(i, 1);
        box.filed.set(key, [...(box.filed.get(key) ?? []), m.subject]);
      }
      return true;
    },
    async moveToTrash(uids) {
      const box = mockImapBox(accountKey);
      if (box.noTrashFolder) return false;
      const want = new Set(uids);
      for (let i = box.messages.length - 1; i >= 0; i--) {
        if (!want.has(box.messages[i].uid)) continue;
        const [m] = box.messages.splice(i, 1);
        if (m.messageId) box.trashed.add(m.messageId);
      }
      return true;
    },
    async send() {
      const box = mockImapBox(accountKey);
      box.sentCount += 1;
      box.lastSentMessageId = `<mock-sent-${box.sentCount}@${accountKey}>`;
      return { messageId: box.lastSentMessageId };
    },
    async sendRaw(input) {
      const box = mockImapBox(accountKey);
      box.sentCount += 1;
      box.sentRaw.push(input.raw);
    },
    async listJunk(_windowDays, limit) {
      const box = mockImapBox(accountKey);
      return [...box.junk].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    },
    async rescueJunk(uid) {
      const box = mockImapBox(accountKey);
      const idx = box.junk.findIndex((m) => m.uid === uid);
      if (idx === -1) throw new Error(`mock imap: junk uid ${uid} not found`);
      const [msg] = box.junk.splice(idx, 1);
      box.messages.push(msg);
    },
    async fetchAttachment(uid, index, folder = 'inbox') {
      return mockImapBox(accountKey).attachmentBlobs.get(mockBlobKey(folder, uid, index)) ?? null;
    },
    async findInTrash(rfc822MessageIds) {
      const { trashed } = mockImapBox(accountKey);
      return new Set(rfc822MessageIds.filter((id) => trashed.has(id)));
    },
    async saveDraft(mime, replaceRef) {
      const box = mockImapBox(accountKey);
      if (box.noDraftsFolder) return null;
      const replaced = replaceRef ? decodeImapDraftRef(replaceRef) : null;
      if (replaced && !box.drafts.has(replaced.uid)) return { gone: true };
      const uid = box.nextDraftUid++;
      box.drafts.set(uid, mime);
      const old = replaceRef ? decodeImapDraftRef(replaceRef) : null;
      if (old) box.drafts.delete(old.uid);
      return encodeImapDraftRef({ path: 'Drafts', uidValidity: box.uidValidity, uid });
    },
    async deleteDraft(ref) {
      const old = decodeImapDraftRef(ref);
      if (old) mockImapBox(accountKey).drafts.delete(old.uid);
    },
    async missingDrafts(refs) {
      const box = mockImapBox(accountKey);
      return new Set(
        refs.filter((ref) => {
          const d = decodeImapDraftRef(ref);
          return d !== null && d.uidValidity === String(box.uidValidity) && !box.drafts.has(d.uid);
        }),
      );
    },
  };
}

/** Test helper — the mock Drafts folder (uid → RFC 822 text). */
export function __imapMockDrafts(accountKey: string): Map<number, string> {
  return mockImapBox(accountKey).drafts;
}

export function __setImapMockNoDraftsFolder(accountKey: string, none: boolean): void {
  mockImapBox(accountKey).noDraftsFolder = none;
}

// ── test helpers ──────────────────────────────────────────────────────
export function __resetImapMock(accountKey?: string): void {
  if (accountKey) mockImapBoxes.delete(accountKey);
  else mockImapBoxes.clear();
}

/** ADR 0142 — force the mock's PERMANENTFLAGS `\*` answer. */
export function __setImapMockKeywordSupport(accountKey: string, supported: boolean): void {
  mockImapBox(accountKey).keywordSupport = supported;
}

export function __setImapMockNoTrashFolder(accountKey: string, none: boolean): void {
  mockImapBox(accountKey).noTrashFolder = none;
}

/** Message-IDs the mock holds in Trash. */
export function __imapMockTrashed(accountKey: string): string[] {
  return [...mockImapBox(accountKey).trashed];
}

/** ADR 0142 — setKeywords calls recorded by the mock (batch + count pin). */
export function __imapMockKeywordOps(
  accountKey: string,
): { uids: number[]; add: string[]; remove: string[] }[] {
  return [...mockImapBox(accountKey).keywordOps];
}

/** Put a message in the mock Sent mailbox (ADR 0116 parity tests). */
export function __addImapMockSent(accountKey: string, message: ImapFetchedMessage): void {
  mockImapBox(accountKey).sent.push(message);
}

export function __addImapMockMessage(accountKey: string, message: ImapFetchedMessage): void {
  mockImapBox(accountKey).messages.push(message);
}

export function __addImapMockJunk(accountKey: string, message: ImapFetchedMessage): void {
  mockImapBox(accountKey).junk.push(message);
}

/** Attach a file to a mock message: meta rides the message, bytes the blob map.
 *  UIDs are per mailbox, so a Sent message's file is held apart from INBOX's. */
export function __setImapMockAttachment(
  accountKey: string,
  uid: number,
  index: number,
  blob: { filename: string; mimeType: string; content: Buffer; contentId?: string },
  folder: ImapFolder = 'inbox',
): void {
  const box = mockImapBox(accountKey);
  box.attachmentBlobs.set(mockBlobKey(folder, uid, index), blob);
  const msg = (folder === 'sent' ? box.sent : box.messages).find((m) => m.uid === uid);
  if (msg) {
    msg.attachments = msg.attachments ?? [];
    msg.attachments[index] = {
      id: `i${index}`,
      filename: blob.filename,
      mimeType: blob.mimeType,
      size: blob.content.byteLength,
      ...(blob.contentId ? { contentId: normalizeContentId(blob.contentId) } : {}),
    };
  }
}

/** `toTrash` mirrors a delete (message lands in Trash); default is an archive
 *  — the UID simply leaves INBOX. */
export function __removeImapMockMessage(
  accountKey: string,
  uid: number,
  opts: { toTrash?: boolean } = {},
): void {
  const box = mockImapBox(accountKey);
  const msg = box.messages.find((m) => m.uid === uid);
  if (opts.toTrash && msg?.messageId) box.trashed.add(msg.messageId);
  box.messages = box.messages.filter((m) => m.uid !== uid);
}

export function __imapMockLastSentMessageId(accountKey: string): string | null {
  return mockImapBox(accountKey).lastSentMessageId;
}

export function __imapMockSentRaw(accountKey: string): string[] {
  return mockImapBox(accountKey).sentRaw;
}

export function __imapMockSentCount(accountKey: string): number {
  return mockImapBox(accountKey).sentCount;
}

// ── seam ──────────────────────────────────────────────────────────────
export function getImapApi(accountKey: string, auth: ImapAuth): ImapApi {
  if (env.IMAP_PROVIDER === 'mock') return mockImapApi(accountKey, auth);
  return realImapApi(auth);
}

/**
 * Run a multi-operation batch over ONE login. The mock has no connection to
 * amortise, so it just hands over its API — the seam exists for the real
 * provider, where a sync tick would otherwise pay a TLS handshake + LOGIN per
 * call into exactly the metric Yahoo throttles.
 */
export async function withImapSession<T>(
  accountKey: string,
  auth: ImapAuth,
  fn: (api: ImapApi) => Promise<T>,
): Promise<T> {
  if (env.IMAP_PROVIDER === 'mock') return fn(mockImapApi(accountKey, auth));
  return withRealImapSession(auth, fn);
}
