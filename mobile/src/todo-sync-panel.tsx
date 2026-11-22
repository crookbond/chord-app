/**
 * ADR 0311 addendum - the "Couldn't sync" list at the top of To Do's: changes
 * made offline that the server did not fully take. A field someone else had
 * changed in the meantime is shown as "yours ..., now ..." with Keep mine or
 * Keep theirs; a to-do deleted by someone else just says so.
 */
import { todoConflictLine } from '@chord/kernel';
import { Pressable, Text, View } from 'react-native';

import { deleteQueuedSend, retryQueuedSend } from './send-queue';
import { themed } from './theme';
import {
  settleTodoNotice,
  useFailedTodoSends,
  useTodoSyncNotices,
  type TodoSyncNotice,
} from './todo-sync';

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

function headline(n: TodoSyncNotice): string {
  if (n.outcome === 'gone') {
    if (n.op.type === 'task.create') return `"${n.label}" was not added: you are no longer in that group.`;
    if (n.op.type === 'item.add') return `"${n.label}" was not added: that list is gone.`;
    return `"${n.label}" was deleted by someone else, so your change was not saved.`;
  }
  const deleting = n.conflicts.some((c) => c.field === 'deleted');
  if (deleting) return `You deleted "${n.label}", but someone else changed it since.`;
  if (n.outcome === 'partial') return `"${n.label}": most of your change was saved, but someone else changed this since:`;
  return `"${n.label}": someone else changed this since:`;
}

export function TodoSyncPanel() {
  const notices = useTodoSyncNotices();
  const failed = useFailedTodoSends();
  if (notices.length === 0 && failed.length === 0) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Couldn't sync</Text>
      {notices.map((n) => {
        const fields = n.conflicts.filter((c) => c.field !== 'deleted');
        return (
          <View key={n.id} style={styles.row}>
            <Text style={styles.text}>{headline(n)}</Text>
            {fields.map((c) => (
              <Text key={c.field} style={styles.line}>
                {todoConflictLine(c, formatDate)}
              </Text>
            ))}
            <View style={styles.buttons}>
              {n.outcome === 'gone' ? (
                <Button label="OK" onPress={() => void settleTodoNotice(n.id, 'theirs')} />
              ) : (
                <>
                  <Button
                    label={n.conflicts.some((c) => c.field === 'deleted') ? 'Delete it' : 'Keep mine'}
                    onPress={() => void settleTodoNotice(n.id, 'mine')}
                  />
                  <Button label="Keep theirs" onPress={() => void settleTodoNotice(n.id, 'theirs')} />
                </>
              )}
            </View>
          </View>
        );
      })}
      {failed.map((m) => (
        <View key={m.localId} style={styles.row}>
          <Text style={styles.text}>
            "{m.payload.label}" was not saved{m.error ? `: ${m.error}` : '.'}
          </Text>
          <View style={styles.buttons}>
            <Button label="Retry" onPress={() => retryQueuedSend(m.localId)} />
            <Button label="Discard" onPress={() => deleteQueuedSend(m.localId)} />
          </View>
        </View>
      ))}
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = themed((c) => ({
  box: {
    borderWidth: 1,
    borderColor: c.warn,
    backgroundColor: c.warnBg,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    gap: 10,
  },
  title: { fontWeight: '700' as const, color: c.text, fontSize: 15 },
  row: { gap: 4 },
  text: { color: c.text, fontSize: 14 },
  line: { color: c.muted, fontSize: 13, marginLeft: 8 },
  buttons: { flexDirection: 'row' as const, gap: 16, marginTop: 4 },
  button: { paddingVertical: 2 },
  buttonText: { color: c.accent, fontWeight: '600' as const, fontSize: 14 },
}));
