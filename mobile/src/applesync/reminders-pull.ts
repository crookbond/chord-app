/**
 * ADR 0057 - read device Reminders changes back into Chord (the second half of
 * the two-way bridge; the write half is `reminders.ts`).
 *
 * Reconciles **mapped** reminders only (created by us, tracked in the id-map):
 * a completion toggle, a title/text edit, or a delete on the device flows back
 * into the Chord task / list item via the existing REST API. Conflict handling
 * is compare-by-value (push device state only when it differs from Chord's
 * current value), which also prevents a write→read echo without timestamps.
 *
 * New reminders created by the user directly in a Chord-managed list are NOT
 * yet turned into Chord items (needs group/list-target resolution) - a noted
 * follow-on. iOS only.
 */
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import {
  deleteListItem,
  deleteTask,
  listAllLists,
  listAllTasks,
  setListItemChecked,
  updateListItemText,
  updateTask,
} from '../api';
import { allEntries, getByEkId, removeByChordId } from './idmap';
import { isTaskClosed, LIST_ITEM_NS, TASK_NS } from './reminders';

const CHORD_TASKS_LIST = 'Chord';

async function remindersListIdByTitle(title: string): Promise<string | null> {
  const lists = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  return lists.find((l) => l.title === title)?.id ?? null;
}

async function allReminders(listId: string): Promise<Calendar.Reminder[]> {
  // status=null → both complete + incomplete; no date bounds.
  return Calendar.getRemindersAsync([listId], null, null, null);
}

/**
 * Reconcile device Reminders → Chord. No-op off iOS / without permission. Run on
 * foreground (after the Chord→device push, so deletions are attributed
 * correctly).
 */
export async function pullRemindersToChord(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const { status } = await Calendar.requestRemindersPermissionsAsync();
  if (status !== 'granted') return;

  try {
    // ── tasks ──
    const tasks = await listAllTasks();
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const tasksListId = await remindersListIdByTitle(CHORD_TASKS_LIST);
    if (tasksListId) {
      const reminders = await allReminders(tasksListId);
      const deviceIds = new Set(reminders.map((r) => r.id).filter((id): id is string => !!id));

      for (const r of reminders) {
        if (!r.id) continue;
        const m = await getByEkId(TASK_NS, r.id);
        if (!m) continue;
        const task = taskById.get(m.chordId);
        if (!task) continue;
        const deviceDone = !!r.completed;
        // Terminal states (done/archived/superseded) all mean "completed" - a
        // still-completed reminder must not un-archive a task the server closed
        // after the fact.
        const chordDone = isTaskClosed(task.status);
        if (deviceDone !== chordDone) {
          await updateTask(m.chordId, { status: deviceDone ? 'done' : 'open' });
        } else if (r.title && r.title !== task.title) {
          await updateTask(m.chordId, { title: r.title });
        }
      }

      // Deleted on device → delete the Chord task (only when it still exists in
      // Chord; a Chord-side delete is handled by the push half instead).
      for (const { chordId, entry } of await allEntries(TASK_NS)) {
        if (deviceIds.has(entry.ekId) || !taskById.has(chordId)) continue;
        await deleteTask(chordId).catch(() => {});
        await removeByChordId(TASK_NS, chordId);
      }
    }

    // ── list items ──
    const lists = await listAllLists();
    const itemById = new Map(lists.flatMap((l) => l.items).map((i) => [i.id, i]));
    const deviceItemIds = new Set<string>();
    let queriedAnyList = false;
    for (const list of lists) {
      const rListId = await remindersListIdByTitle(list.name);
      if (!rListId) continue;
      queriedAnyList = true;
      const reminders = await allReminders(rListId);
      for (const r of reminders) {
        if (!r.id) continue;
        deviceItemIds.add(r.id);
        const m = await getByEkId(LIST_ITEM_NS, r.id);
        if (!m) continue;
        const item = itemById.get(m.chordId);
        if (!item) continue;
        const deviceChecked = !!r.completed;
        if (deviceChecked !== item.checked) {
          await setListItemChecked(m.chordId, deviceChecked);
        } else if (r.title && r.title !== item.text) {
          await updateListItemText(m.chordId, r.title);
        }
      }
    }
    if (queriedAnyList) {
      for (const { chordId, entry } of await allEntries(LIST_ITEM_NS)) {
        if (deviceItemIds.has(entry.ekId) || !itemById.has(chordId)) continue;
        await deleteListItem(chordId).catch(() => {});
        await removeByChordId(LIST_ITEM_NS, chordId);
      }
    }
  } catch (err) {
    console.warn('pullRemindersToChord failed', err);
  }
}
