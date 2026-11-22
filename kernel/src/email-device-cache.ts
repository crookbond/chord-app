/**
 * The rules of the device's copy of mail (ADR 0302, ADR 0304): what is kept, what
 * a background pass fetches, what leaves. Pure, so it is tested here; the
 * file reads and writes live in mobile/src/email-device-store.ts.
 */
import { gcm } from '@noble/ciphers/aes.js';

import type { EmailThreadDetail, EmailThreadSummary } from './types/email';

export const DEVICE_MAIL_KEEP_DAYS = 30;
/** A stored thread larger than this is not kept; it opens online as before. */
export const DEVICE_MAIL_MAX_ENTRY_BYTES = 1024 * 1024;
export const DEVICE_MAIL_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DEVICE_MAIL_MAX_THREADS = 1000;
export const DEVICE_MAIL_FETCH_PER_PASS = 40;
export const DEVICE_MAIL_FETCH_CONCURRENCY = 3;
/** Pages of the inbox list one pass reads looking for the 30-day line. */
export const DEVICE_MAIL_MAX_LIST_PAGES = 12;
/**
 * Unread inbox mail is kept whatever its age, newest first, up to this many
 * threads (ADR 0304). Read from the unread-only list, so 6 pages of 50.
 */
export const DEVICE_MAIL_UNREAD_MAX_THREADS = 300;
export const DEVICE_MAIL_UNREAD_MAX_LIST_PAGES = 6;
/** The browser keeps its copy in memory only, so it holds less (ADR 0304). */
export const WEB_MAIL_LIMITS = { maxBytes: 40 * 1024 * 1024, maxThreads: 400 } as const;
/**
 * Where the Email tab keeps the inbox list it last showed, for painting the
 * next cold start (ADR 0302/0304):
 * - `sealed`: a phone with the key store, in its sealed folder;
 * - `plain`: a phone build without the key store, the short AsyncStorage
 *   list it always had;
 * - `none`: a browser. Mail in a browser stays in this page's memory only;
 *   AsyncStorage there is localStorage, readable by anyone at the computer.
 */
export function inboxListStorage(opts: { web: boolean; sealedReady: boolean }): 'sealed' | 'plain' | 'none' {
  if (opts.web) return 'none';
  return opts.sealedReady ? 'sealed' : 'plain';
}

/** Fetch failures in a row after which a pass stops (offline, or the server is struggling). */
export const DEVICE_MAIL_MAX_FAILURES_IN_A_ROW = 3;

const DAY_MS = 86_400_000;

export interface DeviceMailEntry {
  /** The thread's newest message when it was stored; a newer one means refetch. */
  lastMessageAt: string;
  bytes: number;
  storedAt: number;
  summary: EmailThreadSummary;
}

export interface DeviceMailIndex {
  version: 1;
  entries: Record<string, DeviceMailEntry>;
}

export const emptyDeviceMailIndex = (): DeviceMailIndex => ({ version: 1, entries: {} });

export function parseDeviceMailIndex(raw: string | null): DeviceMailIndex {
  if (!raw) return emptyDeviceMailIndex();
  try {
    const v = JSON.parse(raw) as Partial<DeviceMailIndex>;
    if (v?.version === 1 && v.entries && typeof v.entries === 'object') {
      return { version: 1, entries: v.entries as Record<string, DeviceMailEntry> };
    }
  } catch {
    /* fall through to empty: a damaged index costs a re-download, nothing more */
  }
  return emptyDeviceMailIndex();
}

/** Within the window, judged by the thread's newest message. */
export function withinDeviceKeep(lastMessageAt: string, nowMs: number): boolean {
  const at = Date.parse(lastMessageAt);
  return Number.isFinite(at) && nowMs - at <= DEVICE_MAIL_KEEP_DAYS * DAY_MS;
}

const isGone = (t: Pick<EmailThreadSummary, 'isArchived' | 'labelIds'>): boolean =>
  t.isArchived || t.labelIds.includes('TRASH') || t.labelIds.includes('SPAM');

/**
 * Suspected spam or phishing is never kept on the device (owner, ADR 0304):
 * the provider filed it as spam, the sender check says danger (ADR 0294), or
 * the read-time pass left a caution (ADR 0180). Judged on the fetched thread,
 * since a list row carries none of these; such a thread opens online only.
 */
export function suspectedForDevice(detail: EmailThreadDetail): boolean {
  if (detail.thread.labelIds.includes('SPAM')) return true;
  if (detail.readAdvisory) return true;
  return detail.messages.some((m) => m.senderCheck?.level === 'danger');
}

/** Kept on the device: unread at any age, read only within the window (ADR 0304). */
export function keptOnDevice(
  t: Pick<EmailThreadSummary, 'lastMessageAt' | 'isUnread'>,
  nowMs: number,
): boolean {
  return !!t.isUnread || withinDeviceKeep(t.lastMessageAt, nowMs);
}

const newestFirst = (a: { lastMessageAt: string }, b: { lastMessageAt: string }) =>
  Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt);

/**
 * The threads a pass should download: kept on the device, not removed, and
 * either not stored or stored before their newest message arrived. Unread
 * first (newest first), then read mail newest first, since an unread email is
 * the one about to be opened. `list` may hold the same thread twice (the
 * inbox list and the unread list); it is asked for once.
 */
export function threadsToPrefetch(
  list: readonly EmailThreadSummary[],
  index: DeviceMailIndex,
  nowMs: number,
  limit = DEVICE_MAIL_FETCH_PER_PASS,
): string[] {
  const seen = new Set<string>();
  return list
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .filter((t) => keptOnDevice(t, nowMs) && !isGone(t))
    .filter((t) => {
      const e = index.entries[t.id];
      return !e || Date.parse(e.lastMessageAt) < Date.parse(t.lastMessageAt);
    })
    .sort((a, b) => Number(!!b.isUnread) - Number(!!a.isUnread) || newestFirst(a, b))
    .slice(0, Math.max(0, limit))
    .map((t) => t.id);
}

/**
 * A pass's reading of the unread-only inbox list against the store: which
 * stored threads it shows are no longer unread, and the read state of every
 * stored thread either list shows. Only matters for threads past the window,
 * which are kept for being unread; a stored thread older than the last
 * unread row is judged only when the unread list ended.
 */
export function unreadReconcile(
  index: DeviceMailIndex,
  rows: { inbox: readonly EmailThreadSummary[]; unread: readonly EmailThreadSummary[]; unreadComplete: boolean },
  nowMs: number,
): { noLongerUnread: string[]; states: Record<string, Pick<EmailThreadSummary, 'isUnread' | 'labelIds'>> } {
  const states: Record<string, Pick<EmailThreadSummary, 'isUnread' | 'labelIds'>> = {};
  for (const t of [...rows.inbox, ...rows.unread]) {
    if (index.entries[t.id]) states[t.id] = { isUnread: t.isUnread, labelIds: t.labelIds };
  }
  const onUnread = new Set(rows.unread.map((t) => t.id));
  const oldest = rows.unread.length > 0 ? Math.min(...rows.unread.map((t) => Date.parse(t.lastMessageAt))) : Infinity;
  const noLongerUnread = Object.entries(index.entries)
    .filter(([id, e]) => !withinDeviceKeep(e.lastMessageAt, nowMs) && !onUnread.has(id))
    .filter(([, e]) => rows.unreadComplete || Date.parse(e.lastMessageAt) > oldest)
    .map(([id]) => id);
  for (const id of noLongerUnread) {
    const s = states[id];
    states[id] = { isUnread: false, labelIds: s?.labelIds ?? index.entries[id].summary.labelIds };
  }
  return { noLongerUnread, states };
}

/**
 * Stored threads that a fresh read of the inbox list shows were removed
 * elsewhere (archived, trashed, snoozed, deleted). The list is newest first,
 * so a stored thread newer than its last row - or any stored thread when the
 * list ended - must be on it if it were still in the inbox. A thread's newest
 * message only moves later, so the stored time can only understate it.
 */
export function goneFromInbox(
  index: DeviceMailIndex,
  list: readonly Pick<EmailThreadSummary, 'id' | 'lastMessageAt'>[],
  listComplete: boolean,
): string[] {
  const onList = new Set(list.map((t) => t.id));
  const oldest = list.length > 0 ? Math.min(...list.map((t) => Date.parse(t.lastMessageAt))) : Infinity;
  return Object.entries(index.entries)
    .filter(([id, e]) => !onList.has(id) && (listComplete || Date.parse(e.lastMessageAt) > oldest))
    .map(([id]) => id);
}

export interface DeviceMailLimits {
  maxBytes?: number;
  maxThreads?: number;
  maxUnread?: number;
}

/**
 * Which entries to drop: read mail past the window, unread mail past the
 * window beyond the newest `maxUnread`, then - unread first, each newest
 * first - whatever no longer fits the size and count limits. So under
 * pressure old read mail goes before any unread email.
 */
export function deviceMailToPrune(index: DeviceMailIndex, nowMs: number, limits: DeviceMailLimits = {}): string[] {
  const maxBytes = limits.maxBytes ?? DEVICE_MAIL_MAX_TOTAL_BYTES;
  const maxThreads = limits.maxThreads ?? DEVICE_MAIL_MAX_THREADS;
  const maxUnread = limits.maxUnread ?? DEVICE_MAIL_UNREAD_MAX_THREADS;
  const drop: string[] = [];
  const unread: [string, DeviceMailEntry][] = [];
  const read: [string, DeviceMailEntry][] = [];
  for (const [id, e] of Object.entries(index.entries)) {
    if (e.summary?.isUnread) unread.push([id, e]);
    else if (withinDeviceKeep(e.lastMessageAt, nowMs)) read.push([id, e]);
    else drop.push(id);
  }
  const byNewest = (a: [string, DeviceMailEntry], b: [string, DeviceMailEntry]) => newestFirst(a[1], b[1]);
  unread.sort(byNewest);
  read.sort(byNewest);
  const kept: [string, DeviceMailEntry][] = [];
  unread.forEach((pair, i) => {
    if (i >= maxUnread && !withinDeviceKeep(pair[1].lastMessageAt, nowMs)) drop.push(pair[0]);
    else kept.push(pair);
  });
  kept.push(...read);
  let bytes = 0;
  kept.forEach(([id, e], i) => {
    bytes += e.bytes;
    if (i >= maxThreads || bytes > maxBytes) drop.push(id);
  });
  return drop;
}

/** The copy that is written: the image token is a short-lived capability (ADR 0136). */
export function detailForDevice(detail: EmailThreadDetail): EmailThreadDetail {
  const { imageToken: _token, ...rest } = detail;
  return rest;
}

/** UTF-8 length without TextEncoder, which older Hermes builds lack. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ── Sealing (the user's optional encryption) ──────────────────────────────

/** A sealed file starts with this, so plain and sealed files can sit side by side. */
export const DEVICE_SEAL_PREFIX = 'chordenc1:';
const NONCE_BYTES = 12;

export const isDeviceSealed = (text: string): boolean => text.startsWith(DEVICE_SEAL_PREFIX);

function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(utf8Length(s));
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    } else {
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 63);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    }
  }
  return out;
}

function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else s += String.fromCharCode(cp);
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < b.length ? B64[n & 63] : '=';
  }
  return s;
}

/** Character code -> 6-bit value, so decoding a sealed file is one table
 *  read per character rather than a scan of the alphabet (a file is up to
 *  a megabyte, decoded in plain JS on the phone). */
const B64_VALUE = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  const v = (i: number) => B64_VALUE[clean.charCodeAt(i) & 127];
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (v(i) << 18) |
      (v(i + 1) << 12) |
      ((i + 2 < clean.length ? v(i + 2) : 0) << 6) |
      (i + 3 < clean.length ? v(i + 3) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}

/** AES-256-GCM; `nonce` must be 12 fresh random bytes per call. */
export function sealDeviceText(key: Uint8Array, nonce: Uint8Array, text: string): string {
  if (key.length !== 32) throw new Error('device key must be 32 bytes');
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce must be 12 bytes');
  const ct = gcm(key, nonce).encrypt(utf8Encode(text));
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return DEVICE_SEAL_PREFIX + bytesToBase64(out);
}

/** The text, or null when it is not sealed under this key (wrong key, altered). */
export function openDeviceText(key: Uint8Array, sealed: string): string | null {
  if (!isDeviceSealed(sealed)) return null;
  try {
    const raw = base64ToBytes(sealed.slice(DEVICE_SEAL_PREFIX.length));
    if (raw.length <= NONCE_BYTES) return null;
    return utf8Decode(gcm(key, raw.subarray(0, NONCE_BYTES)).decrypt(raw.subarray(NONCE_BYTES)));
  } catch {
    return null;
  }
}
