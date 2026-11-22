/**
 * ADR 0311 addendum - the To Do's tabs' reads, each keeping a sealed copy for
 * offline use (`withSavedCopy`). They used to be saved only when their tab was
 * opened, so a tab never opened before the network went showed nothing. Now
 * every copy is refreshed whenever the app is online and signed in: at launch,
 * on reconnect and on return to the foreground, at most every few minutes.
 *
 * Saved here, not in `api.ts`: the Reminders sync reads tasks and lists too
 * and must never act on a saved copy.
 */
import { shouldWarmSavedCopies, type Group } from '@chord/kernel';
import { AppState } from 'react-native';

import {
  listAllFiles,
  listAllLists,
  listAllMemories,
  listAllProposals,
  listAllSaves,
  listAllTasks,
  listGroups,
  listTripStatuses,
  readSavedCopy,
  withSavedCopy,
} from './api';
import { isOnline, onNetworkChange } from './network';
import { onSignOut } from './sign-out';
import { useApp } from './store';

export const TODO_LOADERS = {
  tasks: () => withSavedCopy('tasks', listAllTasks),
  lists: () => withSavedCopy('lists', listAllLists),
  saves: () => withSavedCopy('saves', listAllSaves),
  memories: () => withSavedCopy('memories', listAllMemories),
  trips: () => withSavedCopy('trips', listTripStatuses),
  files: () => withSavedCopy('files', listAllFiles),
  proposals: () => listAllProposals(),
};

/** The name each loader's copy is saved under (`listAllProposals` saves its own). */
export const TODO_SAVED_NAMES: Record<keyof typeof TODO_LOADERS, string> = {
  tasks: 'tasks',
  lists: 'lists',
  saves: 'saves',
  memories: 'memories',
  trips: 'trips',
  files: 'files',
  proposals: 'proposals',
};

const WARM_GAP_MS = 5 * 60_000;
let lastWarmAt: number | null = null;
let warming = false;

/** Refresh every saved copy now, if online, signed in and not done lately. */
export function warmTodoCopies(): void {
  const now = Date.now();  if (
    warming ||
    !shouldWarmSavedCopies({
      online: isOnline(),
      signedIn: !!useApp.getState().user,
      lastWarmAt,
      now,
      minGapMs: WARM_GAP_MS,
    })
  ) {
    return;
  }
  warming = true;
  lastWarmAt = now;
  const reads: Promise<unknown>[] = [...Object.values(TODO_LOADERS).map((load) => load()), listGroups()];
  void Promise.allSettled(reads).finally(() => {
    warming = false;
  });
}

onNetworkChange((online) => {
  if (online) warmTodoCopies();
});
/**
 * The chat list and the group chips read the groups from the app store, which
 * starts empty: fill it from this device's saved copy at sign-in so they show
 * at once. Only while it is still empty - a real answer is never replaced.
 */
function showSavedGroups(userId: string): void {
  if (useApp.getState().groups.length > 0) return;
  void readSavedCopy<Group[]>('groups').then((saved) => {
    const st = useApp.getState();
    if (saved && saved.length > 0 && st.user?.id === userId && st.groups.length === 0) {
      st.setGroups(saved);
    }
  });
}

useApp.subscribe((s, prev) => {
  if (s.user?.id && s.user.id !== prev.user?.id) {
    lastWarmAt = null;
    showSavedGroups(s.user.id);
    warmTodoCopies();
  }
});
AppState.addEventListener('change', (state) => {
  if (state === 'active') warmTodoCopies();
});
onSignOut(() => {
  lastWarmAt = null;
});
warmTodoCopies();
{
  const signedIn = useApp.getState().user;
  if (signedIn) showSavedGroups(signedIn.id);
}
