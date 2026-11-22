/**
 * The device's copy of mail (ADR 0302, ADR 0304): every unread inbox thread
 * and the last 30 days of the rest. On a phone, one sealed file per thread
 * under the cache directory, in a folder per signed-in user, plus an index
 * and the last inbox list. In a browser, the same entries in memory for this
 * page only - nothing is written to browser storage. The rules (what to
 * fetch, what leaves, sealing) are in kernel/src/email-device-cache.ts; this
 * file only moves bytes.
 */
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState, Platform } from 'react-native';
import {
  DEVICE_MAIL_FETCH_CONCURRENCY,
  DEVICE_MAIL_MAX_ENTRY_BYTES,
  DEVICE_MAIL_FETCH_PER_PASS,
  DEVICE_MAIL_MAX_FAILURES_IN_A_ROW,
  DEVICE_MAIL_MAX_LIST_PAGES,
  DEVICE_MAIL_UNREAD_MAX_LIST_PAGES,
  WEB_MAIL_LIMITS,
  createBatchedWrite,
  detailForDevice,
  deviceMailToPrune,
  emptyDeviceMailIndex,
  goneFromInbox,
  isDeviceSealed,
  keptOnDevice,
  openDeviceText,
  parseDeviceMailIndex,
  sealDeviceText,
  singleFlight,
  suspectedForDevice,
  threadsToPrefetch,
  unreadReconcile,
  utf8Length,
  withinDeviceKeep,
  type DeviceMailIndex,
  type DeviceMailLimits,
  type EmailThreadDetail,
  type EmailThreadSummary,
  type EmailThreadUpdatedEvent,
} from '@chord/kernel';

import { getEmailThread, listEmailThreads, setSavedCopyStore, threadPageCursor } from './api';
import { isOnline, onNetworkChange } from './network';
import { importIfNative, nativeModuleInBuild } from './optional-native';
import { onSignOut } from './sign-out';
import { useApp } from './store';

const isWeb = Platform.OS === 'web';

/** The phone's sealed files need the key store; a build without it keeps nothing on disk. */
export const deviceMailSupported =
  !isWeb && !!FileSystem.cacheDirectory && nativeModuleInBuild('ExpoSecureStore');

/** Whether this device keeps any copy: the phone's files, or the browser's memory. */
const storeSupported = deviceMailSupported || isWeb;

const limits: DeviceMailLimits = isWeb ? WEB_MAIL_LIMITS : {};

const SECURE_KEY_NAME = 'chord.emailStoreKey';
const LIST_PAGE_SIZE = 50;
const PASS_MIN_GAP_MS = 60_000;
/** A pass that ran out of budget with mail still to fetch goes on after this. */
const PASS_CONTINUE_MS = 5_000;
/** A continuing pass reuses the lists the pass before it read, this long. */
const CARRIED_LISTS_MS = 2 * 60_000;
/** The index is written at most this often while a pass stores threads. */
const INDEX_WRITE_EVERY_MS = 2_000;

const ROOT = isWeb ? 'mem:email-store/' : `${FileSystem.cacheDirectory ?? ''}email-store/`;
/** The browser's copy: path -> text, gone with the page. */
const memory = new Map<string, string>();
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const userDir = (u: string) => `${ROOT}${safe(u)}/`;
const threadPath = (u: string, id: string) => `${userDir(u)}t/${safe(id)}.json`;

// ── The key: every file is sealed, there is no plain mode ────────────────

type SecureStoreModule = typeof import('expo-secure-store');
let secureMod: SecureStoreModule | null | undefined;

/** Only once the native module is known to be in this build: loading it otherwise is fatal. */
async function secureStore(): Promise<SecureStoreModule | null> {
  if (!deviceMailSupported) return null;
  if (secureMod !== undefined) return secureMod;
  const m = await importIfNative('ExpoSecureStore', () => import('expo-secure-store'));
  secureMod = m && (await m.isAvailableAsync().catch(() => false)) ? m : null;
  return secureMod;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

let keyCache: Uint8Array | null = null;
async function loadKey(create: boolean): Promise<Uint8Array | null> {
  const at = epoch;
  const ss = await secureStore();
  if (!ss) return null;
  const opts = { keychainAccessible: ss.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  try {
    const hex = await ss.getItemAsync(SECURE_KEY_NAME, opts);
    if (hex && hex.length === 64) {
      const key = fromHex(hex);
      if (at === epoch) keyCache = key;
      return key;
    }
    if (!create) return null;
    const key = Crypto.getRandomBytes(32);
    await ss.setItemAsync(SECURE_KEY_NAME, toHex(key), opts);
    if (at === epoch) keyCache = key;
    return key;
  } catch {
    return null;
  }
}

/** Callers racing the first use share one load: two creations would each
 *  seal files under a key the other then overwrites in the key store. */
const loadOrCreateKey = singleFlight(() => loadKey(true));
let creatingKey: Promise<Uint8Array | null> | null = null;

async function deviceKey(create: boolean): Promise<Uint8Array | null> {
  if (keyCache) return keyCache;
  if (create) {
    const run = loadOrCreateKey();
    creatingKey = run;
    void run.finally(() => {
      if (creatingKey === run) creatingKey = null;
    });
    return run;
  }
  return creatingKey ?? loadKey(false);
}

/**
 * Whether this phone keeps mail at all: only with a key in the Keychain /
 * Keystore. A build without expo-secure-store keeps nothing (and the list
 * falls back to the short AsyncStorage cache it always had).
 */
export async function deviceMailReady(): Promise<boolean> {
  return deviceMailSupported && !!(await deviceKey(true));
}

/** Sealed text for disk, or null when there is no key (then nothing is written). */
async function encode(text: string): Promise<string | null> {
  const key = await deviceKey(true);
  return key ? sealDeviceText(key, Crypto.getRandomBytes(12), text) : null;
}

/** Only sealed files are read; anything else is treated as missing. */
async function decode(raw: string): Promise<string | null> {
  if (!isDeviceSealed(raw)) return null;
  const key = await deviceKey(false);
  return key ? openDeviceText(key, raw) : null;
}

// ── Files ─────────────────────────────────────────────────────────────────

async function readText(path: string): Promise<string | null> {
  if (isWeb) return memory.get(path) ?? null;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    return await decode(await FileSystem.readAsStringAsync(path));
  } catch {
    return null;
  }
}

async function writeText(path: string, text: string): Promise<boolean> {
  if (isWeb) {
    memory.set(path, text);
    return true;
  }
  const out = await encode(text);
  if (out === null) return false;
  await FileSystem.writeAsStringAsync(path, out);
  return true;
}

/** A file, or (path ending in /) a folder and everything in it. */
const removeFile = async (path: string): Promise<void> => {
  if (isWeb) {
    for (const k of [...memory.keys()]) if (k === path || (path.endsWith('/') && k.startsWith(path))) memory.delete(k);
    return;
  }
  await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
};

// ── State: one user's index, mutations one at a time ──────────────────────

let activeUser: string | null = null;
let index: DeviceMailIndex | null = null;
/** Bumped by sign-out, so a fetch that was in flight writes nothing after it. */
let epoch = 0;

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Opens (or switches to) the signed-in user's folder; another user's goes. */
async function ensureUser(): Promise<string | null> {
  const u = useApp.getState().user?.id ?? null;
  if (!u || !storeSupported) return null;
  if (activeUser !== u) {
    activeUser = u;
    index = null;
    if (isWeb) {
      for (const k of [...memory.keys()]) if (!k.startsWith(userDir(u))) memory.delete(k);
    } else {
      try {
        const root = await FileSystem.getInfoAsync(ROOT);
        if (root.exists) {
          for (const name of await FileSystem.readDirectoryAsync(ROOT)) {
            if (name !== safe(u)) await removeFile(`${ROOT}${name}`);
          }
        }
        await FileSystem.makeDirectoryAsync(`${userDir(u)}t/`, { intermediates: true });
      } catch {
        /* the next write reports it */
      }
    }
  }
  if (!index) {
    const path = `${userDir(u)}index.json`;
    const raw = await readText(path);
    index = raw ? parseDeviceMailIndex(raw) : emptyDeviceMailIndex();
    // An index that exists but will not open (its key is gone) leaves files
    // nothing can name: start the folder again.
    if (!raw && !isWeb && (await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }))).exists) {
      await removeFile(userDir(u));
      await FileSystem.makeDirectoryAsync(`${userDir(u)}t/`, { intermediates: true }).catch(() => {});
    } else {
      await removeOrphans(u);
    }
  }
  return u;
}

/**
 * The index changes with every stored thread; sealing and writing it each
 * time (up to 1,000 summaries, in plain JS) was most of a pass's work. So a
 * change marks it, and it is written once per batch: at most every
 * `INDEX_WRITE_EVERY_MS`, at the end of a pass, and when the app leaves the
 * foreground. A file written but not yet named by the index is an orphan
 * the next load removes; an entry whose file went is forgotten on read.
 */
const indexWrite = createBatchedWrite(
  () =>
    serial(async () => {
      const u = activeUser;
      if (u && index) await writeText(`${userDir(u)}index.json`, JSON.stringify(index)).catch(() => {});
    }),
  INDEX_WRITE_EVERY_MS,
);

function saveIndex(): void {
  indexWrite.mark();
}

if (!isWeb) {
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') void indexWrite.flush().catch(() => {});
  });
}

/** Thread files the index does not name (a write the index never caught up with). */
async function removeOrphans(u: string): Promise<void> {
  if (isWeb || !index) return;
  try {
    const named = new Set(Object.keys(index.entries).map((e) => `${safe(e)}.json`));
    for (const name of await FileSystem.readDirectoryAsync(`${userDir(u)}t/`)) {
      if (!named.has(name)) await removeFile(`${userDir(u)}t/${name}`);
    }
  } catch {
    /* nothing to tidy */
  }
}

async function dropEntries(u: string, ids: readonly string[]): Promise<void> {
  if (!index || ids.length === 0) return;
  for (const id of ids) {
    delete index.entries[id];
    await removeFile(threadPath(u, id));
  }
}

// ── Small sealed files for other modules ─────────────────────────────────

const RESERVED_NAMES = new Set(['index', 'list']);
const namedPath = (u: string, name: string) => `${userDir(u)}${safe(name)}.json`;

/**
 * ADR 0311 addendum - a small JSON file in the signed-in user's sealed folder,
 * for things that must not sit in plain storage (the send queue). Same key,
 * same folder, gone with sign-out; null when nothing is stored, or when this
 * build cannot keep sealed files (nothing is ever written in plain).
 */
export function readDeviceJson<T>(name: string): Promise<T | null> {
  if (!storeSupported || RESERVED_NAMES.has(name)) return Promise.resolve(null);
  return serial(async () => {
    const u = await ensureUser();
    if (!u) return null;
    const raw = await readText(namedPath(u, name));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  });
}

/** Write (or with null, remove) that file. False when it could not be kept sealed. */
export function writeDeviceJson(name: string, value: unknown): Promise<boolean> {
  if (!storeSupported || RESERVED_NAMES.has(name)) return Promise.resolve(false);
  return serial(async () => {
    const u = await ensureUser();
    if (!u) return false;
    if (value === null) {
      await removeFile(namedPath(u, name));
      return true;
    }
    return writeText(namedPath(u, name), JSON.stringify(value)).catch(() => false);
  });
}

// Saved copies of the reads screens show offline live here too, sealed
// (ADR 0311 addendum).
setSavedCopyStore({
  read: <T,>(name: string) => readDeviceJson<{ value: T }>(`read-${name}`),
  write: (name, value) => writeDeviceJson(`read-${name}`, value),
});

// ── Reading ───────────────────────────────────────────────────────────────

/** The stored copy of a thread, or null. A file that no longer opens is forgotten. */
export async function readStoredThread(id: string): Promise<EmailThreadDetail | null> {
  if (!storeSupported) return null;
  return serial(async () => {
    const u = await ensureUser();
    if (!u || !index?.entries[id]) return null;
    const raw = await readText(threadPath(u, id));
    if (raw) {
      try {
        return JSON.parse(raw) as EmailThreadDetail;
      } catch {
        /* forgotten below */
      }
    }
    await dropEntries(u, [id]);
    saveIndex();
    return null;
  });
}

/** The last inbox list seen (all mailboxes, newest first), for painting before the network. */
export async function readStoredInbox(): Promise<EmailThreadSummary[] | null> {
  if (!deviceMailSupported) return null;
  return serial(async () => {
    const u = await ensureUser();
    if (!u) return null;
    const raw = await readText(`${userDir(u)}list.json`);
    if (!raw) return null;
    try {
      const list = JSON.parse(raw) as EmailThreadSummary[];
      // The first page always paints, as the old AsyncStorage list did.
      return list.filter((t, i) => i < LIST_PAGE_SIZE || withinDeviceKeep(t.lastMessageAt, Date.now()));
    } catch {
      return null;
    }
  });
}

// ── Writing ───────────────────────────────────────────────────────────────

/** When each thread last left the store because it was removed (ms): a fetch started before must not bring it back. */
const removedAt = new Map<string, number>();

/**
 * Keep (or refresh) one thread as the reader got it. Read mail outside the
 * window, removed mail and suspected spam leave instead. `fetchedAt` is when
 * the request for it started: a removal after that wins (ADR 0286).
 */
export function storeThread(detail: EmailThreadDetail, fetchedAt: number): Promise<void> {
  if (!storeSupported) return Promise.resolve();
  const at = epoch;
  return serial(async () => {
    const u = await ensureUser();
    if (!u || !index || at !== epoch) return;
    const t = detail.thread;
    const id = t.id;
    if ((removedAt.get(id) ?? 0) >= fetchedAt) return;
    if (
      !keptOnDevice(t, Date.now()) ||
      t.isArchived ||
      t.labelIds.includes('TRASH') ||
      suspectedForDevice(detail)
    ) {
      if (index.entries[id]) {
        await dropEntries(u, [id]);
        saveIndex();
      }
      return;
    }
    // Some messages arrived without their text; a copy kept now would never
    // be refetched (the thread's newest message has not changed).
    if (detail.bodiesPending) return;
    const text = JSON.stringify(detailForDevice(detail));
    const bytes = utf8Length(text);
    if (bytes > DEVICE_MAIL_MAX_ENTRY_BYTES) return;
    try {
      if (!(await writeText(threadPath(u, id), text))) return;
    } catch {
      return; // out of space, most likely: the email still opens online
    }
    index.entries[id] = { lastMessageAt: t.lastMessageAt, bytes, storedAt: Date.now(), summary: t };
    await dropEntries(u, deviceMailToPrune(index, Date.now(), limits));
    saveIndex();
  }).catch(() => {});
}

export function removeStoredThreads(ids: readonly string[]): Promise<void> {
  if (!storeSupported || ids.length === 0) return Promise.resolve();
  const now = Date.now();
  for (const [id, t] of removedAt) if (now - t > 10 * 60_000) removedAt.delete(id);
  for (const id of ids) removedAt.set(id, now);
  return serial(async () => {
    const u = await ensureUser();
    if (!u || !index || !ids.some((id) => index?.entries[id])) return;
    await dropEntries(u, ids);
    saveIndex();
  }).catch(() => {});
}

/** A server event about one thread: patch the stored row, or drop it when it left the inbox. */
export function applyThreadUpdate(e: EmailThreadUpdatedEvent): Promise<void> {
  if (!storeSupported) return Promise.resolve();
  if (e.isArchived || e.labelIds.includes('TRASH')) return removeStoredThreads([e.threadId]);
  return serial(async () => {
    const u = await ensureUser();
    const entry = index?.entries[e.threadId];
    if (!u || !entry) return;
    entry.summary = { ...entry.summary, isUnread: e.isUnread, labelIds: e.labelIds };
    const raw = await readText(threadPath(u, e.threadId));
    if (raw) {
      try {
        const d = JSON.parse(raw) as EmailThreadDetail;
        d.thread = { ...d.thread, isUnread: e.isUnread, labelIds: e.labelIds };
        await writeText(threadPath(u, e.threadId), JSON.stringify(d));
      } catch {
        /* the next pass replaces it */
      }
    }
    // Read elsewhere: an old email kept only for being unread now leaves.
    await dropEntries(u, deviceMailToPrune(index!, Date.now(), limits));
    saveIndex();
  }).catch(() => {});
}

/** The unread list's verdict on stored threads (ADR 0304): read state, and old ones no longer unread. */
function applyUnreadList(
  inbox: readonly EmailThreadSummary[],
  unread: readonly EmailThreadSummary[],
  unreadComplete: boolean,
): Promise<void> {
  const at = epoch;
  return serial(async () => {
    const u = await ensureUser();
    if (!u || !index || at !== epoch) return;
    const { states } = unreadReconcile(index, { inbox, unread, unreadComplete }, Date.now());
    for (const [id, s] of Object.entries(states)) {
      const e = index.entries[id];
      if (e) e.summary = { ...e.summary, isUnread: s.isUnread, labelIds: s.labelIds };
    }
    await dropEntries(u, deviceMailToPrune(index, Date.now(), limits));
    saveIndex();
  }).catch(() => {});
}

/**
 * A fresh read of the unfiltered inbox, newest first. Keeps it for offline
 * painting (older rows already stored stay behind it) and drops stored threads
 * the list shows were removed elsewhere.
 */
export function storeInboxList(rows: readonly EmailThreadSummary[], complete: boolean): Promise<void> {
  if (!storeSupported) return Promise.resolve();
  const at = epoch;
  return serial(async () => {
    const u = await ensureUser();
    if (!u || !index || at !== epoch) return;
    let older: EmailThreadSummary[] = [];
    if (!complete && rows.length > 0) {
      const raw = await readText(`${userDir(u)}list.json`);
      const oldest = Math.min(...rows.map((t) => Date.parse(t.lastMessageAt)));
      const seen = new Set(rows.map((t) => t.id));
      try {
        older = raw
          ? (JSON.parse(raw) as EmailThreadSummary[]).filter(
              (t) => !seen.has(t.id) && Date.parse(t.lastMessageAt) < oldest && withinDeviceKeep(t.lastMessageAt, Date.now()),
            )
          : [];
      } catch {
        older = [];
      }
    }
    const gone = goneFromInbox(index, rows, complete);
    const goneSet = new Set(gone);
    await dropEntries(u, [...gone, ...deviceMailToPrune(index, Date.now(), limits)]);
    await writeText(
      `${userDir(u)}list.json`,
      JSON.stringify([...rows, ...older.filter((t) => !goneSet.has(t.id))]),
    ).catch(() => {});
    saveIndex();
  }).catch(() => {});
}

// ── The background pass ───────────────────────────────────────────────────

let passRunning: Promise<void> | null = null;
let passAgain = false;
let lastPassAt = 0;

let continueTimer: ReturnType<typeof setTimeout> | null = null;
/** The lists the last pass read, for the pass that continues it (ADR 0304:
 *  a catch-up goes on every few seconds, and re-reading up to a dozen list
 *  pages each time cost more than the threads it then fetched). */
let carried: {
  epoch: number;
  at: number;
  inbox: { rows: EmailThreadSummary[]; complete: boolean };
  unread: { rows: EmailThreadSummary[]; complete: boolean };
} | null = null;
/** Threads fetched and deliberately not kept, by the newest-message time they had then. */
const notKept = new Map<string, string>();

// A browser tab coming back into view, or back online, is where a phone would
// re-focus the Email tab: catch up (still at most one pass a minute).
const wakePass = () => {
  if (useApp.getState().user && canFetch()) scheduleDeviceMailPass();
};
if (isWeb && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', wakePass);
}
// The server reachable again (ADR 0311), on every platform.
onNetworkChange((online) => {
  if (online) wakePass();
});

/** In front and online: a pass fetches nothing for a hidden app or tab, or offline. */
function canFetch(): boolean {
  if (!isOnline()) return false;
  if (isWeb) {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }
  return AppState.currentState === 'active';
}

/**
 * After a sync, or when the Email tab comes into view: read the inbox back to
 * the 30-day line plus every unread email, and download what is new or
 * changed, unread first (ADR 0302, ADR 0304). One at a time, at most one a
 * minute unless `force`; a pass that ran out of budget goes on by itself.
 */
export function scheduleDeviceMailPass(opts: { force?: boolean; continuation?: boolean } = {}): void {
  if (!storeSupported) return;
  // Anything but the pass's own continuation may bring new mail: read the lists again.
  if (!opts.continuation) carried = null;
  if (passRunning) {
    // A sync finished during a pass: one more after it, for what it brought.
    if (opts.force) passAgain = true;
    return;
  }
  if (!opts.force && Date.now() - lastPassAt < PASS_MIN_GAP_MS) return;
  lastPassAt = Date.now();
  passRunning = runPass(!!opts.continuation)
    .catch(() => {})
    .finally(() => {
      passRunning = null;
      if (passAgain) {
        passAgain = false;
        scheduleDeviceMailPass({ force: true });
      }
    });
}

/** Pages of one inbox list, newest first, until `stop` says the last row is far enough. */
async function readList(
  opts: { unreadOnly?: boolean },
  maxPages: number,
  stop: (last: EmailThreadSummary) => boolean,
): Promise<{ rows: EmailThreadSummary[]; complete: boolean }> {
  const rows: EmailThreadSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const page = await listEmailThreads({ mode: 'traditional', ...opts, cursor });
    for (const t of page) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        rows.push(t);
      }
    }
    if (page.length < LIST_PAGE_SIZE) return { rows, complete: true };
    const last = page[page.length - 1];
    if (stop(last)) break;
    cursor = threadPageCursor(last);
  }
  return { rows, complete: false };
}

async function runPass(continuation: boolean): Promise<void> {
  try {
    await passBody(continuation);
  } finally {
    await indexWrite.flush().catch(() => {});
  }
}

async function passBody(continuation: boolean): Promise<void> {
  const at = epoch;
  if (!canFetch()) return;
  if (!isWeb && !(await deviceMailReady())) return;
  const u = await serial(ensureUser);
  if (!u) return;
  const reuse =
    continuation && carried && carried.epoch === at && Date.now() - carried.at < CARRIED_LISTS_MS ? carried : null;
  const inbox =
    reuse?.inbox ??
    (await readList({}, DEVICE_MAIL_MAX_LIST_PAGES, (last) => !withinDeviceKeep(last.lastMessageAt, Date.now())));
  const unread = reuse?.unread ?? (await readList({ unreadOnly: true }, DEVICE_MAIL_UNREAD_MAX_LIST_PAGES, () => false));
  if (at !== epoch) return;
  if (!reuse) {
    carried = { epoch: at, at: Date.now(), inbox, unread };
    await storeInboxList(inbox.rows, inbox.complete);
    await applyUnreadList(inbox.rows, unread.rows, unread.complete);
  }
  const all = [...inbox.rows, ...unread.rows];
  const newest = new Map(all.map((t) => [t.id, t.lastMessageAt]));
  const wanted = threadsToPrefetch(all, index ?? emptyDeviceMailIndex(), Date.now(), Infinity).filter(
    // A removal since the lists were read wins over a (carried) list.
    (id) => notKept.get(id) !== newest.get(id) && !(reuse && removedAt.has(id)),
  );
  const ids = wanted.slice(0, DEVICE_MAIL_FETCH_PER_PASS);
  let next = 0;
  let failuresInARow = 0;
  const worker = async () => {
    while (next < ids.length && at === epoch && canFetch() && failuresInARow < DEVICE_MAIL_MAX_FAILURES_IN_A_ROW) {
      const id = ids[next++];
      const fetchedAt = Date.now();
      try {
        await storeThread(await getEmailThread(id, { prefetch: 'cache' }), fetchedAt);
        failuresInARow = 0;
        // Suspected spam, too large, removed meanwhile: not asked for again
        // until a new message arrives in it.
        if (index && !index.entries[id]) notKept.set(id, newest.get(id) ?? '');
      } catch {
        failuresInARow += 1; // skipped this pass; the next one asks again
      }
    }
  };
  await Promise.all(Array.from({ length: DEVICE_MAIL_FETCH_CONCURRENCY }, worker));
  // More waiting and nothing stopped us: go on shortly, without re-asking the user.
  if (wanted.length > ids.length && next >= ids.length && at === epoch && canFetch() && !continueTimer) {
    continueTimer = setTimeout(() => {
      continueTimer = null;
      scheduleDeviceMailPass({ force: true, continuation: true });
    }, PASS_CONTINUE_MS);
  }
}

// ── Sign-out ──────────────────────────────────────────────────────────────

onSignOut(async () => {
  if (!storeSupported) return;
  epoch += 1;
  passAgain = false;
  carried = null;
  // The folder goes below; nothing waiting to be written matters any more.
  indexWrite.cancel();
  await serial(async () => {
    activeUser = null;
    index = null;
    keyCache = null;
    notKept.clear();
    removedAt.clear();
    if (continueTimer) clearTimeout(continueTimer);
    continueTimer = null;
    memory.clear();
    await removeFile(ROOT);
    const ss = await secureStore();
    await ss?.deleteItemAsync(SECURE_KEY_NAME).catch(() => {});
  });
});
