/**
 * The AI feed (ADR 0146): every open email decision, ranked by urgency
 * instead of grouped into a category treemap. Dated decisions stay a flat
 * earliest-first list; once nothing is due, the remainder defaults to
 * Sections' own To-dos/Events/Lists grouping (`feedRows`) rather than a flat
 * list ranked by category alone. Replaces `EmailTiles` as the "AI" tab's main
 * view — same props, so the swap at the call site is a one-line change.
 */
import { useMemo, useRef } from 'react';
import { ActivityIndicator, View, type ScrollView } from 'react-native';
import type { EmailDecision } from '@chord/kernel';

import { BatchCard } from '@/email-batch-card';
import { feedRows } from '@/email-decisions';
import { EmailRecentFallback, EmailRecentList } from '@/email-recent-fallback';
import { KindGroupList } from '@/email-kind-groups';
import { DragScrollView } from '@/reorderable-list';
import { useEmailRecents } from '@/use-email-recents';
import { useScreenRefresh } from '@/refresh';
import { useScrollTopOnReselect } from '@/tab-reselect';
import { colors, themed } from '@/theme';

export function EmailFeed({
  decisions,
  onDecisionsChanged,
}: {
  /** `null` until the first decisions fetch lands. */
  decisions: EmailDecision[] | null;
  onDecisionsChanged: () => void;
}) {
  const { dated, undatedGroups } = useMemo(
    () => (decisions ? feedRows(decisions) : { dated: [], undatedGroups: [] }),
    [decisions],
  );
  const { recents, loaded, parentOf } = useEmailRecents();
  const { refreshControl } = useScreenRefresh(onDecisionsChanged);
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('email', scrollRef);

  // Nothing to decide AND the recent mail not here yet: a spinner, not a
  // "nothing needs you" that the next second contradicts.
  if (decisions === null || (!loaded && dated.length === 0 && undatedGroups.length === 0)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // ADR 0110, extended beyond Map (use-email-recents.ts): an empty feed does
  // not mean an empty mailbox - fall back to recent mail per category.
  if (dated.length === 0 && undatedGroups.length === 0) {
    return <EmailRecentFallback recents={recents} parentOf={parentOf} />;
  }

  return (
    <DragScrollView
      ref={scrollRef}
      style={styles.wrap}
      contentContainerStyle={styles.list}
      refreshControl={refreshControl}
    >
      {dated.map((u) => (
        <BatchCard key={u.key} batch={u} onChanged={onDecisionsChanged} />
      ))}
      <KindGroupList groups={undatedGroups} onChanged={onDecisionsChanged} />
      {/* The mail itself stays under the to-dos: a feed that shows only what
          Chord pulled out reads as if the rest of the inbox were empty. */}
      <EmailRecentList recents={recents} parentOf={parentOf} heading="Recent mail" />
    </DragScrollView>
  );
}

const styles = themed(() => ({
  wrap: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  list: { padding: 10, gap: 8 },
}));
