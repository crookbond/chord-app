import { Pressable, Text, View } from 'react-native';

import type { ProposalCalendarChoice } from '@chord/kernel';

import { themed } from '@/theme';

/**
 * ADR 0312 — where an email event will go. A mailbox with its own calendar
 * names it; one without (Yahoo/IMAP, a second Gmail) asks, and nothing is
 * picked for the user.
 */
export function CalendarChoice({
  choice,
  selected,
  onChange,
}: {
  choice: ProposalCalendarChoice;
  selected: string | null;
  onChange: (calendarId: string) => void;
}) {
  if (choice.kind === 'auto') {
    return <Text style={st.auto}>📅 Goes on {choice.label}</Text>;
  }
  if (choice.options.length === 0) {
    return <Text style={st.ask}>📅 No calendar Chord can write to. Connect one in Settings.</Text>;
  }
  return (
    <View>
      <Text style={st.ask}>📅 This mailbox has no calendar here. Which calendar?</Text>
      <View style={st.chipRow}>
        {choice.options.map((o) => {
          const on = selected === o.calendarId;
          return (
            <Pressable
              key={o.calendarId}
              onPress={() => onChange(o.calendarId)}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[st.chip, on && st.chipActive]} numberOfLines={1}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The ✓ cannot place an event until a calendar is picked. */
export function needsCalendarPick(choice: ProposalCalendarChoice | undefined, selected: string | null): boolean {
  return choice?.kind === 'ask' && !selected;
}

const st = themed((colors) => ({
  auto: { fontSize: 11, color: colors.muted, marginTop: 4 },
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
    maxWidth: 180,
  },
  chipActive: { color: colors.onAccent, backgroundColor: colors.accent, borderColor: colors.accent },
}));
