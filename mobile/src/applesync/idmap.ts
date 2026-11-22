/**
 * ADR 0057 - bidirectional id-map between Chord entity ids and the on-device
 * EventKit ids (reminders/events), persisted in AsyncStorage.
 *
 * Generalizes the old `chord:calendar:synced` Set: that only answered "have we
 * synced this id once" (good enough for one-way create). Two-way sync needs to
 * address an existing device item to update/delete it, and to map a
 * device-side change back to its Chord row - so we keep both directions plus
 * the device's `lastSeenModified` to drive last-writer-wins.
 *
 * Keyed by a namespace (`task`, `listItem`, `event`, …) so each entity kind has
 * its own map.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onSignOut } from '../sign-out';

export interface IdMapEntry {
  ekId: string;
  /** EventKit `lastModifiedDate` (ISO) at our last reconcile - LWW tiebreak. */
  lastSeenModified?: string;
}

type NsMap = Record<string, IdMapEntry>; // chordId → entry

const cache = new Map<string, NsMap>();
onSignOut(() => cache.clear());

function storageKey(ns: string): string {
  return `chord:applesync:idmap:${ns}`;
}

async function load(ns: string): Promise<NsMap> {
  const cached = cache.get(ns);
  if (cached) return cached;
  let map: NsMap = {};
  try {
    const raw = await AsyncStorage.getItem(storageKey(ns));
    if (raw) map = JSON.parse(raw) as NsMap;
  } catch {
    map = {};
  }
  cache.set(ns, map);
  return map;
}

async function persist(ns: string, map: NsMap): Promise<void> {
  cache.set(ns, map);
  try {
    await AsyncStorage.setItem(storageKey(ns), JSON.stringify(map));
  } catch {
    // best-effort; in-memory cache still serves this session
  }
}

export async function getByChordId(ns: string, chordId: string): Promise<IdMapEntry | undefined> {
  return (await load(ns))[chordId];
}

export async function getByEkId(
  ns: string,
  ekId: string,
): Promise<{ chordId: string; entry: IdMapEntry } | undefined> {
  const map = await load(ns);
  for (const [chordId, entry] of Object.entries(map)) {
    if (entry.ekId === ekId) return { chordId, entry };
  }
  return undefined;
}

export async function setMapping(
  ns: string,
  chordId: string,
  ekId: string,
  lastSeenModified?: string,
): Promise<void> {
  const map = await load(ns);
  map[chordId] = { ekId, lastSeenModified };
  await persist(ns, map);
}

export async function removeByChordId(ns: string, chordId: string): Promise<void> {
  const map = await load(ns);
  if (chordId in map) {
    delete map[chordId];
    await persist(ns, map);
  }
}

export async function allEntries(ns: string): Promise<Array<{ chordId: string; entry: IdMapEntry }>> {
  const map = await load(ns);
  return Object.entries(map).map(([chordId, entry]) => ({ chordId, entry }));
}
