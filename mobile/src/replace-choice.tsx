import { Pressable, Text, View } from 'react-native';

import type { ProposalReplaceOffer } from '@chord/kernel';

import { themed } from '@/theme';

export type ReplacePick = 'move' | 'new' | null;

function when(startsAt: string): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return startsAt;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * ADR 0343 — a booking from the same place for the same subject may be the
 * old one moved. The card asks; nothing is picked for the user, and ✓ waits.
 */
export function ReplaceChoice({
  offer,
  picked,
  onChange,
}: {
  offer: ProposalReplaceOffer;
  picked: ReplacePick;
  onChange: (pick: Exclude<ReplacePick, null>) => void;
}) {
  return (
    <View>
      <Text style={st.ask}>
        ↻ Replaces {offer.title}, {when(offer.startsAt)}?
      </Text>
      <View style={st.chipRow}>
        {(
          [
            ['move', 'Move it'],
            ['new', 'Add as new'],
          ] as const
        ).map(([value, label]) => {
          const on = picked === value;
          return (
            <Pressable
              key={value}
              onPress={() => onChange(value)}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[st.chip, on && st.chipActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The ✓ cannot add or move until the user says which. */
export function needsReplacePick(offer: ProposalReplaceOffer | undefined, picked: ReplacePick): boolean {
  return !!offer && picked === null;
}

/** The event to move on confirm, when the user picked Move it. */
export function replaceEventIdFor(offer: ProposalReplaceOffer | undefined, picked: ReplacePick): string | undefined {
  return offer && picked === 'move' ? offer.eventId : undefined;
}

const st = themed((colors) => ({
  ask: { fontSize: 11, color: colors.text, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  chip: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipActive: { color: colors.onAccent, backgroundColor: colors.accent, borderColor: colors.accent },
}));
