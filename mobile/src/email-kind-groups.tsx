/**
 * Shared "grouped by kind" rendering (To-dos / Events / Lists) - Sections'
 * own body, and the Feed's undated tail once it started defaulting to the
 * same grouping once nothing is due. One shape, so a change to how a group
 * header or body renders can't drift between the two views.
 */
import { Text, View } from 'react-native';
import { emailHeadingStyle } from '@chord/kernel';

import { BatchCard } from '@/email-batch-card';
import type { KindGroup } from '@/email-decisions';
import { activeColorScheme, themed } from '@/theme';

export function KindGroupList({
  groups,
  onChanged,
}: {
  groups: KindGroup[];
  onChanged: () => void;
}) {
  return (
    <>
      {groups.map((g) => {
        const look = emailHeadingStyle(g.label, activeColorScheme());
        return (
        <View key={g.kind} style={styles.section}>
          <View style={[styles.head, { backgroundColor: look.bg }]}>
            <Text style={[styles.title, { color: look.fg }]}>
              {look.emoji} {g.label}
            </Text>
            <View style={[styles.countPill, { backgroundColor: look.fg }]}>
              <Text style={styles.count}>{g.units.reduce((n, u) => n + u.items.length, 0)}</Text>
            </View>
          </View>
          <View style={styles.body}>
            {g.units.map((u) => (
              <BatchCard key={u.key} batch={u} onChanged={onChanged} />
            ))}
          </View>
        </View>
        );
      })}
    </>
  );
}

const styles = themed((colors) => ({
  section: { gap: 8 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  countPill: {
    borderRadius: 9,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  count: { color: colors.onAccent, fontSize: 11, fontWeight: '700' },
  body: { gap: 8 },
}));
