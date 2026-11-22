import { Pressable, Text } from 'react-native';

import { themed } from '@/theme';

/**
 * ADR 0348 — an email meeting card adds the meeting to the user's calendar
 * and invites nobody. Sending invitations is this box, unticked every time,
 * so emailing the people on the thread is something the user chose.
 */
export function InviteChoice({
  invitees,
  checked,
  onChange,
  disabled,
}: {
  invitees: string[];
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  if (invitees.length === 0) return null;
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      hitSlop={6}
      style={({ pressed }) => [st.row, pressed && { opacity: 0.6 }]}
    >
      <Text style={[st.box, checked && st.boxOn]}>{checked ? '✓' : ' '}</Text>
      <Text style={st.label} numberOfLines={3}>
        Also send invitations to {invitees.join(', ')}
      </Text>
    </Pressable>
  );
}

const st = themed((colors) => ({
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginTop: 4 },
  box: {
    width: 16,
    height: 16,
    lineHeight: 14,
    textAlign: 'center' as const,
    fontSize: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    color: colors.onAccent,
    overflow: 'hidden' as const,
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { flex: 1, fontSize: 11, color: colors.text },
}));
