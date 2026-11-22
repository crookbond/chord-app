/**
 * ADR 0057 - write Chord tasks + list items into the iOS Reminders app
 * (EKReminder, via expo-calendar). iOS only - Android/web have no native
 * Reminders provider.
 *
 * Tasks land in a "Chord" reminders list; each Chord list (Costco, …) becomes
 * its own reminders list. Items are addressed through the shared id-map so a
 * later edit/complete/delete patches the same device reminder instead of
 * duplicating. The read-back (device → Chord) lives in `reminders-pull.ts`.
 */
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { listAllLists, listAllTasks } from '../api';
import { allEntries, getByChordId, removeByChordId, setMapping } from './idmap';
import { onSignOut } from '../sign-out';

export const TASK_NS = 'task';
export const LIST_ITEM_NS = 'listItem';
const CHORD_TASKS_LIST = 'Chord';

/**
 * Terminal task states - the device reminder shows completed, and the read-back
 * (reminders-pull) must treat these as "done" so a still-completed reminder
 * never reopens them. A task the user completes ('done') gets auto-archived by
 * the server after ~7 days ('archived'); treating only 'done' as completed made
 * the pull see done≠archived and write status:'done', un-archiving it - the
 * "completed tasks come back after a few days" bug (ADR 0057).
 */
export function isTaskClosed(status: string): boolean {
  return status === 'done' || status === 'archived' || status === 'superseded';
}

let permissionPromise: Promise<boolean> | undefined;
const listIdByTitle = new Map<string, string>();
onSignOut(() => listIdByTitle.clear());

async function ensureRemindersPermission(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false; // reminders are iOS-only
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    const { status } = await Calendar.requestRemindersPermissionsAsync();
    return status === 'granted';
  })();
  return permissionPromise;
}

/** Get-or-create a reminders list by title, on the device's reminders source. */
async function ensureRemindersList(title: string): Promise<string | null> {
  const cached = listIdByTitle.get(title);
  if (cached) return cached;
  const lists = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  const existing = lists.find((l) => l.title === title);
  if (existing) {
    listIdByTitle.set(title, existing.id);
    return existing.id;
  }
  // Create on the source of an existing reminders list (every device with the
  // Reminders app has at least the default list, hence a usable source).
  const sourceId = lists.find((l) => l.source?.id)?.source?.id;
  if (!sourceId) return null;
  try {
    const id = await Calendar.createCalendarAsync({
      title,
      entityType: Calendar.EntityTypes.REMINDER,
      sourceId,
      name: title,
      ownerAccount: 'chord',
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
      color: '#7C5CFF',
    });
    listIdByTitle.set(title, id);
    return id;
  } catch (err) {
    console.warn(`ensureRemindersList(${title}) failed`, err);
    return null;
  }
}

interface ReminderFields {
  title: string;
  completed: boolean;
  dueDate?: Date;
  alarms?: Calendar.Alarm[];
}

function taskReminder(task: {
  title: string;
  status: string;
  dueAt?: string;
  remindAt?: string;
}): ReminderFields {
  return {
    title: task.title,
    completed: isTaskClosed(task.status),
    dueDate: task.dueAt ? new Date(task.dueAt) : undefined,
    alarms: task.remindAt ? [{ absoluteDate: new Date(task.remindAt).toISOString() }] : undefined,
  };
}

async function upsertReminder(
  ns: string,
  chordId: string,
  listId: string,
  fields: ReminderFields,
): Promise<void> {
  const existing = await getByChordId(ns, chordId);
  if (existing) {
    await Calendar.updateReminderAsync(existing.ekId, fields);
    return;
  }
  const ekId = await Calendar.createReminderAsync(listId, fields);
  await setMapping(ns, chordId, ekId);
}

/**
 * Full reconcile Chord → Reminders. Idempotent: upserts every current task and
 * list item, and deletes device reminders whose Chord source is gone. Run on
 * foreground and after `onResourceChanged`. No-op off iOS / without permission.
 */
export async function syncRemindersFromChord(): Promise<void> {
  if (!(await ensureRemindersPermission())) return;

  try {
    // ── tasks → "Chord" reminders list ──
    const tasks = await listAllTasks();
    const tasksListId = await ensureRemindersList(CHORD_TASKS_LIST);
    if (tasksListId) {
      const liveTaskIds = new Set(tasks.map((t) => t.id));
      for (const t of tasks) {
        await upsertReminder(TASK_NS, t.id, tasksListId, taskReminder(t));
      }
      // Delete device reminders for tasks that no longer exist in Chord.
      for (const { chordId, entry } of await allEntries(TASK_NS)) {
        if (liveTaskIds.has(chordId)) continue;
        try {
          await Calendar.deleteReminderAsync(entry.ekId);
        } catch {
          /* already gone */
        }
        await removeByChordId(TASK_NS, chordId);
      }
    }

    // ── each Chord list → a same-named reminders list ──
    const lists = await listAllLists();
    const liveItemIds = new Set<string>();
    for (const list of lists) {
      const rListId = await ensureRemindersList(list.name);
      if (!rListId) continue;
      for (const item of list.items) {
        liveItemIds.add(item.id);
        await upsertReminder(LIST_ITEM_NS, item.id, rListId, {
          title: item.text,
          completed: item.checked,
        });
      }
    }
    for (const { chordId, entry } of await allEntries(LIST_ITEM_NS)) {
      if (liveItemIds.has(chordId)) continue;
      try {
        await Calendar.deleteReminderAsync(entry.ekId);
      } catch {
        /* already gone */
      }
      await removeByChordId(LIST_ITEM_NS, chordId);
    }
  } catch (err) {
    console.warn('syncRemindersFromChord failed', err);
  }
}
