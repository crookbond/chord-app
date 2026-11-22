/**
 * AI map view (ADR 0061 → 0068 → 0083 → 0087). Nested treemap; AREA ∝ open
 * decision count. Converted tiles show current-answer facts; tap opens
 * decisions with Current state above the batch, sources last.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import type {
  EmailDecision,
  EmailStateFact,
  EmailStateStatus,
  EmailThreadSummary,
  EmailTile,
  EmailTileFacts,
  EmailTileLevel,
} from '@chord/kernel';

import {
  listEmailThreads,
  listEmailTiles,
  openUserStream,
  type StreamHandle,
} from '@/api';
import {
  batchDecisions,
  categoryUsefulness,
  collectSubtreeIds,
  findTile,
  nonEmptyTiles,
  subtreeDecisionCounts,
} from '@/email-decisions';
import { BatchCard } from '@/email-batch-card';
import { LinkChip } from '@/link-chip';
import { useScreenRefresh } from '@/refresh';
import { useCoalesced } from '@/use-coalesced';
import { colors, themed } from '@/theme';

const PALETTE = ['#378ADD', '#1D9E75', '#D85A30', '#D4537E', '#7F77DD', '#BA7517', '#5F5E5A', '#639922'];

interface Rect {
  tile: EmailTile;
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: { a: number }[], length: number): number {
  const s = row.reduce((p, c) => p + c.a, 0);
  const mx = Math.max(...row.map((r) => r.a));
  const mn = Math.min(...row.map((r) => r.a));
  return Math.max((length * length * mx) / (s * s), (s * s) / (length * length * mn));
}

function usefulness(t: EmailTile): number {
  return categoryUsefulness(t.title);
}

/**
 * ADR 0083 - area follows open decisions. Floor scaled by usefulness so
 * family-first / promotions-last ordering survives a zero-decision day.
 */
/** `null` counts = decisions still in flight; the tile's own magic count stands in. */
function basisFor(tile: EmailTile, counts: Map<string, number> | null): number {
  return counts ? (counts.get(tile.id) ?? 0) : tile.magicCount;
}

function decisionWeights(
  tiles: EmailTile[],
  counts: Map<string, number> | null,
): Map<string, number> {
  const total = tiles.reduce((s, t) => s + basisFor(t, counts), 0);
  const floor = 0.5 + total * 0.05;
  return new Map(
    tiles.map((t) => {
      const u = usefulness(t);
      return [t.id, basisFor(t, counts) * u + floor * u];
    }),
  );
}

function squarify(tiles: EmailTile[], weights: Map<string, number>, W: number, H: number): Rect[] {
  const sorted = tiles
    .map((t) => ({ t, v: Math.max(weights.get(t.id) ?? 0.001, 0.001) }))
    .sort((a, b) => b.v - a.v);
  const total = sorted.reduce((s, o) => s + o.v, 0) || 1;
  const scale = (W * H) / total;
  const areas = sorted.map((o) => ({ tile: o.t, a: o.v * scale }));
  const out: Rect[] = [];
  let rect = { x: 0, y: 0, w: W, h: H };
  let i = 0;
  while (i < areas.length) {
    const length = Math.min(rect.w, rect.h);
    let row = [areas[i]];
    let j = i + 1;
    while (j < areas.length) {
      const withNext = row.concat(areas[j]);
      if (worst(withNext, length) <= worst(row, length)) {
        row = withNext;
        j++;
      } else break;
    }
    const rowArea = row.reduce((p, c) => p + c.a, 0);
    if (rect.w >= rect.h) {
      const cw = rowArea / rect.h;
      let yy = rect.y;
      for (const r of row) {
        const ch = r.a / cw;
        out.push({ tile: r.tile, x: rect.x, y: yy, w: cw, h: ch });
        yy += ch;
      }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const rh = rowArea / rect.w;
      let xx = rect.x;
      for (const r of row) {
        const cwid = r.a / rh;
        out.push({ tile: r.tile, x: xx, y: rect.y, w: cwid, h: rh });
        xx += cwid;
      }
      rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
    }
    i = j;
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function tileColor(tile: EmailTile): string {
  return tile.color || PALETTE[Math.abs(hash(tile.id)) % PALETTE.length];
}

interface SheetTarget {
  id: string;
  title: string;
  color: string;
  count: number;
  mode: 'decisions' | 'sources' | 'unsorted';
}

const REGION_HEADER_H = 24;
const GAP = 3;
const PREVIEW_LINE_H = 16;

/**
 * "today" / "tomorrow" / "Thu 28" — a tile line has no room for a date, and
 * the answer people want from a delivery is how many sleeps, not the calendar.
 */
function arrivalLabel(iso: string, nowMs = Date.now()): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const day = (ms: number) => Math.floor(new Date(ms).setHours(0, 0, 0, 0) / 86_400_000);
  const days = day(at) - day(nowMs);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`;
}

function statusLabel(status: EmailStateStatus): string {
  switch (status) {
    case 'out_for_delivery':
      return 'Out for delivery';
    case 'in_transit':
      return 'In transit';
    case 'check_in':
      return 'Check-in';
    case 'shipped':
      return 'Shipped';
    case 'delayed':
      return 'Delayed';
    case 'boarding':
      return 'Boarding';
    case 'scheduled':
      return 'Scheduled';
    case 'cancelled':
      return 'Cancelled';
  }
}

function money(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One state-board row as a sentence.
 *
 * ADR 0135 - "shipped" was the least useful thing the email contained; when it
 * says when, say when, and the status word is the fallback. Shared by the tile
 * face (which can only hold a string) and the sheet (which adds the link), so
 * the two cannot drift into describing the same row differently.
 */
function stateLine(i: EmailStateFact): string {
  const when = i.etaAt ? arrivalLabel(i.etaAt) : null;
  const flight = i.flight ? `${i.flight.iata}` : null;
  // A flight is named by its number; a parcel by whoever is carrying it.
  const tail = flight ?? i.tracking?.carrier ?? null;
  const lead = when
    ? `${i.flight ? 'lands' : 'arriving'} ${when}`
    : statusLabel(i.status);
  return `${i.title} - ${lead}${tail ? ` · ${tail}` : ''}`;
}

/**
 * A state-board row where there is room to act on it.
 *
 * The URL has been on `tracking` since ADR 0135 and reached no one — the tile
 * face can only hold a string, and nothing else rendered the fact. A row whose
 * airline we cannot name (ADR 0138) has a null url and simply shows its number.
 */
function StateFactRow({ fact }: { fact: EmailStateFact }) {
  const link = fact.flight?.url
    ? { url: fact.flight.url, label: `Track ${fact.flight.iata}`, icon: '✈️' }
    : fact.tracking?.url
      ? { url: fact.tracking.url, label: `Track · ${fact.tracking.carrier}`, icon: '📦' }
      : null;
  return (
    <View style={styles.stateRow}>
      <Text style={styles.stateLine} numberOfLines={2}>
        {stateLine(fact)}
      </Text>
      {link ? <LinkChip url={link.url} label={link.label} icon={link.icon} /> : null}
    </View>
  );
}

function factLines(facts: EmailTileFacts | undefined, max: number): string[] {
  if (!facts || max <= 0) return [];
  if (facts.kind === 'timeline') {
    return facts.items.slice(0, max).map((i) => {
      const when = shortDate(i.at);
      return when ? `${i.title} - ${when}` : i.title;
    });
  }
  if (facts.kind === 'state_board') {
    return facts.items.slice(0, max).map(stateLine);
  }
  return facts.items.slice(0, max).map((i) => {
    const due = i.dueAt ? ` due ${shortDate(i.dueAt)}` : '';
    // A refund is money coming back. Both the sign and the word, because a
    // lone minus is easy to miss in a column of amounts — and reading a credit
    // as something owed is the whole defect this line had.
    if (i.direction === 'credit') return `${i.merchant} −${money(i.amount)} refund`;
    // A receipt (ADR 0160) is neither owed nor coming back — labelled, not
    // signed, or it reads like a third kind of amount nobody asked about.
    if (i.direction === 'paid') return `${i.merchant} ${money(i.amount)} · paid`;
    return `${i.merchant} ${money(i.amount)}${due}`;
  });
}

const FACE_FACT_LINES = 3;

function PreviewLines({ tile, max }: { tile: EmailTile; max: number }) {
  const facts = factLines(tile.facts, Math.min(FACE_FACT_LINES, Math.max(0, max)));
  if (facts.length > 0) {
    return (
      <View style={styles.previews}>
        {facts.map((text, i) => (
          <Text key={`${tile.id}:f:${i}`} style={[styles.previewTxt, styles.previewMagic]} numberOfLines={1}>
            {text}
          </Text>
        ))}
      </View>
    );
  }
  // ADR 0110 - every preview line, not just the pending ones. Filtering to
  // 'magic' meant a tile went BLANK the moment its last suggestion was acted
  // on, which is exactly when a person looks at it to see what happened. The
  // server has already ranked them: suggestions, then unread, then whatever
  // the category most recently holds.
  const items = (tile.preview ?? []).slice(0, Math.max(0, max));
  if (items.length === 0) return null;
  return (
    <View style={styles.previews}>
      {items.map((p) => (
        <Pressable
          key={`${p.threadId}:${p.text}`}
          onPress={() => router.push(`/email/${p.threadId}`)}
          hitSlop={2}
        >
          <Text
            style={[styles.previewTxt, p.kind === 'magic' && styles.previewMagic]}
            numberOfLines={1}
          >
            {p.kind === 'magic' ? `✨ ${p.text}` : p.text}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ChildBox({
  rect,
  counts,
  onPress,
}: {
  rect: Rect;
  counts: Map<string, number> | null;
  onPress: () => void;
}) {
  const { tile, x, y, w, h } = rect;
  const iw = Math.max(0, w - GAP);
  const ih = Math.max(0, h - GAP);
  const big = iw > 64 && ih > 36;
  const previewLines = iw > 120 ? Math.floor((ih - 44) / PREVIEW_LINE_H) : 0;
  const badge = basisFor(tile, counts);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.child, { left: x + GAP / 2, top: y + GAP / 2, width: iw, height: ih }]}
    >
      {big ? (
        <>
          <Text style={styles.childTitle} numberOfLines={2}>
            {tile.icon ? `${tile.icon} ` : ''}
            {tile.title}
          </Text>
          <PreviewLines tile={tile} max={previewLines} />
          <Text style={styles.childCount}>{badge > 0 ? badge : ''}</Text>
        </>
      ) : (
        <Text style={styles.childCount} numberOfLines={1}>
          {tile.icon ?? ''}
          {badge > 0 ? `${tile.icon ? ' ' : ''}${badge}` : ''}
        </Text>
      )}
    </Pressable>
  );
}

function Region({
  rect,
  counts,
  onOpen,
}: {
  rect: Rect;
  counts: Map<string, number> | null;
  onOpen: (t: SheetTarget) => void;
}) {
  const { tile, x, y, w, h } = rect;
  const color = tileColor(tile);
  const iw = Math.max(0, w - GAP * 2);
  const ih = Math.max(0, h - GAP * 2);
  const label = (t: EmailTile, title = t.title) => (t.icon ? `${t.icon} ${title}` : title);
  const badge = basisFor(tile, counts);
  const open = () =>
    onOpen({ id: tile.id, title: label(tile), color, count: tile.count, mode: 'decisions' });
  const kids = tile.children ?? [];
  const nest = kids.length > 0 && iw > 104 && ih > REGION_HEADER_H + 44;
  const kidRects = nest
    ? squarify(kids, decisionWeights(kids, counts), iw - GAP * 2, ih - REGION_HEADER_H - GAP)
    : [];
  return (
    <View
      style={[styles.region, { left: x + GAP, top: y + GAP, width: iw, height: ih, backgroundColor: color }]}
    >
      <Pressable onPress={open} style={styles.regionHead}>
        <Text style={styles.regionTitle} numberOfLines={1}>
          {label(tile)}
        </Text>
        {badge > 0 ? <Text style={styles.regionCount}>{badge}</Text> : null}
      </Pressable>
      {nest ? (
        <View style={styles.regionKids}>
          {kidRects.map((r) => (
            <ChildBox
              key={r.tile.id}
              rect={r}
              counts={counts}
              onPress={() =>
                onOpen({
                  id: r.tile.id,
                  title: `${tile.title} › ${label(r.tile)}`,
                  color,
                  count: r.tile.count,
                  mode: 'decisions',
                })
              }
            />
          ))}
        </View>
      ) : (
        <Pressable onPress={open} style={styles.regionFill}>
          <PreviewLines
            tile={tile}
            max={Math.floor((ih - REGION_HEADER_H - GAP * 2) / PREVIEW_LINE_H)}
          />
        </Pressable>
      )}
    </View>
  );
}

function ThreadRow({ item }: { item: EmailThreadSummary }) {
  return (
    <Pressable style={styles.threadRow} onPress={() => router.push(`/email/${item.id}`)}>
      <Text style={[styles.from, item.isUnread && styles.bold]} numberOfLines={1}>
        {item.fromName ?? item.fromEmail ?? 'Unknown'}
      </Text>
      <Text style={[styles.subject, item.isUnread && styles.bold]} numberOfLines={1}>
        {item.subject || '(no subject)'}
      </Text>
      <Text style={styles.snippet} numberOfLines={1}>
        {item.snippet}
      </Text>
    </Pressable>
  );
}

export function EmailTiles({
  decisions,
  onDecisionsChanged,
}: {
  /** `null` until the first decisions fetch lands (badges hold `magicCount`). */
  decisions: EmailDecision[] | null;
  onDecisionsChanged: () => void;
}) {
  const [level, setLevel] = useState<EmailTileLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [threads, setThreads] = useState<EmailThreadSummary[]>([]);
  const slide = useRef(new Animated.Value(0)).current;
  const sheetRef = useRef<SheetTarget | null>(null);
  sheetRef.current = sheet;

  const counts = useMemo(() => {
    if (!decisions) return null;
    const direct = new Map<string, number>();
    for (const d of decisions) {
      if (!d.categoryId) continue;
      direct.set(d.categoryId, (direct.get(d.categoryId) ?? 0) + 1);
    }
    return level ? subtreeDecisionCounts(level.tiles, direct) : direct;
  }, [decisions, level]);

  const mapSeq = useRef(0);
  const reloadMap = useCallback(() => {
    const seq = ++mapSeq.current;
    listEmailTiles(undefined, { deep: true })
      .then((l) => {
        if (seq === mapSeq.current) setLevel(l);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Only the newest tile's threads may land: tapping one tile then another
  // would otherwise show the first tile's mail under the second's title.
  const sourcesSeq = useRef(0);
  const reloadSources = useCallback((target: SheetTarget) => {
    const seq = ++sourcesSeq.current;
    void listEmailThreads({ mode: 'category', category: target.id })
      .then((list) => {
        if (seq === sourcesSeq.current) setThreads(list);
      })
      .catch(() => {
        if (seq === sourcesSeq.current) setThreads([]);
      });
  }, []);

  useEffect(() => {
    reloadMap();
  }, [reloadMap]);

  const refresh = useCallback(() => {
    reloadMap();
    onDecisionsChanged();
    if (sheetRef.current?.mode === 'sources') reloadSources(sheetRef.current);
  }, [reloadMap, onDecisionsChanged, reloadSources]);

  const { refreshControl } = useScreenRefresh(refresh);

  // A sync tick is a burst of events: one map (and open sheet) refetch for
  // the lot. Decisions are the Email screen's own stream's job - it hears the
  // same events - so this does not ask it for a second copy.
  const eventsSoon = useCoalesced(() => {
    reloadMap();
    if (sheetRef.current?.mode === 'sources') reloadSources(sheetRef.current);
  });

  const sourcesSoon = useCoalesced(() => {
    if (sheetRef.current?.mode === 'sources') reloadSources(sheetRef.current);
  });

  useFocusEffect(
    useCallback(() => {
      let handle: StreamHandle | null = null;
      let cancelled = false;
      void openUserStream({
        onEmailSynced: eventsSoon.trigger,
        onEmailTilesUpdated: eventsSoon.trigger,
        // One per thread a bulk action touched.
        onEmailThreadUpdated: sourcesSoon.trigger,
      })
        .then((h) => {
          if (cancelled) h.close();
          else handle = h;
        })
        // The screen works without live updates; a failed open must not be an
        // unhandled rejection.
        .catch((e) => console.warn('[email-tiles] live updates unavailable', e));
      return () => {
        cancelled = true;
        handle?.close();
        eventsSoon.cancel();
        sourcesSoon.cancel();
      };
    }, [eventsSoon, sourcesSoon]),
  );

  const openSheet = useCallback(
    (target: SheetTarget) => {
      setSheet(target);
      setThreads([]);
      if (target.mode === 'sources') reloadSources(target);
      Animated.timing(slide, { toValue: 1, duration: 240, useNativeDriver: true }).start();
    },
    [reloadSources, slide],
  );

  const closeSheet = useCallback(() => {
    Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setSheet(null);
      reloadMap();
      onDecisionsChanged();
    });
  }, [slide, reloadMap, onDecisionsChanged]);

  const sheetHRef = useRef(400);
  const closeRef = useRef(closeSheet);
  closeRef.current = closeSheet;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && sheetRef.current) closeRef.current();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []),
  );

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_e, g) => {
        slide.setValue(Math.min(1, Math.max(0, 1 - g.dy / sheetHRef.current)));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > sheetHRef.current * 0.25 || g.vy > 0.8) closeRef.current();
        else Animated.timing(slide, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => {
        Animated.timing(slide, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ w: width, h: height });
  }, []);

  // No reason to spend map space on a category holding no mail at all —
  // pruned recursively, so an empty child never shows as a ChildBox either.
  const visibleTiles = useMemo(() => (level ? nonEmptyTiles(level.tiles) : []), [level]);
  const rects = size ? squarify(visibleTiles, decisionWeights(visibleTiles, counts), size.w, size.h) : [];
  const sheetH = size ? Math.round(size.h * 0.72) : 400;
  sheetHRef.current = sheetH;

  const sheetDecisions = useMemo(() => {
    if (!sheet || !level || !decisions) return [];
    if (sheet.mode === 'unsorted') {
      return decisions.filter((d) => !d.categoryId || d.archivedSource);
    }
    const tile = findTile(level.tiles, sheet.id);
    if (!tile) return decisions.filter((d) => d.categoryId === sheet.id);
    const ids = collectSubtreeIds(tile);
    return decisions.filter((d) => d.categoryId && ids.has(d.categoryId));
  }, [sheet, level, decisions]);

  const batches = useMemo(() => batchDecisions(sheetDecisions), [sheetDecisions]);
  const unsortedCount = (decisions ?? []).filter((d) => !d.categoryId || d.archivedSource).length;
  const sheetTile =
    sheet && level && sheet.mode !== 'unsorted' ? findTile(level.tiles, sheet.id) : null;
  const sheetFactLines = factLines(sheetTile?.facts, 8);
  // The sheet has room for a tap target; the tile face does not. Both describe
  // a row through `stateLine`, so only the link is new here.
  const sheetStateFacts: EmailStateFact[] =
    sheetTile?.facts?.kind === 'state_board' ? sheetTile.facts.items.slice(0, 8) : [];

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {loading && !level ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : rects.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No classified mail yet. Chord tiles your inbox as it syncs.</Text>
        </View>
      ) : (
        rects.map((r) => <Region key={r.tile.id} rect={r} counts={counts} onOpen={openSheet} />)
      )}

      {unsortedCount > 0 ? (
        <Pressable
          style={styles.unsortedChip}
          onPress={() =>
            openSheet({
              id: '__unsorted__',
              title: 'Unsorted',
              color: '#5F5E5A',
              count: unsortedCount,
              mode: 'unsorted',
            })
          }
        >
          <Text style={styles.unsortedTxt}>
            Unsorted · {unsortedCount} open decision{unsortedCount === 1 ? '' : 's'}
          </Text>
        </Pressable>
      ) : null}

      {sheet ? (
        <>
          <Animated.View style={[styles.scrim, { opacity: slide }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
          </Animated.View>
          <Animated.View
            style={[
              styles.sheet,
              {
                height: sheetH,
                transform: [
                  {
                    translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH, 0] }),
                  },
                ],
              },
            ]}
          >
            <View {...pan.panHandlers}>
              <View style={styles.grab} />
              <View style={styles.sheetHead}>
                <View style={styles.sheetCat}>
                  <View style={[styles.swatch, { backgroundColor: sheet.color }]} />
                  <Text style={styles.sheetTitle} numberOfLines={1}>
                    {sheet.title}
                  </Text>
                  {sheet.mode === 'decisions' || sheet.mode === 'unsorted' ? (
                    sheetDecisions.length > 0 ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeTxt}>{sheetDecisions.length}</Text>
                      </View>
                    ) : null
                  ) : (
                    <Text style={styles.sheetCount}>{sheet.count}</Text>
                  )}
                </View>
                <Pressable onPress={closeSheet} hitSlop={8} style={styles.sheetClose}>
                  <Text style={styles.sheetCloseTxt}>✕</Text>
                </Pressable>
              </View>
            </View>

            {sheet.mode === 'sources' ? (
              <FlatList
                data={threads}
                keyExtractor={(t) => t.id}
                refreshControl={refreshControl}
                renderItem={({ item }) => <ThreadRow item={item} />}
                ListEmptyComponent={<Text style={styles.emptyRows}>No mail in this tile.</Text>}
              />
            ) : (
              <ScrollView contentContainerStyle={styles.sheetBody}>
                {sheetFactLines.length > 0 ? (
                  <View style={styles.stateBlock}>
                    <Text style={styles.stateLbl}>Current state</Text>
                    {sheetStateFacts.length > 0
                      ? sheetStateFacts.map((f, i) => <StateFactRow key={`st:${i}`} fact={f} />)
                      : sheetFactLines.map((line, i) => (
                          <Text key={`st:${i}`} style={styles.stateLine} numberOfLines={2}>
                            {line}
                          </Text>
                        ))}
                  </View>
                ) : null}
                {batches.length === 0 ? (
                  <Text style={styles.emptyRows}>Nothing owed in this tile.</Text>
                ) : (
                  batches.map((b) => (
                    <BatchCard key={b.key} batch={b} onChanged={onDecisionsChanged} />
                  ))
                )}
                {sheet.mode === 'decisions' ? (
                  <Pressable
                    style={styles.sources}
                    onPress={() =>
                      openSheet({
                        ...sheet,
                        mode: 'sources',
                      })
                    }
                  >
                    <Text style={styles.sourcesTxt}>
                      {sheet.count} email{sheet.count === 1 ? '' : 's'} · sources
                    </Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            )}
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

const styles = themed((colors) => ({
  wrap: { flex: 1, position: 'relative', margin: 6 },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  empty: { color: colors.muted, fontSize: 14, textAlign: 'center' },

  region: { position: 'absolute', borderRadius: 11, overflow: 'hidden' },
  regionHead: {
    height: REGION_HEADER_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  regionTitle: { color: '#fff', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  regionCount: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '700', marginLeft: 6 },
  regionKids: { flex: 1, position: 'relative', marginHorizontal: GAP, marginBottom: GAP },
  regionFill: { flex: 1, paddingHorizontal: 8, paddingBottom: 6 },
  child: {
    position: 'absolute',
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    padding: 5,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  childTitle: { color: '#fff', fontSize: 11, fontWeight: '600', lineHeight: 14 },
  childCount: { color: '#fff', fontSize: 14, fontWeight: '800' },
  previews: { flexShrink: 1, gap: 2, marginTop: 2, paddingHorizontal: 2 },
  previewTxt: { color: 'rgba(255,255,255,0.85)', fontSize: 11, lineHeight: PREVIEW_LINE_H - 2 },
  previewMagic: { color: '#fff', fontWeight: '700' },

  unsortedChip: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  unsortedTxt: { color: colors.text, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(26,26,24,0.35)' },
  sheet: {
    position: 'absolute',
    left: -6,
    right: -6,
    bottom: -6,
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -6 },
    elevation: 12,
  },
  grab: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: 8,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetCat: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  sheetTitle: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  sheetCount: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 9,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  sheetClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCloseTxt: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  sheetBody: { padding: 12, gap: 10, paddingBottom: 28 },
  stateBlock: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  stateLbl: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  stateRow: { gap: 4 },
  stateLine: { color: colors.text, fontSize: 13, fontWeight: '500' },
  emptyRows: { color: colors.muted, fontSize: 14, textAlign: 'center', padding: 24 },

  sources: { paddingVertical: 10 },
  sourcesTxt: { color: colors.muted, fontSize: 12, textAlign: 'center' },

  threadRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  from: { color: colors.text, fontSize: 14, fontWeight: '500' },
  subject: { color: colors.text, fontSize: 14, marginTop: 1 },
  snippet: { color: colors.muted, fontSize: 13, marginTop: 1 },
  bold: { fontWeight: '700' },
}));
