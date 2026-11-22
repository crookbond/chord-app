/**
 * One decision batch card: a same-list-name group of email-derived list
 * items ("Add all to Costco"), or a lone event/task rendered expanded.
 * Shared by the AI feed (ADR 0146) and the category sheet it replaced.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { answerProposal } from '@/proposal-answers';
import type { DecisionBatch } from '@/email-decisions';
import { MagicCard } from '@/email-magic';
import { byScheme, themed } from '@/theme';

export function BatchCard({
  batch,
  onChanged,
}: {
  batch: DecisionBatch;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(batch.items.length <= 1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (expanded || batch.items.length === 1) {
    return (
      <View style={styles.batchWrap}>
        {batch.items.map((d) => (
          <MagicCard
            key={d.proposalId}
            magic={d}
            wide
            threadId={d.threadRowId}
            onDismissed={() => onChanged()}
            onConfirmed={() => onChanged()}
          />
        ))}
        {batch.items.length > 1 ? (
          <Pressable onPress={() => setExpanded(false)} hitSlop={6}>
            <Text style={styles.collapse}>Collapse</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const headline =
    batch.kind === 'event'
      ? `${batch.items.length} dates from email`
      : batch.kind === 'task'
        ? `${batch.items.length} to-dos found`
        : `${batch.items.length} items → ${batch.listName ?? 'list'}`;
  const detail = batch.items.map((d) => d.title).join(' · ');

  const addAll = async () => {
    setBusy(true);
    setStatus(null);
    let ok = 0;
    let waiting = 0;
    let fail = 0;
    for (const d of batch.items) {
      try {
        const res = await answerProposal({
          proposalId: d.proposalId,
          memberIds: [d.proposalId],
          action: 'confirm',
          label: d.title,
        });
        if (res.queued) waiting += 1;
        else ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    setStatus(
      [
        ok > 0 || (waiting === 0 && fail === 0) ? `${ok} added` : '',
        waiting > 0 ? `${waiting} will be added when you're back online` : '',
        fail > 0 ? `${fail} need a look - see Action Items` : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
    onChanged();
  };

  return (
    <View style={styles.batchCard}>
      {batch.items[0]?.targetGroupName ? (
        <Text style={styles.batchChip}>→ {batch.items[0].targetGroupName}</Text>
      ) : null}
      <Text style={styles.batchTitle}>{headline}</Text>
      <Text style={styles.batchDetail} numberOfLines={3}>
        {detail}
      </Text>
      {status ? <Text style={styles.batchStatus}>{status}</Text> : null}
      <View style={styles.batchActs}>
        <Pressable style={styles.addAll} disabled={busy} onPress={() => void addAll()}>
          <Text style={styles.addAllTxt}>{busy ? '…' : 'Add all'}</Text>
        </Pressable>
        <Pressable style={styles.review} disabled={busy} onPress={() => setExpanded(true)}>
          <Text style={styles.reviewTxt}>Review</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  batchWrap: { gap: 8 },
  batchCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    padding: 12,
  },
  batchChip: { color: colors.accent, fontSize: 11, fontWeight: '700' },
  batchTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 4 },
  batchDetail: { color: colors.muted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  batchStatus: { color: colors.green, fontSize: 12, fontWeight: '600', marginTop: 6 },
  batchActs: { flexDirection: 'row', gap: 8, marginTop: 10 },
  addAll: {
    borderWidth: 1,
    borderColor: byScheme('#85B7EB', '#2F5C8A'),
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  addAllTxt: { color: byScheme('#185FA5', '#8EC2F5'), fontSize: 12, fontWeight: '600' },
  review: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  reviewTxt: { color: colors.text, fontSize: 12, fontWeight: '500' },
  collapse: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 4 },
}));
