/**
 * ADR 0346 - what the calendar says about an email event: a conflict (shown
 * to this user only), already there, a prep next to it, or a question asked
 * once. Shared by the card beside the email and the Action Items row.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { suggestionWhen, type FitEvent, type OverlapAnswer, type ProposalCalendarFit } from '@chord/kernel';

import { answerOverlap } from '@/api';
import { themed } from '@/theme';

function at(e: FitEvent): string {
  const start = suggestionWhen(e.startsAt, { weekday: false, withTime: true }) ?? '';
  if (!e.endsAt) return start;
  const end = new Date(e.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${start}–${end}`;
}

export function CalendarFitNote({
  fit,
  proposalId,
  onAnswered,
  onSuggestTime,
}: {
  fit: ProposalCalendarFit | undefined;
  proposalId: string;
  /** Called after an answer was stored, so the caller can reload the verdict. */
  onAnswered?: () => void;
  /** Shown on a conflict: draft a reply offering other times. */
  onSuggestTime?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  if (!fit) return null;

  const send = async (eventId: string, answer: OverlapAnswer) => {
    setBusy(true);
    setErr(null);
    try {
      await answerOverlap(proposalId, { eventId, answer });
      setAnswered((s) => new Set(s).add(eventId));
      onAnswered?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      {fit.already ? (
        <Text style={styles.ok}>✓ Already on your calendar: {fit.already.title}</Text>
      ) : null}
      {fit.conflicts.map((c) => (
        <Text key={c.eventId} style={styles.warn}>
          ⚠ Overlaps {c.title}, {at(c)}
        </Text>
      ))}
      {(fit.held ?? []).map((h) => (
        <Text key={h.eventId} style={styles.note}>
          Held in Chord for {h.title}, {at(h)} (waiting on its invite)
        </Text>
      ))}
      {fit.related.map((r) => (
        <Text key={r.eventId} style={styles.note}>
          Next to {r.title}, {at(r)} (not a conflict)
        </Text>
      ))}
      {fit.questions
        .filter((q) => !answered.has(q.eventId))
        .map((q) => (
          <View key={q.eventId} style={styles.q}>
            <Text style={styles.note}>
              {q.ask === 'movable'
                ? `Overlaps ${q.title}, ${at(q)}. Can it move?`
                : `Is ${q.title}, ${at(q)}, the same meeting?`}
            </Text>
            <View style={styles.chips}>
              {(q.ask === 'movable'
                ? ([['movable', 'It can move'], ['fixed', 'Keep it']] as const)
                : ([['same', 'Same meeting'], ['different', 'Different']] as const)
              ).map(([value, label]) => (
                <Pressable
                  key={value}
                  disabled={busy}
                  onPress={() => void send(q.eventId, value)}
                  style={({ pressed }) => [styles.chip, (pressed || busy) && { opacity: 0.6 }]}
                >
                  <Text style={styles.chipTxt}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      {fit.outsideWorkHours ? <Text style={styles.note}>Outside work hours ({fit.outsideWorkHours})</Text> : null}
      {fit.verdict === 'conflict' && onSuggestTime ? (
        <Pressable onPress={onSuggestTime} hitSlop={4}>
          <Text style={styles.link}>Suggest another time ›</Text>
        </Pressable>
      ) : null}
      {err ? <Text style={styles.warn}>{err}</Text> : null}
    </View>
  );
}

const styles = themed((colors) => ({
  box: { marginTop: 3, gap: 2 },
  ok: { color: colors.green, fontSize: 11, fontWeight: '600' },
  warn: { color: colors.red, fontSize: 11, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 11 },
  link: { color: colors.accent, fontSize: 11, fontWeight: '700', marginTop: 2 },
  q: { gap: 3, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipTxt: { color: colors.accent, fontSize: 11, fontWeight: '700' },
}));
