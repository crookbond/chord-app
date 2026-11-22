/**
 * ADR 0320 — the mail list beside the reader on a wide screen, with a
 * draggable divider. It wraps the whole thread screen, composer included:
 * keeping the list in view while a reply is written is the point, and the
 * composer is a layout of that same screen (ADR 0222).
 *
 * The rows come from the nav store, where the Traditional list already
 * publishes its order and its own `loadMore` (ADR 0119) — so the pane shows
 * the list the user was looking at, with its filters and its mailbox, and
 * fetches nothing. An order published with no rows (a category walk out of
 * the AI view, which has no list) is the one case it loads a page itself,
 * rather than drawing an empty column.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  DIVIDER_WIDTH,
  draggedPaneWidth,
  splitFits,
  storedPaneWidth,
  type EmailThreadSummary,
} from '@chord/kernel';

import { listEmailThreads } from '@/api';
import { useEmailThreadNav } from '@/email-thread-nav';
import { colors, themed } from '@/theme';

const WIDTH_KEY = 'email.listPaneWidth';

function rowTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function PaneRow({
  item,
  open,
  onOpen,
}: {
  item: EmailThreadSummary;
  open: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Pressable
      style={[styles.row, open && styles.rowOpen]}
      onPress={() => onOpen(item.id)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.subject || '(no subject)'}`}
    >
      <View style={styles.rowTop}>
        <Text style={[styles.from, item.isUnread && styles.unread]} numberOfLines={1}>
          {item.fromName || item.fromEmail || 'Unknown'}
        </Text>
        <Text style={styles.time}>{rowTime(item.lastMessageAt)}</Text>
      </View>
      <View style={styles.rowTop}>
        <Text style={[styles.subject, item.isUnread && styles.unread]} numberOfLines={1}>
          {item.subject || '(no subject)'}
        </Text>
        {item.isUnread ? <View style={styles.dot} /> : null}
      </View>
      <Text style={styles.snippet} numberOfLines={1}>
        {item.snippet ?? ''}
      </Text>
    </Pressable>
  );
}

/** The list column. Tapping a row swaps the thread rather than stacking one. */
function ListPane({ openId, width }: { openId: string | null; width: number }) {
  const rows = useEmailThreadNav((s) => s.rows);
  const ids = useEmailThreadNav((s) => s.ids);
  const hasMore = useEmailThreadNav((s) => s.hasMore);
  const loadMore = useEmailThreadNav((s) => s.loadMore);
  const [own, setOwn] = useState<EmailThreadSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  // No rows with the order: fetch one inbox page so the column is never empty,
  // and publish it as the walk — a row tapped here is the list the reader now
  // moves through, which is what keeps prev/next coherent (ADR 0264).
  useEffect(() => {
    if (rows.length > 0 || own) return;
    let live = true;
    void listEmailThreads({ mode: 'traditional', folder: 'inbox' })
      .then((page) => {
        if (!live) return;
        setOwn(page);
        useEmailThreadNav
          .getState()
          .setNav(
            page.map((t) => t.id),
            false,
            null,
            'list',
            page.filter((t) => !t.isUnread).map((t) => t.id),
            page,
          );
      })
      .catch(() => {
        /* the reader still works; the column simply stays empty */
      });
    return () => {
      live = false;
    };
  }, [rows.length, own]);

  // One rule for what is on screen: the store filters `ids` as removals start
  // and land (ADR 0286/0218), so the pane follows that set rather than keeping
  // a second copy of the same filter.
  const removing = useEmailThreadNav((s) => s.removing);
  const removedAt = useEmailThreadNav((s) => s.removedAt);
  const live = rows.length > 0 ? rows : (own ?? []);
  const kept = new Set(ids);
  // Putting the last one away empties `ids`; that must not show them all again.
  const shown = live.filter((r) =>
    ids.length > 0 ? kept.has(r.id) : !removing.has(r.id) && !removedAt.has(r.id),
  );

  const more = useCallback(async () => {
    if (!loadMore || busy) return;
    setBusy(true);
    try {
      await loadMore();
    } finally {
      setBusy(false);
    }
  }, [loadMore, busy]);

  return (
    <View style={[styles.pane, { width }]}>
      <ScrollView contentContainerStyle={styles.paneInner}>
        {shown.map((item) => (
          <PaneRow
            key={item.id}
            item={item}
            open={item.id === openId}
            // Swap the open email rather than stacking another screen: Back
            // still returns to the list, not through every email read here.
            onOpen={(id) => router.replace(`/email/${id}`)}
          />
        ))}
        {shown.length === 0 ? <Text style={styles.empty}>No emails in this list</Text> : null}
        {hasMore && loadMore ? (
          <Pressable style={styles.more} onPress={() => void more()} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.moreTxt}>Load more</Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Two panes with a draggable divider between them: `left` at the stored width,
 * `children` taking the rest. Below `SPLIT_MIN_WINDOW` — every phone, a narrow
 * browser — or with `enabled` false, it renders its children and nothing else,
 * so the single-column screen is exactly what it was.
 *
 * One frame for both mail layouts (the list screen's reading pane and the
 * reader opened by link), because the width, its bounds and where it is stored
 * are the same question on both.
 */
export function SplitFrame({
  left,
  enabled = true,
  narrow = 'children',
  children,
}: {
  /** The left pane, given the width to draw in - `null` = the whole screen. */
  left: (width: number | null) => ReactNode;
  enabled?: boolean;
  /**
   * Which half IS the screen when there is no room to split. The reader
   * opened by link keeps the reader (`children`); the list screen keeps its
   * list (`left`) - with the wrong one here a phone shows the empty half.
   */
  narrow?: 'children' | 'left';
  children: ReactNode;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const fits = enabled && splitFits(windowWidth);
  const [width, setWidth] = useState<number | null>(null);
  const dragFrom = useRef(0);
  const latest = useRef(0);

  useEffect(() => {
    void AsyncStorage.getItem(WIDTH_KEY)
      .then((v) => setWidth(storedPaneWidth(windowWidth, v === null ? null : Number(v))))
      .catch(() => setWidth(storedPaneWidth(windowWidth, null)));
    // Read once per mount. A later resize is re-clamped below rather than
    // re-read, so a stored width is never applied to the wrong window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A resized browser or a rotated tablet: the stored width may no longer
  // leave the reader its minimum, and the pane is what gives way.
  const paneWidth = width === null ? null : storedPaneWidth(windowWidth, width);
  latest.current = paneWidth ?? 0;

  // Memoized, and deliberately so: `Gesture.Pan()` returns a new object every
  // call, and a drag that updates state every frame would otherwise rebuild
  // the recognizer mid-drag and cancel itself (the trap recorded on the Trips
  // tab's drag). `runOnJS` because the clamp is an ordinary kernel function,
  // not a worklet — and a divider does not need the UI thread.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onBegin(() => {
          dragFrom.current = latest.current;
        })
        .onUpdate((e) => {
          // Into the ref first: React batches the state updates a drag makes,
          // so `onEnd` can run before any of them has rendered and would
          // otherwise store the width the drag STARTED at.
          latest.current = draggedPaneWidth(windowWidth, dragFrom.current, e.translationX);
          setWidth(latest.current);
        })
        .onEnd(() => {
          void AsyncStorage.setItem(WIDTH_KEY, String(latest.current)).catch(() => {});
        }),
    [windowWidth],
  );

  if (!fits || paneWidth === null) {
    return <>{narrow === 'left' ? left(null) : children}</>;
  }

  return (
    <View style={styles.split}>
      {left(paneWidth)}
      <GestureDetector gesture={pan}>
        <View style={styles.divider} accessibilityLabel="Drag to resize the email list">
          <View style={styles.dividerGrip} />
        </View>
      </GestureDetector>
      <View style={styles.reader}>{children}</View>
    </View>
  );
}

/**
 * The reader opened by link (`/email/<id>`), with the mail list beside it.
 * The list screen has its own real list to put in the left pane and uses
 * `SplitFrame` directly.
 */
export function EmailSplit({ openId, children }: { openId: string | null; children: ReactNode }) {
  return (
    <SplitFrame left={(width) => <ListPane openId={openId} width={width ?? 0} />}>
      {children}
    </SplitFrame>
  );
}

/** The right pane before an email is picked. */
export function ReadingPanePlaceholder() {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.empty}>Select an email to read it here</Text>
    </View>
  );
}

/**
 * A composer's or reader's header drawn INSIDE the pane: the route header
 * belongs to the screen the pane sits in, and two `Stack.Screen` option sets
 * in one route fight over it.
 */
export function PaneHeader({
  title,
  left,
  right,
}: {
  title?: string;
  left?: () => ReactNode;
  right?: () => ReactNode;
}) {
  return (
    <View style={styles.paneHeader}>
      {left ? left() : null}
      <Text style={styles.paneHeaderTitle} numberOfLines={1}>
        {title ?? ''}
      </Text>
      <View style={styles.paneHeaderSpacer} />
      {right ? right() : null}
    </View>
  );
}

const styles = themed((colors) => ({
  split: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
  pane: { borderRightWidth: 1, borderRightColor: colors.border },
  paneInner: { paddingVertical: 4 },
  reader: { flex: 1 },
  divider: {
    width: DIVIDER_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    // Web-only, and ignored elsewhere: the strip has to look draggable.
    // React Native's own `cursor` type knows auto/pointer only.
    ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as unknown as ViewStyle) : null),
  },
  dividerGrip: { width: 2, height: 36, borderRadius: 1, backgroundColor: colors.border },
  row: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 2,
  },
  rowOpen: { backgroundColor: colors.card },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  from: { flex: 1, color: colors.text, fontSize: 13 },
  subject: { flex: 1, color: colors.text, fontSize: 13 },
  unread: { fontWeight: '700' },
  time: { color: colors.muted, fontSize: 11 },
  snippet: { color: colors.muted, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  empty: { color: colors.muted, fontSize: 13, padding: 12 },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    height: 44,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  paneHeaderTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  paneHeaderSpacer: { flex: 1 },
  more: { padding: 12, alignItems: 'center' },
  moreTxt: { color: colors.accent, fontSize: 13 },
}));
