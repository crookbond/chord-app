/**
 * The "Cards" AI view (ADR 0147): one rounded card per category instead of a
 * flat list, unread categories first and then the most recently mailed. Tapping
 * a card expands it in place — no separate sheet, since the whole point of
 * offering this alongside the feed is to see the difference cheaply. Cards sit
 * under their parent category, folded down to what needs the user (ADR 0292).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, type ScrollView } from 'react-native';
import { categoryKey, emailHeadingStyle, type EmailDecision } from '@chord/kernel';

import { StackedCards } from '@/card-stack';
import { BatchCard } from '@/email-batch-card';
import { openFromCategory } from '@/email-category-open';
import { CategoryGroupList } from '@/email-category-groups';
import { categoryUsefulness, groupByCategory, type CategoryGroup, type CategoryRecent } from '@/email-decisions';
import { UnreadBadge } from '@/email-unread-badge';
import { useEmailRecents } from '@/use-email-recents';
import { DragScrollView } from '@/reorderable-list';
import { useScreenRefresh } from '@/refresh';
import { useScrollTopOnReselect } from '@/tab-reselect';
import { useApp } from '@/store';
import { activeColorScheme, colors, themed } from '@/theme';

/**
 * Which cards are open, kept for this app run per user: opening an email from
 * a card and coming back (or switching views) must find that card still open.
 */
let openCards: { userId: string; titles: Set<string> } | null = null;

interface CardGroup extends CategoryGroup {
  /** ADR 0110, extended beyond Map (use-email-recents.ts): present only for
   *  a category with zero open decisions, so the card still shows what it
   *  holds instead of disappearing the moment it's handled. */
  recent?: CategoryRecent;
  /** Unread mail in this category: what sorts the card and what its badge
   *  says. A category known only from its decisions has none on file. */
  unread: number;
  /** The category id, for finding its parent (ADR 0292). */
  categoryId: string | null;
}

const titleOf = (g: CardGroup) => g.title;
const unreadOf = (g: CardGroup) => g.unread;
const activeOf = (g: CardGroup) => g.unread > 0 || g.count > 0;

export function EmailCards({
  decisions,
  onDecisionsChanged,
}: {
  decisions: EmailDecision[] | null;
  onDecisionsChanged: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('email', scrollRef);
  const { recents, loaded, parentOf } = useEmailRecents();
  const groups = useMemo<CardGroup[]>(() => {
    const byTitle = new Map(recents.map((r) => [categoryKey(r.title), r]));
    const base = decisions ? groupByCategory(decisions) : [];
    const known = new Set(base.map((g) => g.title));
    const cards: CardGroup[] = [
      ...base.map((g) => ({
        ...g,
        unread: byTitle.get(categoryKey(g.title))?.unread ?? 0,
        categoryId: g.units[0]?.items[0]?.categoryId ?? null,
      })),
      ...recents
        .filter((r) => !known.has(r.title))
        .map((r) => ({ title: r.title, count: 0, units: [], recent: r, unread: r.unread, categoryId: r.id })),
    ];
    // Most unread on top; the rest (and ties) by whichever received mail
    // most recently.
    const latestOf = (g: CardGroup) => byTitle.get(categoryKey(g.title))?.lastMessageAt ?? '';
    // Unread first and the user's own order (ADR 0266) are applied per group
    // and per card by CategoryGroupList.
    return cards.sort(
      (a, b) =>
        b.unread - a.unread ||
        latestOf(b).localeCompare(latestOf(a)) ||
        categoryUsefulness(b.title) - categoryUsefulness(a.title),
    );
  }, [decisions, recents]);
  const parentOfCard = useCallback((g: CardGroup) => parentOf(g.categoryId, g.title), [parentOf]);
  const userId = useApp((s) => s.user?.id) ?? '';
  const [expanded, setExpandedState] = useState<Set<string>>(() =>
    openCards && openCards.userId === userId ? openCards.titles : new Set(),
  );
  const setExpanded = useCallback(
    (update: (prev: Set<string>) => Set<string>) =>
      setExpandedState((prev) => {
        const next = update(prev);
        openCards = { userId, titles: next };
        return next;
      }),
    [userId],
  );
  const { refreshControl } = useScreenRefresh(onDecisionsChanged);
  // Categories whose stacked cards the user opened; a stack closes again
  // when the view is left.
  const [unstacked, setUnstacked] = useState<Set<string>>(() => new Set());
  const toggleStack = (title: string) =>
    setUnstacked((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  const toggle = (title: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  if (decisions === null || (!loaded && groups.length === 0)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Nothing needs you right now.</Text>
      </View>
    );
  }

  return (
    <DragScrollView ref={scrollRef} style={styles.wrap} contentContainerStyle={styles.list} refreshControl={refreshControl}>
      {/* Press and hold a card, then drag it: it stays where it is dropped. */}
      <CategoryGroupList
        items={groups}
        titleOf={titleOf}
        parentOf={parentOfCard}
        unreadOf={unreadOf}
        activeOf={activeOf}
        renderItem={(g) => {
        const open = expanded.has(g.title);
        const look = emailHeadingStyle(g.title, activeColorScheme());
        return (
          <View style={[styles.card, { borderLeftColor: look.fg }]}>
            <Pressable style={[styles.head, { backgroundColor: look.bg }]} onPress={() => toggle(g.title)}>
              <View style={styles.titleRow}>
                <Text style={styles.emoji}>{look.emoji}</Text>
                <Text style={[styles.title, { color: look.fg }]} numberOfLines={1}>
                  {g.title}
                </Text>
              </View>
              <View style={styles.badges}>
                <UnreadBadge count={g.unread} />
                {g.count > 0 ? (
                  <View style={[styles.badge, { backgroundColor: look.fg }]}>
                    <Text style={styles.badgeTxt}>{g.count}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
            {open ? (
              <View style={styles.body}>
                {g.units.length > 0 ? (
                  <StackedCards
                    items={g.units}
                    open={unstacked.has(g.title)}
                    onToggle={() => toggleStack(g.title)}
                    render={(u) => <BatchCard key={u.key} batch={u} onChanged={onDecisionsChanged} />}
                  />
                ) : g.recent ? (
                  g.recent.preview.map((p) => (
                    <Pressable
                      key={`${p.threadId}:${p.text}`}
                      onPress={() => openFromCategory([g.recent!.id], p.threadId)}
                    >
                      <Text style={styles.recentTxt} numberOfLines={1}>
                        {p.text}
                      </Text>
                      {p.snippet ? (
                        <Text style={styles.snippet} numberOfLines={2}>
                          {p.snippet}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))
                ) : null}
              </View>
            ) : null}
          </View>
        );
        }}
      />
    </DragScrollView>
  );
}

const styles = themed((colors) => ({
  wrap: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  empty: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  list: { padding: 10, gap: 8 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: 11,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  emoji: { fontSize: 16 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeTxt: { color: colors.onAccent, fontSize: 11, fontWeight: '700' },
  body: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: 10,
    gap: 8,
  },
  recentTxt: { color: colors.text, fontSize: 13, fontWeight: '600' },
  snippet: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 1 },
}));
