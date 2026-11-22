/**
 * ADR 0292 — category cards grouped under their top-level parent, for Feed's
 * recent mail and for Cards. A header per group (tap to fold), the
 * subcategories that need the user, and a "+ N more" row for the rest. Press
 * and hold a header to move its whole group, or a card to move it inside its
 * group; the order is saved through the same pins as ADR 0266.
 */
import { useMemo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  emailHeadingStyle,
  foldRows,
  groupCategories,
  pinnedAfterRowMove,
  setShowAll,
  toggleFold,
  type FoldRow,
} from '@chord/kernel';

import { useCategoryFold } from '@/email-category-fold';
import { useEmailCategoryOrder } from '@/email-category-order';
import { UnreadBadge } from '@/email-unread-badge';
import { ReorderableList } from '@/reorderable-list';
import { activeColorScheme, themed } from '@/theme';

/** `MAX_PINNED_CATEGORIES` on the server. */
const MAX_PINS = 40;

export function CategoryGroupList<T>({
  items,
  titleOf,
  parentOf,
  unreadOf,
  activeOf,
  renderItem,
}: {
  /** In the view's own default order. */
  items: T[];
  titleOf: (item: T) => string;
  parentOf: (item: T) => string | null;
  unreadOf: (item: T) => number;
  /** Shown even when its group is folded down to what needs the user. */
  activeOf: (item: T) => boolean;
  renderItem: (item: T) => ReactNode;
}) {
  const { pinned, setPinned } = useEmailCategoryOrder();
  const [fold, setFold] = useCategoryFold();
  const groups = useMemo(
    () => groupCategories(items, { titleOf, parentOf, unreadOf, pinned }),
    [items, titleOf, parentOf, unreadOf, pinned],
  );
  const rows = useMemo(() => foldRows(groups, activeOf, fold), [groups, activeOf, fold]);

  const keyOf = (r: FoldRow<T>): string => {
    switch (r.kind) {
      case 'head':
        return `h:${r.key}`;
      case 'more':
        return `m:${r.key}`;
      case 'fewer':
        return `f:${r.key}`;
      default:
        return `i:${groups[r.group].key}:${titleOf(r.item)}`;
    }
  };

  return (
    <ReorderableList
      items={rows}
      keyOf={keyOf}
      onMove={(from, to) => {
        const next = pinnedAfterRowMove(rows, groups, titleOf, from, to, pinned);
        if (!next) return;
        // The server keeps only names of real categories, at most 40; a
        // group of one with no parent ("Unsorted") is not one.
        const unreal = new Set(
          items.filter((it) => parentOf(it) === null).map((it) => titleOf(it).trim().toLowerCase()),
        );
        setPinned(next.filter((t) => !unreal.has(t.trim().toLowerCase())).slice(0, MAX_PINS));
      }}
      render={(r) => {
        if (r.kind === 'solo') return renderItem(r.item);
        if (r.kind === 'item') return <View style={styles.child}>{renderItem(r.item)}</View>;
        if (r.kind === 'more' || r.kind === 'fewer') {
          return (
            <Pressable style={styles.child} onPress={() => setFold(setShowAll(fold, r.key, r.kind === 'more'))}>
              <Text style={styles.more}>{r.kind === 'more' ? `+ ${r.hidden} more in ${r.key}` : 'Show fewer'}</Text>
            </Pressable>
          );
        }
        const look = emailHeadingStyle(r.key, activeColorScheme());
        return (
          <Pressable
            style={styles.head}
            onPress={() => setFold(toggleFold(fold, rows, r.key))}
            accessibilityRole="button"
            accessibilityState={{ expanded: !r.folded }}
          >
            <View style={styles.titleRow}>
              <Text style={styles.chevron}>{r.folded ? '▸' : '▾'}</Text>
              <Text style={styles.emoji}>{look.emoji}</Text>
              <Text style={[styles.title, { color: look.fg }]} numberOfLines={1}>
                {r.key}
              </Text>
            </View>
            {r.unread > 0 ? (
              <UnreadBadge count={r.unread} />
            ) : (
              <Text style={styles.quiet}>{r.folded ? `${r.size} read` : ''}</Text>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = themed((colors) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 2,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  chevron: { color: colors.muted, fontSize: 13, width: 12 },
  emoji: { fontSize: 15 },
  title: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  quiet: { color: colors.muted, fontSize: 12 },
  child: { marginLeft: 12 },
  more: { color: colors.accent, fontSize: 13, fontWeight: '600', paddingVertical: 4, paddingHorizontal: 4 },
}));
