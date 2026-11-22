import { Text, View } from 'react-native';
import { themed } from '@/theme';
import type { EmailAction } from '@chord/kernel';

/**
 * ADR 0086's action axis, shared between the Email tab's own rows and the
 * bot's search-result email cards (mobile/app/groups/[id]/index.tsx) so the
 * two surfaces can't drift into two different colors/labels for the same
 * action.
 */
export const ACTION_BADGE: Record<
  EmailAction,
  { label: string; tint: string; fill: string } | null
> = {
  // Solid fill + white text: a pale chip on the Email tab's off-white rows
  // was barely visible (both pass 4.5:1 contrast with white text).
  to_do: { label: 'To do', tint: '#FFFFFF', fill: '#B4471F' },
  reply_needed: { label: 'Reply', tint: '#FFFFFF', fill: '#A3285A' },
  // The two that ask nothing of the user carry no badge - a marker on every
  // row is just noise, and the point of the axis is to make the few rows that
  // want something stand out.
  informational: null,
  other: null,
};

/** ADR 0278 — one color per action, for the badge and the filter chips. */
export const ACTION_COLOR: Record<EmailAction, string> = {
  to_do: '#B4471F',
  reply_needed: '#A3285A',
  informational: '#3E6C8F',
  other: '#7A7970',
};

export function ActionBadge({ action }: { action: EmailAction | null }) {
  const badge = action ? ACTION_BADGE[action] : null;
  if (!badge) return null;
  return (
    <View style={[styles.badge, { backgroundColor: badge.fill }]}>
      <Text style={[styles.badgeTxt, { color: badge.tint }]}>{badge.label}</Text>
    </View>
  );
}

const styles = themed(() => ({
  // One fixed box for every label, so a column of them reads as a column.
  badge: {
    width: 52,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTxt: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
}));
