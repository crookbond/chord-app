/**
 * ADR 0083 - cross-domain urgent strip above the AI map. Only deadline-bearing
 * decisions. ✕ dismisses the suggestion for real (it used to be a local
 * "not now" that left the same card standing in Feed and Action Items), and
 * the icon beside it archives or trashes the email the suggestion came from.
 *
 * One compact card rather than a stack of separate ones: the same
 * `urgentDecisions()` set (still capped at 3, still 7-days-out), grouped
 * under one header with a row per item - icon, what it needs, one button.
 * The strip reaches 7 days out (ADR 0083 §4), so the card header can't claim
 * "today" for all of it; each row carries its own short urgency word instead.
 */
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { EmailDecision } from '@chord/kernel';

import { rejectProposal } from '@/api';
import { answerProposal } from '@/proposal-answers';
import { unitDueDate } from '@/email-decisions';
import { PutAwayButton } from '@/email-put-away-button';
import { putAwayErrorText, putEmailAway, useEmailRemoveAction } from '@/email-remove-action';
import { themed } from '@/theme';

const KIND_ICON: Record<EmailDecision['kind'], string> = {
  event: '📅',
  task: '✅',
  list: '📋',
  change: '✏️',
};

const KIND_BUTTON: Record<EmailDecision['kind'], string> = {
  event: 'Add to calendar',
  task: 'Add to-do',
  list: 'Add to list',
  change: 'Apply',
};

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Short inline tag, distinct from the old standalone `urgencyLabel` wording -
 *  this sits next to a category name in a compact row, not as its own line. */
function urgencyTag(iso: string | null): string {
  if (!iso) return 'Soon';
  const due = Date.parse(iso);
  if (!Number.isFinite(due)) return 'Soon';
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  return due <= endOfDay.getTime() ? 'Today' : 'This week';
}

function UrgentRow({
  decision,
  isLast,
  onResolved,
}: {
  decision: EmailDecision;
  isLast: boolean;
  /** Confirmed, dismissed, or its email put away: gone from every view. */
  onResolved: (proposalId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const removeAction = useEmailRemoveAction();

  const confirm = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await answerProposal({
        proposalId: decision.proposalId,
        memberIds: [decision.proposalId],
        action: 'confirm',
        label: decision.title,
      });
      onResolved(decision.proposalId);
    } catch {
      setErr('Failed — see To Do’s');
      setBusy(false);
    }
  }, [decision.proposalId, decision.title, onResolved]);

  const dismiss = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await answerProposal({
        proposalId: decision.proposalId,
        memberIds: [decision.proposalId],
        action: 'reject',
        label: decision.title,
      });
      onResolved(decision.proposalId);
    } catch {
      setErr("Couldn't dismiss — try again");
      setBusy(false);
    }
  }, [decision.proposalId, decision.title, onResolved]);

  const putAway = useCallback(async () => {
    const threadId = decision.threadRowId;
    if (!threadId) return;
    setBusy(true);
    setErr(null);
    try {
      await putEmailAway(threadId, removeAction);
      await rejectProposal(decision.proposalId).catch(() => {});
      onResolved(decision.proposalId);
    } catch {
      setErr(putAwayErrorText(removeAction));
      setBusy(false);
    }
  }, [decision.proposalId, decision.threadRowId, onResolved, removeAction]);

  // A deadline lifted out of an email is unanswerable without the email it came
  // from, so tapping the text is a way back to it. Null when the source thread
  // was never mirrored - then there is nothing to open.
  const threadId = decision.threadRowId;
  const due = unitDueDate(decision);
  const tag = urgencyTag(due);

  const texts = (
    <>
      <Text style={styles.meta} numberOfLines={1}>
        <Text style={tag === 'Today' ? styles.tagToday : styles.tagSoon}>{tag}</Text>
        {'  ·  '}
        {decision.categoryTitle ?? 'Email'}
        {decision.targetGroupName ? `  ·  → ${decision.targetGroupName}` : ''}
      </Text>
      <Text style={styles.title} numberOfLines={2}>
        {decision.title}
        {due ? ` — ${formatDue(due)}` : ''}
      </Text>
      {err ? <Text style={styles.err}>{err}</Text> : null}
    </>
  );

  return (
    <View style={[styles.row, !isLast && styles.rowDivider]}>
      <Text style={styles.icon}>{KIND_ICON[decision.kind]}</Text>
      {threadId ? (
        <Pressable style={styles.texts} onPress={() => router.push(`/email/${threadId}`)}>
          {texts}
        </Pressable>
      ) : (
        <View style={styles.texts}>{texts}</View>
      )}
      <View style={styles.acts}>
        <Pressable style={styles.confirm} disabled={busy} onPress={() => void confirm()}>
          <Text style={styles.confirmTxt}>{busy ? '…' : KIND_BUTTON[decision.kind]}</Text>
        </Pressable>
        {threadId ? (
          <PutAwayButton action={removeAction} busy={busy} onPress={() => void putAway()} />
        ) : null}
        <Pressable
          style={styles.dis}
          disabled={busy}
          onPress={() => void dismiss()}
          accessibilityLabel="Dismiss"
          hitSlop={6}
        >
          <Text style={styles.disTxt}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function EmailUrgentStrip({
  decisions,
  onResolved,
  capped = true,
}: {
  decisions: EmailDecision[];
  onResolved: (proposalId: string) => void;
  /** Scroll the rows inside a box about a third of the screen tall, so the
   *  card never pushes what is below it off the screen. Off when the card
   *  already scrolls with a list. */
  capped?: boolean;
}) {
  const { height } = useWindowDimensions();
  if (decisions.length === 0) return null;
  const rows = decisions.map((d, i) => (
    <UrgentRow
      key={d.proposalId}
      decision={d}
      isLast={i === decisions.length - 1}
      onResolved={onResolved}
    />
  ));
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Needs your attention</Text>
      {capped ? (
        <ScrollView
          style={{ maxHeight: Math.max(160, Math.round(height * 0.33)) }}
          nestedScrollEnabled
        >
          {rows}
        </ScrollView>
      ) : (
        rows
      )}
      <Text style={styles.footer}>
        {decisions.length} suggestion{decisions.length === 1 ? '' : 's'} · nothing saved yet
      </Text>
    </View>
  );
}

const styles = themed((colors) => ({
  card: {
    marginHorizontal: 11,
    marginTop: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  icon: { fontSize: 16, marginTop: 1 },
  texts: { flex: 1, minWidth: 0 },
  meta: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  tagToday: { color: colors.red, fontWeight: '700' },
  tagSoon: { color: colors.muted, fontWeight: '700' },
  title: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 2 },
  err: { color: colors.red, fontSize: 11, fontWeight: '600', marginTop: 3 },
  acts: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  confirm: {
    backgroundColor: colors.accentLight,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  confirmTxt: { color: colors.accentDark, fontSize: 12, fontWeight: '700' },
  dis: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disTxt: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  footer: {
    color: colors.muted,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 8,
  },
}));
