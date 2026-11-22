/**
 * Shown by Sections and Feed when there is nothing pending to decide (ADR
 * 0110, extended beyond Map - see `use-email-recents.ts`). Replaces a bare
 * "nothing needs you" screen, which read as an empty mailbox even on a day
 * with plenty of handled/read mail, with the same per-category recent lines
 * Map already falls back to.
 */
import { useCallback, useMemo, useRef } from 'react';
import { Pressable, Text, View, type ScrollView } from 'react-native';
import { emailHeadingStyle } from '@chord/kernel';

import { openFromCategory } from '@/email-category-open';
import { CategoryGroupList } from '@/email-category-groups';
import { UnreadBadge } from '@/email-unread-badge';
import { DragScrollView } from '@/reorderable-list';
import type { CategoryRecent } from '@/email-decisions';
import type { EmailRecents } from '@/use-email-recents';
import { activeColorScheme, themed } from '@/theme';
import { useScrollTopOnReselect } from '@/tab-reselect';

const titleOf = (r: CategoryRecent) => r.title;
const unreadOf = (r: CategoryRecent) => r.unread;
const activeOf = (r: CategoryRecent) => r.unread > 0;

export function EmailRecentFallback({
  recents,
  parentOf,
}: {
  recents: CategoryRecent[];
  parentOf: EmailRecents['parentOf'];
}) {
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('email', scrollRef);
  if (recents.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Nothing needs you right now.</Text>
      </View>
    );
  }
  return (
    <DragScrollView ref={scrollRef} style={styles.wrap} contentContainerStyle={styles.list}>
      <EmailRecentList
        recents={recents}
        parentOf={parentOf}
        heading="Nothing needs you right now · recent mail"
      />
    </DragScrollView>
  );
}

/** The per-category recent lines on their own, for a parent that scrolls. */
export function EmailRecentList({
  recents,
  parentOf,
  heading,
}: {
  recents: CategoryRecent[];
  parentOf: EmailRecents['parentOf'];
  heading: string;
}) {
  // Categories holding unread mail first, then whichever got mail last; the
  // grouping under parents and the user's own order (ADR 0266, 0292) are
  // applied by CategoryGroupList, unread still first in each.
  const sorted = useMemo(
    () =>
      [...recents].sort(
        (a, b) =>
          b.unread - a.unread || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
      ),
    [recents],
  );
  const parentOfRecent = useCallback((r: CategoryRecent) => parentOf(r.id, r.title), [parentOf]);
  if (recents.length === 0) return null;
  return (
    <>
      <Text style={styles.heading}>{heading}</Text>
      <CategoryGroupList
        items={sorted}
        titleOf={titleOf}
        parentOf={parentOfRecent}
        unreadOf={unreadOf}
        activeOf={activeOf}
        renderItem={(r) => {
        const look = emailHeadingStyle(r.title, activeColorScheme());
        return (
        <View style={[styles.card, { borderLeftColor: look.fg }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: look.fg }]} numberOfLines={1}>
              {look.emoji} {r.title}
            </Text>
            <UnreadBadge count={r.unread} />
          </View>
          {r.preview.map((p) => (
            <Pressable key={`${p.threadId}:${p.text}`} onPress={() => openFromCategory([r.id], p.threadId)}>
              <Text style={[styles.line, p.kind === 'unread' && styles.lineUnread]} numberOfLines={1}>
                {p.text}
              </Text>
              {p.snippet ? (
                <Text style={styles.snippet} numberOfLines={2}>
                  {p.snippet}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
        );
        }}
      />
    </>
  );
}

const styles = themed((colors) => ({
  wrap: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  empty: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  list: { padding: 10, gap: 8 },
  heading: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: 11,
    padding: 11,
    gap: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  line: { color: colors.muted, fontSize: 13, marginTop: 2 },
  lineUnread: { color: colors.text, fontWeight: '600' },
  snippet: { color: colors.muted, fontSize: 12, lineHeight: 16 },
}));
