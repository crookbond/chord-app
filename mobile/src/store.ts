import { create } from 'zustand';
import type { Group, Message, User } from '@chord/kernel';

interface AppState {
  user: User | null;
  groups: Group[];
  messagesByGroup: Record<string, Message[]>;

  setUser: (u: User | null) => void;
  setGroups: (gs: Group[]) => void;
  upsertGroup: (g: Group) => void;
  removeGroupLocal: (groupId: string) => void;
  renameGroupLocal: (groupId: string, name: string) => void;
  markGroupReadLocal: (groupId: string, lastReadAt: string) => void;
  setMessages: (groupId: string, ms: Message[]) => void;
  upsertMessage: (groupId: string, m: Message) => void;
  removeMessages: (groupId: string, ids: string[]) => void;
  /** Forget every cached message of a chat (after "clear chat"). */
  clearMessagesLocal: (groupId: string) => void;
  /** Drop cached messages a fresh newest-page fetch no longer contains
   *  (deleted while this device was not listening). */
  dropMissingFromLatest: (groupId: string, latest: Message[]) => void;
  appendBotDelta: (groupId: string, messageId: string, delta: string) => void;
  reset: () => void;
}

const BOT_STREAM_ISO = '__stream__';

function messageSortKey(m: Message): string {
  return m.createdAt === BOT_STREAM_ISO ? '9999-99-99T99:99:99.999Z' : m.createdAt;
}

function compareMessages(a: Message, b: Message): number {
  return messageSortKey(a).localeCompare(messageSortKey(b));
}

function isSortedAscending(ms: Message[]): boolean {
  for (let i = 1; i < ms.length; i++) {
    if (compareMessages(ms[i - 1], ms[i]) > 0) return false;
  }
  return true;
}

function ensureSorted(ms: Message[]): Message[] {
  if (ms.length < 2 || isSortedAscending(ms)) return ms;
  return ms.slice().sort(compareMessages);
}

/** Insert `m` into an ascending-sorted list. */
function insertSorted(list: Message[], m: Message): Message[] {
  const key = messageSortKey(m);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messageSortKey(list[mid]).localeCompare(key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  const next = list.slice();
  next.splice(lo, 0, m);
  return next;
}

/**
 * Merge two ascending-sorted lists by sort key. When the same `id` appears in
 * both, `b`'s copy wins. Assumes neither list itself contains duplicate ids.
 */
function mergeSortedByKey(a: Message[], b: Message[]): Message[] {
  const bIds = new Set(b.map((m) => m.id));
  const out: Message[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    // Skip a-side rows that b replaces (may sit at a different sort key).
    if (bIds.has(a[i].id)) {
      i++;
      continue;
    }
    const cmp = compareMessages(a[i], b[j]);
    if (cmp <= 0) {
      out.push(a[i++]);
    } else {
      out.push(b[j++]);
    }
  }
  while (i < a.length) {
    if (!bIds.has(a[i].id)) out.push(a[i]);
    i++;
  }
  while (j < b.length) out.push(b[j++]);
  return out;
}

export const useApp = create<AppState>((set) => ({
  user: null,
  groups: [],
  messagesByGroup: {},

  setUser: (user) => set({ user }),
  setGroups: (groups) => set({ groups }),
  upsertGroup: (g) =>
    set((s) => {
      const idx = s.groups.findIndex((x) => x.id === g.id);
      if (idx === -1) return { groups: [g, ...s.groups] };
      const next = s.groups.slice();
      next[idx] = g;
      return { groups: next };
    }),
  removeGroupLocal: (groupId) =>
    set((s) => {
      if (!s.groups.some((x) => x.id === groupId)) return {};
      const { [groupId]: _dropped, ...messagesByGroup } = s.messagesByGroup;
      return { groups: s.groups.filter((x) => x.id !== groupId), messagesByGroup };
    }),
  renameGroupLocal: (groupId, name) =>
    set((s) => {
      const idx = s.groups.findIndex((x) => x.id === groupId);
      if (idx === -1) return {};
      if (s.groups[idx].name === name) return {};
      const next = s.groups.slice();
      next[idx] = { ...next[idx], name };
      return { groups: next };
    }),
  markGroupReadLocal: (groupId, lastReadAt) =>
    set((s) => {
      const idx = s.groups.findIndex((x) => x.id === groupId);
      if (idx === -1) return {};
      const g = s.groups[idx];
      if (g.unreadCount === 0 && g.lastReadAt === lastReadAt) return {};
      const next = s.groups.slice();
      next[idx] = { ...g, unreadCount: 0, lastReadAt };
      return { groups: next };
    }),
  setMessages: (groupId, ms) =>
    set((s) => {
      const existing = s.messagesByGroup[groupId] ?? [];
      if (ms.length === 0) return {};
      const incoming = ensureSorted(ms);
      if (existing.length === 0) {
        return { messagesByGroup: { ...s.messagesByGroup, [groupId]: incoming.slice() } };
      }

      const incomingById = new Map(incoming.map((m) => [m.id, m]));
      let onlyUpdates = true;
      for (const m of incoming) {
        const prev = existing.find((e) => e.id === m.id);
        if (!prev || messageSortKey(prev) !== messageSortKey(m)) {
          onlyUpdates = false;
          break;
        }
      }
      if (onlyUpdates && incoming.length <= existing.length) {
        // Patch fields in place — order unchanged (reconnect backfill of
        // messages already on screen).
        let changed = false;
        const next = existing.map((e) => {
          const neu = incomingById.get(e.id);
          if (!neu || neu === e) return e;
          changed = true;
          return neu;
        });
        if (!changed) return {};
        return { messagesByGroup: { ...s.messagesByGroup, [groupId]: next } };
      }

      // Linear merge of two sorted lists (existing kept sorted by upsert).
      const kept = existing.filter((e) => !incomingById.has(e.id));
      const merged = mergeSortedByKey(kept, incoming);
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: merged } };
    }),
  upsertMessage: (groupId, m) =>
    set((s) => {
      const cur = s.messagesByGroup[groupId] ?? [];
      const idx = cur.findIndex((x) => x.id === m.id);
      if (idx === -1) {
        return { messagesByGroup: { ...s.messagesByGroup, [groupId]: insertSorted(cur, m) } };
      }
      const prev = cur[idx];
      if (messageSortKey(prev) === messageSortKey(m)) {
        if (prev === m) return {};
        const next = cur.slice();
        next[idx] = m;
        return { messagesByGroup: { ...s.messagesByGroup, [groupId]: next } };
      }
      const without = cur.slice(0, idx).concat(cur.slice(idx + 1));
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: insertSorted(without, m) } };
    }),
  removeMessages: (groupId, ids) =>
    set((s) => {
      const cur = s.messagesByGroup[groupId] ?? [];
      const gone = new Set(ids);
      const next = cur.filter((m) => !gone.has(m.id));
      if (next.length === cur.length) return {};
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: next } };
    }),
  clearMessagesLocal: (groupId) =>
    set((s) => {
      if (!(s.messagesByGroup[groupId] ?? []).length) return {};
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: [] } };
    }),
  dropMissingFromLatest: (groupId, latest) =>
    set((s) => {
      const cur = s.messagesByGroup[groupId] ?? [];
      if (cur.length === 0) return {};
      const settled = (m: Message) => !isStreamingPlaceholder(m);
      let next: Message[];
      if (latest.length === 0) {
        next = cur.filter((m) => !settled(m));
      } else {
        // Only judge messages strictly inside the fetched window: anything
        // older is outside the page, anything newer arrived after the fetch.
        const have = new Set(latest.map((m) => m.id));
        let lo = latest[0].createdAt;
        let hi = latest[0].createdAt;
        for (const m of latest) {
          if (m.createdAt < lo) lo = m.createdAt;
          if (m.createdAt > hi) hi = m.createdAt;
        }
        next = cur.filter(
          (m) => !settled(m) || have.has(m.id) || m.createdAt <= lo || m.createdAt > hi,
        );
      }
      if (next.length === cur.length) return {};
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: next } };
    }),
  appendBotDelta: (groupId, messageId, delta) =>
    set((s) => {
      const cur = s.messagesByGroup[groupId] ?? [];
      const idx = cur.findIndex((x) => x.id === messageId);
      if (idx === -1) {
        const placeholder: Message = {
          id: messageId,
          groupId,
          senderId: null,
          kind: 'bot',
          body: delta,
          mentionsBot: false,
          createdAt: BOT_STREAM_ISO,
        };
        return {
          messagesByGroup: {
            ...s.messagesByGroup,
            [groupId]: insertSorted(cur, placeholder),
          },
        };
      }
      const next = cur.slice();
      next[idx] = { ...next[idx], body: next[idx].body + delta };
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: next } };
    }),
  reset: () => set({ user: null, groups: [], messagesByGroup: {} }),
}));

export function isStreamingPlaceholder(m: Message): boolean {
  return m.kind === 'bot' && m.createdAt === BOT_STREAM_ISO;
}
