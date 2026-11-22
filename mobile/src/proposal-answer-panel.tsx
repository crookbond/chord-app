/**
 * ADR 0311 addendum - ✓/✕ answers made offline that the server refused when
 * they were sent (answered elsewhere in the meantime, expired, a calendar
 * still to pick). Shown with the reason until Retry or Discard, so nothing a
 * person tapped disappears silently.
 */
import { Pressable, Text, View } from 'react-native';

import { useFailedProposalAnswers } from './proposal-answers';
import { deleteQueuedSend, retryQueuedSend } from './send-queue';
import { themed } from './theme';

export function ProposalAnswerPanel() {
  const failed = useFailedProposalAnswers();
  if (failed.length === 0) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Couldn't send</Text>
      {failed.map((m) => (
        <View key={m.localId} style={styles.row}>
          <Text style={styles.text}>
            {m.payload.action === 'confirm' ? 'Adding' : 'Dismissing'} "{m.payload.label}" did not go through
            {m.error ? `: ${m.error}` : '.'}
          </Text>
          <View style={styles.buttons}>
            <Pressable onPress={() => retryQueuedSend(m.localId)} hitSlop={6}>
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
            <Pressable onPress={() => deleteQueuedSend(m.localId)} hitSlop={6}>
              <Text style={styles.buttonText}>Discard</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
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
  buttons: { flexDirection: 'row' as const, gap: 16, marginTop: 4 },
  buttonText: { color: c.accent, fontWeight: '600' as const, fontSize: 14 },
}));
