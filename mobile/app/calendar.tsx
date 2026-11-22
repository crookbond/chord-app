/**
 * Calendar - list (the default), single-day and multi-day hour grids, and a
 * month grid, picked from one view button in the header, as Apple Calendar
 * does. Overlapping events are placed by `layoutDayBlocks`: events that start
 * together sit side by side, a much later one is drawn over the earlier one.
 *
 * Data: `/me/events` + `/me/trips` (server-authoritative, ADR 0017).
 * Trips render as a single top band on every day they cover; per-leg
 * positioning + the "Important days" filter (depends on ADR 0016 family
 * graph) ship in PR-B.1.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type RefreshControlProps,
  useWindowDimensions,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { TextInput } from '@/text-input';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  calendarSwipeStep,
  clipBlockToDay as clipBlockToDayShared,
  layoutDayBlocks,
  legsForDay as legsForDayShared,
  legsNotOnCalendar,
  localDayBounds,
  type DayBlockPlacement,
  type GroupEvent,
  type ImportantDay,
  type ImportantDateKind,
  type Proposal,
  type TravelLeg,
  type TripStatus,
  instantOfWallTime,
  moveEndWithStart,
  suggestionWhen,
  wallTimeIn,
  zoneForEvent,
  type TimeOfDay,
} from '@chord/kernel';
import { TimeField, TimeZoneField } from '@/time-field';
import { KeyboardModalBody, KeyboardScrollView, DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';
import { deviceTimezone } from '@/timezone';

import {
  deleteEvent,
  getCalendarStatus,
  listAllEvents,
  listAllProposals,
  listImportantDays,
  listTripStatuses,
  syncCalendar,
  updateEvent,
} from '@/api';
import { answerProposal } from '@/proposal-answers';
import { getDeviceGhostEventsForDay, type DeviceGhostEvent } from '@/applesync';
import { confirmDestructive } from '@/confirm';
import { EventGuests } from '@/event-guests';
import { EventDetail } from '@/event-detail';
import { MainBottomNav } from '@/group-nav';
import { useScrollTopOnReselect, useTabReselect } from '@/tab-reselect';
import { useScreenRefresh } from '@/refresh';
import { useApp } from '@/store';
import { loadErrorText } from '@/network';
import { byScheme, colors, themed } from '@/theme';
import { DateField } from '@/date-field';
import { HeldStrip } from '@/meeting-holds';

type ViewMode = 'list' | 'day' | 'multi' | 'month';
type Filter = 'all' | 'trips' | 'important';

// v2: the list view became the default; a stored v1 'day' must not override it.
const VIEW_MODE_STORAGE_KEY = 'calendar.viewMode.v2';
const VIEW_MODES: Array<{ mode: ViewMode; label: string; icon: IconName }> = [
  { mode: 'day', label: 'Single Day', icon: 'view-day-outline' },
  { mode: 'multi', label: 'Multi Day', icon: 'view-column-outline' },
  { mode: 'list', label: 'List', icon: 'format-list-bulleted' },
  { mode: 'month', label: 'Month', icon: 'calendar-month-outline' },
];
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

/** Days the list shows at first; "Show more" adds this many again. */
const LIST_DAYS = 60;

/** Columns in the multi-day view: two on a phone (as Apple does), more when
 *  the screen has room. */
function multiDayCount(width: number): number {
  if (width < 600) return 2;
  if (width < 1000) return 4;
  return 7;
}

// Persisted snapshot of the last successful /me/events + /me/trips +
// importantDays response. Painted instantly on mount so re-entering the
// calendar tab doesn't flash an empty grid while the network round-trip
// (and any Google sync behind it) is in flight. Bump the version suffix
// if the GroupEvent / TripStatus / ImportantDay shapes change.
const CALENDAR_CACHE_KEY = 'calendar.cache.v1';
interface CalendarCache {
  events: GroupEvent[];
  trips: TripStatus[];
  important: ImportantDay[];
  horizon: number;
}

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'trips', label: 'Trips' },
  { key: 'important', label: 'Important' },
];

interface ImportantOccurrence {
  id: string;
  personName: string;
  kind: ImportantDateKind;
  /** local-midnight Date for the occurrence in the visible window */
  on: Date;
}

interface TripBand {
  tripId: string;
  title: string;
  destination: string | null;
  start: Date; // midnight local
  end: Date;   // midnight local of last covered day
}

export default function CalendarScreen() {
  const [mode, setMode] = useState<ViewMode>('list');
  // Hydrate the last-used view from storage on mount and persist on
  // change so users don't get bumped back to the list every time they
  // open the calendar.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(VIEW_MODE_STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      if (raw && VIEW_MODES.some((v) => v.mode === raw)) {
        setMode(raw as ViewMode);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    void AsyncStorage.setItem(VIEW_MODE_STORAGE_KEY, mode).catch(() => {});
  }, [mode]);

  const [filter, setFilter] = useState<Filter>('all');
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const { width: windowWidth } = useWindowDimensions();
  const multiDays = multiDayCount(windowWidth);
  const [listDays, setListDays] = useState(LIST_DAYS);
  // A new starting day shows the usual stretch again, not a long tail.
  useEffect(() => setListDays(LIST_DAYS), [cursor]);
  const span = mode === 'month' ? 31 : mode === 'multi' ? multiDays : mode === 'list' ? listDays : 1;
  const [events, setEvents] = useState<GroupEvent[] | null>(null);
  const [trips, setTrips] = useState<TripStatus[] | null>(null);
  const [important, setImportant] = useState<ImportantDay[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<GroupEvent | null>(null);

  // Furthest forward window (in days) we've fetched from the server. Grows as
  // the user navigates into future months so far-out events - and Google-side
  // deletes out there - get pulled in. Starts at the server default (90).
  const horizonRef = useRef(90);
  // How far back (in days) the list reaches. The server returns a date window,
  // not the whole history; this grows as the user pages into past months. 45
  // covers the current month's grid (its first week can start 37 days back).
  const pastRef = useRef(45);

  // Hydrate from the last persisted snapshot so the grid paints instantly
  // on mount. The focus-effect refresh below still runs and replaces this
  // with fresh data once the server responds.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(CALENDAR_CACHE_KEY).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const cached = JSON.parse(raw) as CalendarCache;
        if (cached.horizon > horizonRef.current) horizonRef.current = cached.horizon;
        setEvents((prev) => prev ?? cached.events);
        setTrips((prev) => prev ?? cached.trips);
        setImportant((prev) => prev ?? cached.important);
      } catch {
        // Corrupt cache - ignore; the refresh will repopulate it.
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (futureDays?: number, pastDays?: number) => {
    if (futureDays && futureDays > horizonRef.current) horizonRef.current = futureDays;
    if (pastDays && pastDays > pastRef.current) pastRef.current = pastDays;
    try {
      const [e, t, i] = await Promise.all([
        listAllEvents(horizonRef.current, pastRef.current),
        listTripStatuses(),
        listImportantDays().catch(() => [] as ImportantDay[]),
      ]);
      setEvents(e);
      setTrips(t);
      setImportant(i);
      setErr(null);
      const snapshot: CalendarCache = {
        events: e,
        trips: t,
        important: i,
        horizon: horizonRef.current,
      };
      void AsyncStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify(snapshot)).catch(() => {});
    } catch (ex) {
      setErr(loadErrorText(ex));
    }
  }, []);

  // When the cursor moves far enough ahead that the visible window's far edge
  // approaches the horizon we've fetched, pull a wider window (one month of
  // look-ahead buffer). The server clamps the upper bound (730d).
  useEffect(() => {
    const edgeMs = addDays(cursor, span).getTime();
    const daysOut = Math.ceil((edgeMs - startOfDay(new Date()).getTime()) / 86_400_000);
    const needed = daysOut + 31;
    // Paging back: reach the start of the visible grid plus a week's buffer.
    const viewStartMs = addDays(cursor, mode === 'month' ? -37 : -7).getTime();
    const daysBack = Math.ceil((startOfDay(new Date()).getTime() - viewStartMs) / 86_400_000);
    const neededBack = daysBack + 7;
    if (needed > horizonRef.current || neededBack > pastRef.current) {
      void refresh(
        needed > horizonRef.current ? needed : undefined,
        neededBack > pastRef.current ? neededBack : undefined,
      );
    }
  }, [cursor, mode, span, refresh]);

  // Manual-refresh model: pull gcal on every entry into the calendar
  // tab. We don't have a background poller, so this is how new events
  // added on the Google side surface in Chord. Best-effort: render the
  // local DB immediately, kick off sync in parallel, re-fetch when it
  // returns. A 403 (no calendar scope on this account) just renders
  // local data without complaining.
  // Re-fetch every time the calendar tab regains focus so a delete (or
  // create) that happened elsewhere - chat, bot turn, another tab - is
  // reflected the moment the user comes back. The gcal pull behind it
  // stays best-effort and only fires when calendar is actually connected.
  const syncAndRefresh = useCallback(async () => {
    await refresh();
    try {
      const status = await getCalendarStatus();
      if (!status.connected) return;
      // Only re-fetch if the gcal pull actually imported new events; the
      // sync never mutates existing local rows, so inserted===0 means the
      // list we already rendered is current.
      const { inserted } = await syncCalendar();
      if (inserted === 0) return;
      await refresh();
    } catch {
      // sync is best-effort here - the visible calendar already
      // shows local data; surfacing the error would just be noise.
    }
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void syncAndRefresh();
    }, [syncAndRefresh]),
  );

  // `/calendar?event=<id>` (a chat card's "Open in calendar") jumps to that
  // event's day and opens it for editing, once.
  const { event: linkedEventId } = useLocalSearchParams<{ event?: string }>();
  useEffect(() => {
    if (!linkedEventId || !events) return;
    const ev = events.find((e) => e.id === linkedEventId);
    if (!ev) return;
    setCursor(startOfDay(new Date(ev.startsAt)));
    setEditing(ev);
    router.setParams({ event: undefined });
  }, [linkedEventId, events]);

  // Same pull as on focus - the tab is the app's only manual gcal trigger, so
  // the pull gesture has to do the real sync, not just re-read the local DB.
  const { refreshControl } = useScreenRefresh(syncAndRefresh);

  const tripBands = useMemo<TripBand[]>(() => {
    if (!trips) return [];
    return trips
      .filter((t) => t.trip.startDate && t.trip.endDate)
      .map((t) => ({
        tripId: t.trip.id,
        title: t.trip.name,
        destination: t.trip.destination ?? null,
        start: parseDateOnly(t.trip.startDate),
        end: parseDateOnly(t.trip.endDate),
      }));
  }, [trips]);

  const visibleEvents = useMemo(() => {
    if (!events) return [];
    if (filter === 'trips' || filter === 'important') return [];
    return events;
  }, [events, filter]);

  const visibleTrips = useMemo(() => {
    if (filter === 'important') return [];
    return tripBands;
  }, [tripBands, filter]);

  const visibleTripStatuses = useMemo<TripStatus[]>(() => {
    if (!trips) return [];
    if (filter === 'important') return [];
    return trips;
  }, [trips, filter]);

  const occurrences = useMemo<ImportantOccurrence[]>(() => {
    if (!important) return [];
    if (filter === 'trips') return [];
    return computeOccurrences(important, cursor);
  }, [important, filter, cursor]);

  const headerLabel = useMemo(() => {
    if (mode === 'month') {
      return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    if (mode === 'multi' || mode === 'list') {
      const last = addDays(cursor, (mode === 'multi' ? multiDays : 7) - 1);
      const sameMonth = cursor.getMonth() === last.getMonth();
      const startStr = cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      if (mode === 'list') return `From ${startStr}`;
      // A date format with a day and year but no month comes out as
      // "2026 (day: 24)", so the same-month end is just its day number.
      const endStr = sameMonth
        ? String(last.getDate())
        : last.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `${startStr} – ${endStr}, ${last.getFullYear()}`;
    }
    return cursor.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, [cursor, mode, multiDays]);

  // ‹ › move by what the view shows: a day, the multi-day span, a week of
  // the list, or a month.
  const step = mode === 'multi' ? multiDays : mode === 'list' ? 7 : 1;
  const goPrev = useCallback(() => {
    setCursor((c) => (mode === 'month' ? addMonths(c, -1) : addDays(c, -step)));
  }, [mode, step]);
  const goNext = useCallback(() => {
    setCursor((c) => (mode === 'month' ? addMonths(c, 1) : addDays(c, step)));
  }, [mode, step]);
  const goToday = useCallback(() => setCursor(startOfDay(new Date())), []);

  // A sideways swipe on the day, multi-day and month views does what ‹ ›
  // do: swipe left for the next page, right for the previous one.
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .enabled(mode === 'day' || mode === 'multi' || mode === 'month')
        .runOnJS(true)
        // Sideways only: a vertical drag fails the pan so the hour grid scrolls.
        .activeOffsetX([-15, 15])
        .failOffsetY([-15, 15])
        .onEnd((e) => {
          const s = calendarSwipeStep({ dx: e.translationX, dy: e.translationY, vx: e.velocityX });
          if (s > 0) goNext();
          else if (s < 0) goPrev();
        }),
    [mode, goNext, goPrev],
  );
  // Tapping Calendar again returns to today; the hour grid re-centres on now.
  useTabReselect('calendar', goToday);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Calendar', headerBackVisible: false }} />
      <HeldStrip />

      {/* Header: nav + view picker */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Pressable hitSlop={10} onPress={goPrev} style={styles.navBtn}>
            <Text style={styles.navTxt}>‹</Text>
          </Pressable>
          <Text style={styles.headerLabel} numberOfLines={1}>{headerLabel}</Text>
          <Pressable hitSlop={10} onPress={goNext} style={styles.navBtn}>
            <Text style={styles.navTxt}>›</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={goToday} style={styles.todayBtn}>
            <Text style={styles.todayTxt}>Today</Text>
          </Pressable>
          <ViewModeButton
            mode={mode}
            onPick={setMode}
          />
        </View>
        <View style={styles.headerRow}>
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Email-derived event suggestions (ADR 0063) - confirm to add. */}
      <EventSuggestions onConfirmed={() => void refresh()} />

      {/* Body */}
      {events === null || trips === null || important === null ? (
        <View style={styles.center}><ActivityIndicator /></View>
      ) : (
        <GestureDetector gesture={swipe}>
        <View style={styles.body}>
          {err && <Text style={styles.err}>{err}</Text>}
          {mode === 'list' && (
            <ListView
              start={cursor}
              days={listDays}
              events={visibleEvents}
              trips={visibleTrips}
              tripStatuses={visibleTripStatuses}
              occurrences={occurrences}
              onEditEvent={setEditing}
              onShowMore={() => setListDays((n) => n + LIST_DAYS)}
              refreshControl={refreshControl}
            />
          )}
          {mode === 'day' && (
            <DayView
              date={cursor}
              events={visibleEvents}
              trips={visibleTrips}
              tripStatuses={visibleTripStatuses}
              occurrences={occurrences}
              onEditEvent={setEditing}
              refreshControl={refreshControl}
            />
          )}
          {mode === 'multi' && (
            <MultiDayView
              days={Array.from({ length: multiDays }, (_, i) => addDays(cursor, i))}
              events={visibleEvents}
              trips={visibleTrips}
              tripStatuses={visibleTripStatuses}
              occurrences={occurrences}
              onEditEvent={setEditing}
              refreshControl={refreshControl}
            />
          )}
          {mode === 'month' && (
            <MonthView
              anchor={cursor}
              events={visibleEvents}
              trips={visibleTrips}
              occurrences={occurrences}
              refreshControl={refreshControl}
              onPickDay={(d) => {
                setCursor(d);
                setMode('day');
              }}
            />
          )}
        </View>
        </GestureDetector>
      )}

      <EventEditModal
        event={editing}
        onClose={() => setEditing(null)}
        onChanged={() => {
          setEditing(null);
          void refresh();
        }}
      />

      <MainBottomNav current="calendar" />
    </View>
  );
}

// ── Email-derived event suggestions (ADR 0063) ───────────────────────
//
// The email magics stage `create_event` proposals in the user's personal
// group; they have no Catchup tab, so they surface here as a confirmable
// strip. Confirm dispatches the tool (creating the event); the parent then
// refreshes so the new event appears in the grid.

function describeEventProposal(p: Proposal): { title: string; when: string | null } {
  try {
    const a = JSON.parse(p.argsJson) as Record<string, unknown>;
    const title = typeof a.title === 'string' ? a.title : '(untitled event)';
    const location = typeof a.location === 'string' ? a.location : null;
    const when = suggestionWhen(a.startsAt, { allDay: a.allDay === true });
    return { title, when: [when, location].filter(Boolean).join(' · ') || null };
  } catch {
    return { title: '(untitled event)', when: null };
  }
}

function EventSuggestions({ onConfirmed }: { onConfirmed: () => void }) {
  const [items, setItems] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const groups = useApp((s) => s.groups);
  const groupName = (id: string | null): string | null =>
    id ? groups.find((g) => g.id === id)?.name ?? null : null;

  const load = useCallback(async () => {
    try {
      const all = await listAllProposals();
      setItems(all.filter((p) => p.toolName === 'create_event' && p.status === 'pending'));
    } catch {
      /* best-effort - suggestions are additive */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const resolve = useCallback(
    async (p: Proposal, action: 'confirm' | 'reject') => {
      setBusy((prev) => new Set(prev).add(p.id));
      try {
        await answerProposal({
          proposalId: p.id,
          memberIds: [p.id],
          action,
          label: describeEventProposal(p).title,
        });
        setItems((xs) => xs.filter((x) => x.id !== p.id));
        if (action === 'confirm') onConfirmed();
      } catch {
        void load(); // re-sync on failure
      } finally {
        setBusy((prev) => {
          const n = new Set(prev);
          n.delete(p.id);
          return n;
        });
      }
    },
    [load, onConfirmed],
  );

  const [open, setOpen] = useState(true);
  const { height: windowHeight } = useWindowDimensions();

  if (items.length === 0) return null;

  // The list scrolls inside a box capped at about a third of the screen, and
  // the header folds it, so a pile of pending suggestions never pushes the
  // calendar itself off the screen.
  return (
    <View style={styles.suggestWrap}>
      <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6} style={styles.suggestHeadRow}>
        <Text style={styles.suggestHead}>
          📬 Suggested from email ({items.length})
        </Text>
        <Text style={styles.suggestHead}>{open ? '▾ Hide' : '▸ Show'}</Text>
      </Pressable>
      {open ? (
      <ScrollView
        style={{ maxHeight: Math.max(140, Math.round(windowHeight * 0.3)) }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
      {items.map((p) => {
        const { title, when } = describeEventProposal(p);
        const dest = groupName(p.targetGroupId);
        const isBusy = busy.has(p.id);
        // Tapping the text opens the source email - you can't judge a
        // suggestion you can't inspect.
        const openSource = p.sourceHref
          ? () => router.push(p.sourceHref as never)
          : undefined;
        return (
          <View key={p.id} style={styles.suggestRow}>
            <Pressable
              style={{ flex: 1, minWidth: 0 }}
              onPress={openSource}
              disabled={!openSource}
            >
              <Text
                style={[styles.suggestTitle, openSource && styles.suggestTitleLink]}
                numberOfLines={1}
              >
                {title}
              </Text>
              {when ? <Text style={styles.suggestSub} numberOfLines={1}>{when}</Text> : null}
              {dest ? (
                <Text style={styles.suggestDest} numberOfLines={1}>
                  → shares with {dest}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              onPress={() => void resolve(p, 'confirm')}
              disabled={isBusy}
              style={[styles.suggestBtn, styles.suggestConfirm, isBusy && styles.suggestBtnBusy]}
            >
              <Text style={styles.suggestConfirmTxt}>{dest ? 'Share' : 'Add'}</Text>
            </Pressable>
            <Pressable
              onPress={() => void resolve(p, 'reject')}
              disabled={isBusy}
              style={[styles.suggestBtn, isBusy && styles.suggestBtnBusy]}
            >
              <Text style={styles.suggestDismissTxt}>✕</Text>
            </Pressable>
          </View>
        );
      })}
      </ScrollView>
      ) : null}
    </View>
  );
}

// ── Day view ─────────────────────────────────────────────────────────

/**
 * Phone-only events for the visible day, rendered as local ghost blocks
 * (ADR 0072 addendum). Deduped against the server events already on screen
 * (same normalized title starting within 5 minutes = the same thing seen via
 * two paths). Read locally, never uploaded.
 */
function useDeviceGhostEvents(date: Date, serverEvents: GroupEvent[]): DeviceGhostEvent[] {
  const [ghosts, setGhosts] = useState<DeviceGhostEvent[]>([]);
  const dayKey = date.toDateString();
  useEffect(() => {
    let cancelled = false;
    const bounds = localDayBounds(date);
    void getDeviceGhostEventsForDay(new Date(bounds.dayStart), new Date(bounds.dayEnd))
      .then((g) => {
        if (!cancelled) setGhosts(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  return useMemo(() => {
    const TOLERANCE_MS = 5 * 60 * 1000;
    const norm = (s: string) => s.trim().toLowerCase();
    return ghosts.filter(
      (g) =>
        !serverEvents.some(
          (e) =>
            norm(e.title) === norm(g.title) &&
            Math.abs(parseIso(e.startsAt).getTime() - parseIso(g.startsAt).getTime()) <
              TOLERANCE_MS,
        ),
    );
  }, [ghosts, serverEvents]);
}

/**
 * Keeps the hour-grid scrolled so the current time stays in view and ticks the
 * red "now" line as time passes. On a non-today day/week the grid opens at 7am.
 * Re-centres only when "now" drifts off-screen AND the user hasn't scrolled in
 * the last minute - so it tracks time without fighting manual scrolling.
 */
function useNowTracking(
  scrollRef: RefObject<ScrollView | null>,
  periodKey: string,
  isTodayVisible: boolean,
): {
  now: Date;
  onLayout: (e: LayoutChangeEvent) => void;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag: () => void;
} {
  const [now, setNow] = useState(() => new Date());
  const viewportH = useRef(0);
  const scrollY = useRef(0);
  const lastUserScroll = useRef(0);

  const centerOnNow = useCallback(
    (animated: boolean) => {
      const y = (minutesIntoDay(new Date()) / 60) * HOUR_HEIGHT;
      const h = viewportH.current || HOUR_HEIGHT * 8;
      scrollRef.current?.scrollTo({ y: Math.max(0, y - h / 2), animated });
    },
    [scrollRef],
  );

  useTabReselect('calendar', () => {
    if (isTodayVisible) centerOnNow(true);
  });

  // Initial position whenever the visible day/week changes.
  useEffect(() => {
    const t = setTimeout(() => {
      if (isTodayVisible) centerOnNow(false);
      else scrollRef.current?.scrollTo({ y: 7 * HOUR_HEIGHT, animated: false });
    }, 50);
    return () => clearTimeout(t);
  }, [periodKey, isTodayVisible, centerOnNow, scrollRef]);

  // Tick: advance the red line; re-centre if "now" left the viewport.
  useEffect(() => {
    if (!isTodayVisible) return;
    const id = setInterval(() => {
      setNow(new Date());
      const y = (minutesIntoDay(new Date()) / 60) * HOUR_HEIGHT;
      const h = viewportH.current || HOUR_HEIGHT * 8;
      const offscreen = y < scrollY.current + 24 || y > scrollY.current + h - 24;
      const browsing = Date.now() - lastUserScroll.current < 60_000;
      if (offscreen && !browsing) centerOnNow(true);
    }, 30_000);
    return () => clearInterval(id);
  }, [isTodayVisible, centerOnNow]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    viewportH.current = e.nativeEvent.layout.height;
  }, []);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
  }, []);
  const onScrollBeginDrag = useCallback(() => {
    lastUserScroll.current = Date.now();
  }, []);

  return { now, onLayout, onScroll, onScrollBeginDrag };
}

// ── Event edit modal (ADR 0072) ──────────────────────────────────────
//
// Tap an event block → edit title/when/where or delete. Saves go through the
// normal PATCH route, so a Google-synced copy bumps its sequence and pushes
// (ADR 0040); a device-mirrored copy follows LWW with the phone.

const pad2 = (n: number) => String(n).padStart(2, '0');

function EventEditModal({
  event,
  onClose,
  onChanged,
}: {
  event: GroupEvent | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [start, setStart] = useState<TimeOfDay | null>(null);
  const [end, setEnd] = useState<TimeOfDay | null>(null);
  const deviceZone = useMemo(() => deviceTimezone(), []);
  const [zone, setZone] = useState<string>(deviceZone ?? 'UTC');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ADR 0331 — a tap shows the event to read (links, call, place); Edit
  // switches to the form.
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  useEffect(() => {
    if (!event) return;
    setMode('view');
    const z = zoneForEvent(event.startsAt, event.timeZone, deviceZone ?? 'UTC');
    const s = wallTimeIn(parseIso(event.startsAt).getTime(), z);
    setZone(z);
    setTitle(event.title);
    setDateStr(`${s.year}-${pad2(s.month)}-${pad2(s.day)}`);
    setStart({ hour: s.hour, minute: s.minute });
    if (event.endsAt) {
      const e = wallTimeIn(parseIso(event.endsAt).getTime(), z);
      setEnd({ hour: e.hour, minute: e.minute });
    } else {
      setEnd(null);
    }
    setLocation(event.location ?? '');
    setErr(null);
  }, [event, deviceZone]);

  // A moved start takes the end with it, so the event keeps its length.
  const changeStart = useCallback(
    (next: TimeOfDay | null) => {
      if (!next) return;
      setEnd((e) => (start ? moveEndWithStart(start, e, next) : e));
      setStart(next);
    },
    [start],
  );

  const save = useCallback(async () => {
    if (!event) return;
    const dm = dateStr.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!dm || !start) {
      setErr('Pick a date and a start time.');
      return;
    }
    if (!title.trim()) {
      setErr('Title can’t be empty.');
      return;
    }
    const [, y, mo, d] = dm.map(Number) as unknown as number[];
    // The times are clock times in the chosen zone.
    const startAt = instantOfWallTime({ year: y, month: mo, day: d, ...start }, zone);
    let endsAt: string | null = null;
    if (end) {
      let endAt = instantOfWallTime({ year: y, month: mo, day: d, ...end }, zone);
      // An end "before" the start means it crosses midnight.
      if (endAt <= startAt) {
        const next = new Date(Date.UTC(y, mo - 1, d + 1));
        endAt = instantOfWallTime(
          { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), ...end },
          zone,
        );
      }
      endsAt = endAt.toISOString();
    }
    setBusy(true);
    setErr(null);
    try {
      await updateEvent(event.id, {
        title: title.trim(),
        location: location.trim() || null,
        startsAt: startAt.toISOString(),
        endsAt,
        timeZone: zone,
      });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [event, title, dateStr, start, end, zone, location, onChanged]);

  const remove = useCallback(() => {
    if (!event) return;
    confirmDestructive(event.title, 'Delete this event? Synced copies go too.', () => {
      setBusy(true);
      void deleteEvent(event.id)
        .then(() => onChanged())
        .catch((e) => setErr((e as Error).message))
        .finally(() => setBusy(false));
    });
  }, [event, onChanged]);

  return (
    <Modal visible={!!event} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardModalBody>
      <Pressable style={editStyles.scrim} onPress={onClose}>
        <Pressable style={editStyles.modal} onPress={(e) => e.stopPropagation()}>
          <KeyboardScrollView>
          {event && mode === 'view' ? (
            <>
              <Text style={editStyles.viewTitle} selectable>
                {event.title}
              </Text>
              <Text style={editStyles.whenText}>{eventWhenLabel(event)}</Text>
              <View style={editStyles.calRow}>
                <View
                  style={[editStyles.calDot, { backgroundColor: calendarHex(event.color) ?? colors.accent }]}
                />
                <Text style={editStyles.calName}>{calendarNameOf(event)}</Text>
              </View>
              {tripLineOf(event) ? (
                <Text style={[editStyles.calName, { marginTop: 4 }]}>{tripLineOf(event)}</Text>
              ) : null}
              <EventDetail
                event={event}
                guests={({ hasVideoCall }) => (
                  <EventGuests eventId={event.id} title={event.title} onLeave={onClose} hasVideoCall={hasVideoCall} />
                )}
              />
              {err ? <Text style={editStyles.err}>{err}</Text> : null}
              <View style={editStyles.actions}>
                <Pressable style={[editStyles.btn, editStyles.cancelBtn]} onPress={onClose}>
                  <Text style={editStyles.cancelTxt}>Close</Text>
                </Pressable>
                <Pressable style={[editStyles.btn, editStyles.saveBtn]} onPress={() => setMode('edit')}>
                  <Text style={editStyles.saveTxt}>Edit</Text>
                </Pressable>
              </View>
            </>
          ) : (
          <>
          <Text style={editStyles.heading}>Edit event</Text>
          {event && (
            <View style={editStyles.calRow}>
              <View
                style={[editStyles.calDot, { backgroundColor: calendarHex(event.color) ?? colors.accent }]}
              />
              <Text style={editStyles.calName}>{calendarNameOf(event)}</Text>
            </View>
          )}
          {event && tripLineOf(event) && (
            <Text style={[editStyles.calName, { marginBottom: 8 }]}>{tripLineOf(event)}</Text>
          )}

          <Text style={editStyles.fieldLabel}>Title</Text>
          <TextInput value={title} onChangeText={setTitle} returnKeyType="done" style={editStyles.input} />

          <Text style={editStyles.fieldLabel}>Date</Text>
          <DateField value={dateStr} onChange={setDateStr} inputStyle={editStyles.input} />

          <View style={editStyles.timeRow}>
            <View style={{ flex: 1 }}>
              <Text style={editStyles.fieldLabel}>Starts</Text>
              <TimeField value={start} onChange={changeStart} accessibilityLabel="Start time" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={editStyles.fieldLabel}>Ends (optional)</Text>
              <TimeField
                value={end}
                onChange={setEnd}
                clearable
                placeholder="No end"
                accessibilityLabel="End time"
              />
            </View>
          </View>

          <Text style={editStyles.fieldLabel}>Time zone</Text>
          <TimeZoneField
            value={zone}
            onChange={setZone}
            deviceZone={deviceZone}
            at={event ? parseIso(event.startsAt).getTime() : Date.now()}
          />

          <Text style={editStyles.fieldLabel}>Location</Text>
          <TextInput
            value={location}
            onChangeText={setLocation}
            placeholder="optional"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            style={editStyles.input}
          />

          {err ? <Text style={editStyles.err}>{err}</Text> : null}

          <View style={editStyles.actions}>
            <Pressable
              style={[editStyles.btn, editStyles.deleteBtn]}
              disabled={busy}
              onPress={remove}
            >
              <Text style={editStyles.deleteTxt}>Delete</Text>
            </Pressable>
            <Pressable style={[editStyles.btn, editStyles.cancelBtn]} disabled={busy} onPress={onClose}>
              <Text style={editStyles.cancelTxt}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[editStyles.btn, editStyles.saveBtn, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={() => void save()}
            >
              <Text style={editStyles.saveTxt}>{busy ? '…' : 'Save'}</Text>
            </Pressable>
          </View>
          </>
          )}
          </KeyboardScrollView>
        </Pressable>
      </Pressable>
      </KeyboardModalBody>
    </Modal>
  );
}

const editStyles = themed((colors) => ({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modal: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 440,
    maxHeight: '100%',
  },
  heading: { fontSize: 17, fontWeight: '700', color: colors.text },
  viewTitle: { fontSize: 19, fontWeight: '700', color: colors.text },
  whenText: { fontSize: 14, color: colors.text, marginTop: 4 },
  calRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  calDot: { width: 10, height: 10, borderRadius: 5 },
  calName: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  fieldLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.bg,
  },
  timeRow: { flexDirection: 'row', gap: 10 },
  err: { color: colors.red, fontSize: 13, marginTop: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  btn: { borderRadius: 8, paddingVertical: 10, alignItems: 'center', paddingHorizontal: 14 },
  deleteBtn: { borderWidth: 1, borderColor: colors.red },
  deleteTxt: { color: colors.red, fontWeight: '600' },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: colors.border },
  cancelTxt: { color: colors.text, fontWeight: '600' },
  saveBtn: { flex: 1, backgroundColor: colors.accent },
  saveTxt: { color: colors.onAccent, fontWeight: '600' },
}));

function DayView({
  date,
  events,
  trips,
  tripStatuses,
  occurrences,
  onEditEvent,
  refreshControl,
}: {
  date: Date;
  events: GroupEvent[];
  trips: TripBand[];
  tripStatuses: TripStatus[];
  occurrences: ImportantOccurrence[];
  onEditEvent: (e: GroupEvent) => void;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const allDayEvents = useMemo(
    () => filterEventsForDay(events, date).filter(isAllDayEvent),
    [events, date],
  );
  const dayEvents = useMemo(
    () => filterEventsForDay(events, date).filter((e) => !isAllDayEvent(e)),
    [events, date],
  );
  const dayTrips = useMemo(() => trips.filter((t) => withinTrip(t, date)), [trips, date]);
  const dayLegs = useMemo(() => legsForDay(tripStatuses, date, events), [tripStatuses, date, events]);
  const dayGhosts = useDeviceGhostEvents(date, dayEvents);
  const [colWidth, setColWidth] = useState(0);
  const area = laneArea(colWidth, false);
  // Ghosts and legs share the layout pass so a phone-only event or a flight
  // is placed against the Chord events it overlaps.
  const blocks = useMemo(
    () => dayBlocks(dayEvents, dayLegs, dayGhosts, area),
    [dayEvents, dayLegs, dayGhosts, area],
  );
  const dayOccurrences = useMemo(
    () => occurrences.filter((o) => sameDay(o.on, date)),
    [occurrences, date],
  );

  const isToday = sameDay(date, new Date());
  const { now, onLayout, onScroll, onScrollBeginDrag } = useNowTracking(
    scrollRef,
    date.toDateString(),
    isToday,
  );
  const nowOffset = isToday ? (minutesIntoDay(now) / 60) * HOUR_HEIGHT : null;

  return (
    <View style={{ flex: 1 }}>
      <TripBands trips={dayTrips} />
      <ImportantBands occurrences={dayOccurrences} />
      <AllDayStrip events={allDayEvents} />
      <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
        ref={scrollRef}
        style={{ flex: 1 }}
        onLayout={onLayout}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        scrollEventThrottle={32}
        refreshControl={refreshControl}
      >
        <View
          style={[styles.hourCol, { height: HOUR_HEIGHT * 24 }]}
          onLayout={(e) => setColWidth(e.nativeEvent.layout.width)}
        >
          {/* Hour gridlines + labels */}
          {HOURS.map((h) => (
            <View key={h} style={[styles.hourRow, { top: h * HOUR_HEIGHT }]}>
              <Text style={styles.hourLabel}>{formatHour(h)}</Text>
              <View style={styles.hourLine} />
            </View>
          ))}
          {/* Events, phone-only ghosts and travel legs, lowest layer first */}
          {blocks.map((b) => (
            <DayBlock key={b.key} block={b} date={date} onEditEvent={onEditEvent} />
          ))}
          {/* Now line */}
          {nowOffset !== null && (
            <View style={[styles.nowLine, { top: nowOffset }]} pointerEvents="none">
              <View style={styles.nowDot} />
              <View style={styles.nowBar} />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// ── Multi-day view ───────────────────────────────────────────────────

function MultiDayView({
  days,
  events,
  trips,
  tripStatuses,
  occurrences,
  onEditEvent,
  refreshControl,
}: {
  days: Date[];
  events: GroupEvent[];
  trips: TripBand[];
  tripStatuses: TripStatus[];
  occurrences: ImportantOccurrence[];
  onEditEvent: (e: GroupEvent) => void;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [colWidth, setColWidth] = useState(0);
  const area = laneArea(colWidth, true, days.length);

  const first = days[0]!;
  const isTodayShown = days.some((d) => sameDay(d, new Date()));
  const { now, onLayout, onScroll, onScrollBeginDrag } = useNowTracking(
    scrollRef,
    `${first.toDateString()}+${days.length}`,
    isTodayShown,
  );
  const today = now;

  return (
    <View style={{ flex: 1 }}>
      {/* Day-of-week strip */}
      <View style={styles.weekHeader}>
        <View style={styles.weekHourGutter} />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          return (
            <View key={d.toISOString()} style={styles.weekDayCell}>
              <Text style={styles.weekDayName}>{DAY_NAMES[d.getDay()]}</Text>
              <View style={[styles.weekDayNum, isToday && styles.weekDayNumToday]}>
                <Text style={[styles.weekDayNumTxt, isToday && styles.weekDayNumTxtToday]}>
                  {d.getDate()}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* Trip bands across the week (one row per active trip) */}
      <WeekTripBands days={days} trips={trips} />
      {/* Important-day pills under the day numbers */}
      <WeekImportantStrip days={days} occurrences={occurrences} />
      {/* All-day events row - kept out of the hour grid below. */}
      <WeekAllDayStrip days={days} events={events} />

      <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
        ref={scrollRef}
        style={{ flex: 1 }}
        onLayout={onLayout}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        scrollEventThrottle={32}
        refreshControl={refreshControl}
      >
        <View style={[styles.weekGrid, { height: HOUR_HEIGHT * 24 }]}>
          {/* Hour gutter */}
          <View style={[styles.weekHourGutter, { height: HOUR_HEIGHT * 24 }]}>
            {HOURS.map((h) => (
              <Text key={h} style={[styles.weekHourLabel, { top: h * HOUR_HEIGHT }]}>
                {formatHour(h)}
              </Text>
            ))}
          </View>
          {/* 7 day columns */}
          {days.map((d, idx) => {
            const dayEvents = filterEventsForDay(events, d).filter((e) => !isAllDayEvent(e));
            const dayLegs = legsForDay(tripStatuses, d, events);
            const blocks = dayBlocks(dayEvents, dayLegs, [], area);
            const isLast = idx === days.length - 1;
            const isToday = sameDay(d, today);
            const nowOffset = isToday ? minutesIntoDay(today) / 60 * HOUR_HEIGHT : null;
            return (
              <View
                key={d.toISOString()}
                style={[styles.weekColumn, isLast && { borderRightWidth: 0 }]}
                // The columns share one width; measuring the first is enough.
                onLayout={idx === 0 ? (e) => setColWidth(e.nativeEvent.layout.width) : undefined}
              >
                {HOURS.map((h) => (
                  <View key={h} style={[styles.weekHourCell, { top: h * HOUR_HEIGHT }]} />
                ))}
                {blocks.map((b) => (
                  <DayBlock key={b.key} block={b} compact date={d} onEditEvent={onEditEvent} />
                ))}
                {nowOffset !== null && (
                  <View style={[styles.nowLine, { top: nowOffset, left: 0, right: 0 }]} pointerEvents="none">
                    <View style={styles.nowDot} />
                    <View style={styles.nowBar} />
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

// ── View button ──────────────────────────────────────────────────────

/** The header button showing the current view's icon; tapping it opens a
 *  small menu of views with a check by the current one. */
function ViewModeButton({
  mode,
  onPick,
}: {
  mode: ViewMode;
  onPick: (m: ViewMode) => void;
}) {
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const current = VIEW_MODES.find((v) => v.mode === mode) ?? VIEW_MODES[0]!;
  const open = () => {
    const el = ref.current;
    if (!el) return;
    el.measureInWindow((x, y, w, h) => {
      const winWidth = Dimensions.get('window').width;
      setAnchor({ top: y + h + 6, right: Math.max(8, winWidth - x - w) });
    });
  };
  return (
    <>
      <Pressable
        ref={ref}
        hitSlop={6}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`View: ${current.label}. Change view`}
        style={styles.viewBtn}
      >
        <MaterialCommunityIcons name={current.icon} size={20} color={colors.accent} />
      </Pressable>
      <Modal
        visible={!!anchor}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setAnchor(null)}
      >
        <Pressable style={styles.menuScrim} onPress={() => setAnchor(null)}>
          {anchor && (
            <View style={[styles.menu, { top: anchor.top, right: anchor.right }]}>
              {VIEW_MODES.map((v) => {
                const active = v.mode === mode;
                return (
                  <Pressable
                    key={v.mode}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setAnchor(null);
                      onPick(v.mode);
                    }}
                    style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
                  >
                    <View style={styles.menuCheck}>
                      {active && <MaterialCommunityIcons name="check" size={18} color={colors.text} />}
                    </View>
                    <MaterialCommunityIcons name={v.icon} size={20} color={colors.text} />
                    <Text style={styles.menuTxt}>{v.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Pressable>
      </Modal>
    </>
  );
}

// ── List view ────────────────────────────────────────────────────────

interface ListRow {
  key: string;
  color: string;
  title: string;
  sub: string | null;
  /** Start time, or a word ("all-day", "trip") for something with no time. */
  time: string;
  endTime: string | null;
  sortMs: number;
  /** Shown informational ("free") - drawn muted, as in the grid. */
  open?: boolean;
  onPress?: () => void;
}

/**
 * Days from `start`, one heading per day that has anything on it: all-day
 * things first, then timed events and travel legs by start time. Days with
 * nothing are left out, as Apple's list does.
 */
function ListView({
  start,
  days,
  events,
  trips,
  tripStatuses,
  occurrences,
  onEditEvent,
  onShowMore,
  refreshControl,
}: {
  start: Date;
  days: number;
  events: GroupEvent[];
  trips: TripBand[];
  tripStatuses: TripStatus[];
  occurrences: ImportantOccurrence[];
  onEditEvent: (e: GroupEvent) => void;
  onShowMore: () => void;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const sections = useMemo(() => {
    const out: Array<{ day: Date; rows: ListRow[] }> = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const rows: ListRow[] = [];
      for (const o of occurrences) {
        if (!sameDay(o.on, d)) continue;
        rows.push({
          key: `imp:${o.id}`,
          color: importantPink(),
          title: `${kindEmoji(o.kind)} ${o.personName}`,
          sub: kindLabel(o.kind),
          time: 'all-day',
          endTime: null,
          sortMs: 0,
        });
      }
      for (const t of trips) {
        // On its first day, or at the top of the list while it is under way.
        if (!sameDay(t.start, d) && !(i === 0 && withinTrip(t, d))) continue;
        rows.push({
          key: `trip:${t.tripId}`,
          color: tripOrange(),
          title: `✈ ${t.title}`,
          sub: [t.destination, tripRange(t)].filter(Boolean).join(' · '),
          time: 'trip',
          endTime: null,
          sortMs: 0,
        });
      }
      for (const e of filterEventsForDay(events, d)) {
        const allDay = isAllDayEvent(e);
        const s = parseIso(e.startsAt);
        rows.push({
          key: `ev:${e.id}`,
          color: calendarHex(e.color) ?? colors.accent,
          title: shownTitle(e),
          sub: e.location || null,
          time: allDay ? 'all-day' : clockTime(s),
          endTime: allDay || !e.endsAt ? null : clockTime(parseIso(e.endsAt)),
          sortMs: allDay ? 0 : s.getTime(),
          open: e.transparency === 'transparent',
          onPress: () => onEditEvent(e),
        });
      }
      for (const leg of legsForDay(tripStatuses, d, events)) {
        const depart = parseIso(leg.departAt);
        if (!sameDay(depart, d)) continue;
        const pax = formatPassengers(leg.passengers);
        rows.push({
          key: `leg:${leg.id}`,
          color: tripOrange(),
          title: legLabel(leg),
          sub: [`${leg.origin} → ${leg.destination}`, pax].filter(Boolean).join(' · '),
          time: clockTime(depart),
          endTime: clockTime(parseIso(leg.arriveAt)),
          sortMs: depart.getTime(),
        });
      }
      if (rows.length === 0) continue;
      rows.sort((a, b) => a.sortMs - b.sortMs);
      out.push({ day: d, rows });
    }
    return out;
  }, [start, days, events, trips, tripStatuses, occurrences, onEditEvent]);

  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('calendar', scrollRef);
  const today = new Date();
  return (
    <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={styles.listContent}
      refreshControl={refreshControl}
    >
      {sections.length === 0 && (
        <Text style={styles.listEmpty}>Nothing on the calendar in the next {days} days.</Text>
      )}
      {sections.map(({ day, rows }) => (
        <View key={day.toISOString()} style={styles.listSection}>
          <Text style={[styles.listDay, sameDay(day, today) && styles.listDayToday]}>
            {day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </Text>
          {rows.map((r) => (
            <Pressable
              key={r.key}
              onPress={r.onPress}
              disabled={!r.onPress}
              style={({ pressed }) => [styles.listRow, pressed && styles.menuRowPressed]}
            >
              <View style={[styles.listBar, { backgroundColor: r.color }]} />
              <View style={styles.listMain}>
                <Text style={[styles.listTitle, r.open && styles.listTitleOpen]} numberOfLines={1}>
                  {r.title}
                </Text>
                {r.sub ? (
                  <Text style={styles.listSub} numberOfLines={1}>{r.sub}</Text>
                ) : null}
              </View>
              <View style={styles.listTimes}>
                <Text style={styles.listTime}>{r.time}</Text>
                {r.endTime ? <Text style={styles.listEndTime}>{r.endTime}</Text> : null}
              </View>
            </Pressable>
          ))}
        </View>
      ))}
      <Pressable onPress={onShowMore} style={styles.listMore}>
        <Text style={styles.listMoreTxt}>Show more</Text>
      </Pressable>
    </ScrollView>
  );
}

function clockTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function tripRange(t: TripBand): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (sameDay(t.start, t.end)) return t.start.toLocaleDateString(undefined, opts);
  return `${t.start.toLocaleDateString(undefined, opts)} – ${t.end.toLocaleDateString(undefined, opts)}`;
}

function legLabel(leg: TravelLeg): string {
  const carrier = [leg.carrier, leg.flightNo].filter(Boolean).join(' ').trim();
  return `${modeIcon(leg.mode)} ${carrier || `${leg.origin} → ${leg.destination}`}`;
}

// ── Month view ───────────────────────────────────────────────────────

function MonthView({
  anchor,
  events,
  trips,
  occurrences,
  onPickDay,
  refreshControl,
}: {
  anchor: Date;
  events: GroupEvent[];
  trips: TripBand[];
  occurrences: ImportantOccurrence[];
  onPickDay: (d: Date) => void;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(monthStart);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('calendar', scrollRef);
  const today = new Date();

  return (
    <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 12 }}
      refreshControl={refreshControl}
    >
      <View style={styles.monthHeaderRow}>
        {DAY_NAMES.map((n) => (
          <Text key={n} style={styles.monthDayHeader}>{n}</Text>
        ))}
      </View>
      <View style={styles.monthGrid}>
        {cells.map((d) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = sameDay(d, today);
          // ADR 0278 — one dot per calendar with an event that day (max 3).
          const eventColors = [
            ...new Set(
              events
                .filter((e) => sameDay(eventLocalDay(e), d))
                .map((e) => calendarHex(e.color) ?? colors.accent),
            ),
          ].slice(0, 3);
          const hasTrip = trips.some((t) => withinTrip(t, d));
          const hasImportant = occurrences.some((o) => sameDay(o.on, d));
          return (
            <Pressable
              key={d.toISOString()}
              onPress={() => onPickDay(d)}
              style={[styles.monthCell, !inMonth && styles.monthCellMuted]}
            >
              <View style={[styles.monthDayNum, isToday && styles.monthDayNumToday]}>
                <Text style={[styles.monthDayNumTxt, isToday && styles.monthDayNumTxtToday]}>
                  {d.getDate()}
                </Text>
              </View>
              <View style={styles.monthDots}>
                {eventColors.map((c) => (
                  <View key={c} style={[styles.monthDot, { backgroundColor: c }]} />
                ))}
                {hasTrip && <View style={[styles.monthDot, { backgroundColor: tripOrange() }]} />}
                {hasImportant && <View style={[styles.monthDot, { backgroundColor: importantPink() }]} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

// ── Event + trip rendering ───────────────────────────────────────────

/** Valid 6-digit hex from a calendar source, or null (→ accent fallback). */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
function calendarHex(c: string | null | undefined): string | null {
  return c && HEX6_RE.test(c) ? c : null;
}

/** ADR 0331 — "Tue, Nov 10 · 3:30 – 4:00 PM", or the date alone when all day. */
function eventWhenLabel(e: GroupEvent): string {
  const start = parseIso(e.startsAt);
  const day = (d: Date) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isAllDayEvent(e)) return `${day(start)} · All day`;
  if (!e.endsAt) return `${day(start)} · ${time(start)}`;
  const end = parseIso(e.endsAt);
  return day(end) === day(start)
    ? `${day(start)} · ${time(start)} – ${time(end)}`
    : `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
}

/** ADR 0278 — what calendar an event is on, as people read it. */
function calendarNameOf(e: Pick<GroupEvent, 'calendarName'>): string {
  if (!e.calendarName) return 'Chord only (no synced calendar)';
  // An Outlook default is named "Calendar"; don't say "Calendar (Outlook) calendar".
  return /\bcalendar\b/i.test(e.calendarName) ? e.calendarName : `${e.calendarName} calendar`;
}

/** ADR 0289 — "Part of the Chicago trip · Ben Doe travelling"; null when
 *  the entry is not part of a trip. */
function tripLineOf(e: Pick<GroupEvent, 'tripName' | 'tripTravelers'>): string | null {
  if (!e.tripName) return null;
  const who = e.tripTravelers?.length ? ` · ${e.tripTravelers.join(', ')} travelling` : '';
  return `✈️ Part of the ${e.tripName} trip${who}`;
}

/**
 * ADR 0278 — the browser's own hover tooltip on web. React Native Web renders
 * a Pressable as a div but drops a `title` prop, so it is set on the element.
 */
function useWebTitle(ref: RefObject<View | null>, text: string): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = ref.current as unknown as HTMLElement | null;
    el?.setAttribute?.('title', text);
  }, [ref, text]);
}

function EventBlock({
  event,
  compact,
  date,
  place,
  onPress,
}: {
  event: GroupEvent;
  compact?: boolean;
  /** The day this block is being rendered into; needed to clip multi-day events. */
  date: Date;
  place?: DayBlockPlacement;
  /** Tap-to-edit (ADR 0072); omitted where the block is display-only. */
  onPress?: () => void;
}) {
  const start = parseIso(event.startsAt);
  // PR-B.1 - honor endsAt when present, fall back to a 30-minute block when
  // missing. Multi-day events get clipped to the visible day so the block
  // doesn't overflow the column.
  const end = event.endsAt
    ? parseIso(event.endsAt)
    : new Date(start.getTime() + 30 * 60 * 1000);
  const { top, height } = clipBlockToDay(start, end, date);
  const laneStyle = placeStyle(place, compact);
  // Tiny events (< SHORT_BLOCK_PX) get a minimum vertical slot so their title
  // stays readable, visually extending past their true end-time.
  const isTiny = height < SHORT_BLOCK_PX;
  const renderedHeight = isTiny ? SHORT_BLOCK_PX : height;
  // A block needs ~TWO_LINE_PX to fit the title + meta rows; below that the
  // two-line layout clips at the bottom (overflow:hidden). Collapse to a
  // single time-prefixed line instead. Multi-day columns (compact) show no
  // meta, so there only the tiny-pill case applies.
  const singleLine = compact ? isTiny : renderedHeight < TWO_LINE_PX;
  const isOpen = event.transparency === 'transparent';
  const timeLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // By-calendar color (ADR 0072): stripe in the source calendar's color with a
  // light tint fill; Chord-native events keep the accent. The tint is mixed
  // onto the card colour so a block drawn over another hides what is under it.
  const hex = calendarHex(event.color);
  const colorStyle = hex
    ? { borderLeftColor: hex, borderLeftWidth: 4, backgroundColor: tintOnCard(hex) }
    : null;
  // A narrow block wraps its title over as many lines as its height allows,
  // the way Apple's grid does, instead of one clipped line.
  const titleLines = singleLine ? 1 : compact ? linesFor(renderedHeight - 6) : linesFor(renderedHeight - 30);
  const endLabel = event.endsAt
    ? `–${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : '';
  const tripLine = tripLineOf(event);
  const hoverText = `${shownTitle(event)}\n${timeLabel}${endLabel}\n${calendarNameOf(event)}${tripLine ? `\n${tripLine}` : ''}`;
  const blockRef = useRef<View>(null);
  useWebTitle(blockRef, hoverText);
  return (
    <Pressable
      ref={blockRef}
      accessibilityLabel={hoverText.replace(/\n/g, ', ')}
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.eventBlock,
        { top, height: renderedHeight },
        compact && styles.eventBlockCompact,
        singleLine && styles.eventBlockShort,
        isOpen && styles.eventBlockOpen,
        colorStyle,
        laneStyle,
      ]}
    >
      <Text
        style={[styles.eventTitle, compact && styles.eventTitleCompact, singleLine && styles.eventTitleShort]}
        numberOfLines={titleLines}
      >
        {singleLine ? `${timeLabel} · ${shownTitle(event)}` : shownTitle(event)}
      </Text>
      {!compact && !singleLine && (
        <Text style={styles.eventMeta} numberOfLines={1}>
          {timeLabel}
          {endLabel}
          {event.location ? ` · ${event.location}` : ''}
        </Text>
      )}
    </Pressable>
  );
}

function clipBlockToDay(start: Date, end: Date, date: Date) {
  return clipBlockToDayShared(start, end, date, HOUR_HEIGHT);
}

/**
 * A phone-only event, drawn dashed + muted so it reads as context rather than
 * a Chord event. Tapping explains where it lives and how to bring it in.
 */
function GhostBlock({
  ghost,
  date,
  place,
}: {
  ghost: DeviceGhostEvent;
  date: Date;
  place?: DayBlockPlacement;
}) {
  const start = parseIso(ghost.startsAt);
  const end = ghost.endsAt
    ? parseIso(ghost.endsAt)
    : new Date(start.getTime() + 30 * 60 * 1000);
  const { top, height } = clipBlockToDay(start, end, date);
  const laneStyle = placeStyle(place, false);
  const isTiny = height < SHORT_BLOCK_PX;
  const renderedHeight = isTiny ? SHORT_BLOCK_PX : height;
  const singleLine = renderedHeight < TWO_LINE_PX;
  const timeLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const explain = () => {
    const range = `${timeLabel}–${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const body = `${range}${ghost.calendarTitle ? ` · ${ghost.calendarTitle}` : ''}\n\nThis lives on a phone calendar Chord doesn't mirror - shown here for context, never uploaded. Turn on Mirror for "${ghost.calendarTitle || 'that calendar'}" in Settings → Calendars to make it a full Chord event.`;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.alert(`${ghost.title}\n\n${body}`);
      return;
    }
    Alert.alert(ghost.title, body);
  };
  const ghostHex = calendarHex(ghost.calendarColor);
  return (
    <Pressable
      onPress={explain}
      style={[
        styles.eventBlock,
        styles.ghostBlock,
        { top, height: renderedHeight },
        ghostHex ? { borderColor: ghostHex, borderLeftColor: ghostHex } : null,
        singleLine && styles.eventBlockShort,
        laneStyle,
      ]}
    >
      <Text style={[styles.ghostTitle, singleLine && styles.eventTitleShort]} numberOfLines={1}>
        {singleLine ? `${timeLabel} · ${ghost.title}` : ghost.title}
      </Text>
      {!singleLine && (
        <Text style={styles.ghostMeta} numberOfLines={1}>
          {timeLabel} · {ghost.calendarTitle || 'phone'} 📱
        </Text>
      )}
    </Pressable>
  );
}

/**
 * PR-B.1 - render a TravelLeg as an event-shaped block in the hour grid.
 * Carrier + flight number drives the title (e.g. "AA 412"); origin → dest
 * goes in the meta line. Departure determines the start; arrival
 * determines the height (clipped to the visible day for red-eyes).
 */
function LegBlock({
  leg,
  compact,
  date,
  place,
}: {
  leg: TravelLeg;
  compact?: boolean;
  date: Date;
  place?: DayBlockPlacement;
}) {
  const depart = parseIso(leg.departAt);
  const arrive = parseIso(leg.arriveAt);
  const { top, height } = clipBlockToDay(depart, arrive, date);
  const carrier = [leg.carrier, leg.flightNo].filter(Boolean).join(' ').trim();
  const title = carrier || `${modeIcon(leg.mode)} ${leg.origin} → ${leg.destination}`;
  const pax = formatPassengers(leg.passengers);
  const laneStyle = placeStyle(place, compact);
  const isTiny = height < SHORT_BLOCK_PX;
  const renderedHeight = isTiny ? SHORT_BLOCK_PX : height;
  // Mirror EventBlock: collapse to a single line when the block is too short
  // to fit title + meta without clipping.
  const singleLine = compact ? isTiny : renderedHeight < TWO_LINE_PX;
  const titleLines = singleLine ? 1 : compact ? linesFor(renderedHeight - 6) : 1;
  return (
    <View
      style={[
        styles.eventBlock,
        styles.legBlock,
        { top, height: renderedHeight },
        compact && styles.eventBlockCompact,
        singleLine && styles.eventBlockShort,
        laneStyle,
      ]}
    >
      <Text style={[styles.eventTitle, compact && styles.eventTitleCompact, singleLine && styles.eventTitleShort]} numberOfLines={titleLines}>
        {modeIcon(leg.mode)} {title}
      </Text>
      {!compact && !singleLine && (
        <Text style={styles.eventMeta} numberOfLines={1}>
          {leg.origin} → {leg.destination}
          {' · '}
          {depart.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          –{arrive.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          {pax ? ` · ${pax}` : ''}
        </Text>
      )}
    </View>
  );
}

/** Render passenger names compactly: up to two names, then "+N". */
function formatPassengers(names?: string[]): string | null {
  if (!names || names.length === 0) return null;
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]}, +${names.length - 2}`;
}

function modeIcon(mode: TravelLeg['mode']): string {
  switch (mode) {
    case 'flight': return '✈';
    case 'train': return '🚆';
    case 'car': return '🚗';
    case 'ferry': return '⛴';
    default: return '·';
  }
}

/** The day's legs minus those already on the calendar as their own event. */
function legsForDay(trips: TripStatus[], date: Date, events: GroupEvent[]): TravelLeg[] {
  return legsNotOnCalendar(legsForDayShared(trips, date), events);
}

function ImportantBands({ occurrences }: { occurrences: ImportantOccurrence[] }) {
  if (occurrences.length === 0) return null;
  return (
    <View style={styles.importantBandWrap}>
      {occurrences.map((o) => (
        <View key={o.id} style={styles.importantBand}>
          <Text style={styles.importantBandTxt} numberOfLines={1}>
            {kindEmoji(o.kind)} {o.personName}
            <Text style={styles.importantBandSub}>  · {kindLabel(o.kind)}</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

function WeekImportantStrip({
  days,
  occurrences,
}: {
  days: Date[];
  occurrences: ImportantOccurrence[];
}) {
  const byDay = days.map((d) => occurrences.filter((o) => sameDay(o.on, d)));
  if (byDay.every((arr) => arr.length === 0)) return null;
  return (
    <View style={styles.weekImportantRow}>
      <View style={styles.weekHourGutter} />
      {byDay.map((dayOccs, i) => (
        <View key={i} style={styles.weekImportantCell}>
          {dayOccs.slice(0, 2).map((o) => (
            <Text key={o.id} style={styles.weekImportantTxt} numberOfLines={1}>
              {kindEmoji(o.kind)} {o.personName.split(' ')[0]}
            </Text>
          ))}
          {dayOccs.length > 2 && (
            <Text style={styles.weekImportantTxt}>+{dayOccs.length - 2}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

function kindEmoji(k: ImportantDateKind): string {
  switch (k) {
    case 'birthday': return '🎂';
    case 'anniversary': return '💍';
    case 'death': return '🕯';
    default: return '★';
  }
}
function kindLabel(k: ImportantDateKind): string {
  switch (k) {
    case 'birthday': return 'birthday';
    case 'anniversary': return 'anniversary';
    case 'death': return 'remembrance';
    default: return 'important day';
  }
}

function AllDayStrip({ events }: { events: GroupEvent[] }) {
  if (events.length === 0) return null;
  return (
    <View style={styles.allDayStrip}>
      <Text style={styles.allDayLabel}>All Day</Text>
      {events.map((e) => {
        const isOpen = e.transparency === 'transparent';
        return (
          <View key={e.id} style={[styles.allDayPill, isOpen && styles.allDayPillOpen]}>
            <Text style={styles.allDayPillTxt} numberOfLines={1}>
              {shownTitle(e)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function WeekAllDayStrip({ days, events }: { days: Date[]; events: GroupEvent[] }) {
  const perDay = days.map((d) => filterEventsForDay(events, d).filter(isAllDayEvent));
  if (perDay.every((list) => list.length === 0)) return null;
  return (
    <View style={styles.weekAllDayRow}>
      <View style={styles.weekAllDayGutter}>
        <Text style={styles.weekAllDayGutterTxt}>all day</Text>
      </View>
      {perDay.map((list, idx) => (
        <View
          key={idx}
          style={[styles.weekAllDayCell, idx === days.length - 1 && { borderRightWidth: 0 }]}
        >
          {list.map((e) => {
            const isOpen = e.transparency === 'transparent';
            return (
              <View key={e.id} style={[styles.allDayPill, isOpen && styles.allDayPillOpen]}>
                <Text style={styles.weekAllDayPillTxt} numberOfLines={1}>
                  {shownTitle(e)}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function TripBands({ trips }: { trips: TripBand[] }) {
  if (trips.length === 0) return null;
  return (
    <View style={styles.tripBandWrap}>
      {trips.map((t) => (
        <View key={t.tripId} style={styles.tripBand}>
          <Text style={styles.tripBandTxt} numberOfLines={1}>
            ✈ {t.title}{t.destination ? ` · ${t.destination}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function WeekTripBands({ days, trips }: { days: Date[]; trips: TripBand[] }) {
  const active = trips.filter((t) => days.some((d) => withinTrip(t, d)));
  if (active.length === 0) return null;
  return (
    <View style={styles.weekTripBandWrap}>
      {active.map((t) => {
        const startIdx = days.findIndex((d) => withinTrip(t, d));
        const endIdx = days.length - 1 - [...days].reverse().findIndex((d) => withinTrip(t, d));
        const span = endIdx - startIdx + 1;
        return (
          <View key={t.tripId} style={styles.weekTripBandRow}>
            <View style={styles.weekHourGutter} />
            <View style={{ flex: startIdx, flexDirection: 'row' }} />
            <View style={[styles.weekTripBand, { flex: span }]}>
              <Text style={styles.weekTripBandTxt} numberOfLines={1}>✈ {t.title}</Text>
            </View>
            <View style={{ flex: days.length - 1 - endIdx }} />
          </View>
        );
      })}
    </View>
  );
}

// ── Date helpers ─────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
  const day = d.getDay();
  return addDays(startOfDay(d), -day); // Sunday-start
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}
function parseIso(iso: string): Date {
  return new Date(iso);
}
function parseDateOnly(iso: string): Date {
  // 'YYYY-MM-DD' - anchor at local midnight to avoid TZ offset surprises.
  const [y, m, day] = iso.split('-').map((s) => Number.parseInt(s, 10));
  return new Date(y!, m! - 1, day!);
}
function withinTrip(t: TripBand, d: Date): boolean {
  const day = startOfDay(d).getTime();
  return day >= t.start.getTime() && day <= t.end.getTime();
}
/**
 * The local day an event belongs on. All-day events are floating dates -
 * the server stores them as `YYYY-MM-DDT00:00:00Z` (UTC midnight), which in a
 * negative-offset zone parses to the *previous* evening. Bucket those by their
 * calendar-date component at LOCAL midnight so they show on the right day in
 * every timezone. Timed events keep their absolute instant.
 */
function eventLocalDay(e: GroupEvent): Date {
  if (isAllDayEvent(e)) return parseDateOnly(e.startsAt.slice(0, 10));
  return parseIso(e.startsAt);
}
/** ADR 0217 — a repeating event says so, so the family can tell a series
 *  from a one-off without opening it. */
function shownTitle(e: Pick<GroupEvent, 'title' | 'seriesId'>): string {
  return e.seriesId ? `${e.title} ↻` : e.title;
}

function filterEventsForDay(events: GroupEvent[], d: Date): GroupEvent[] {
  return events.filter((e) => sameDay(eventLocalDay(e), d));
}

/**
 * Detect an "all-day" event. Both Google's `DATE` (all-day) and our local
 * 23:59-end events end up here; the threshold (≥ 20h) is conservative
 * enough that a normal "long evening" still renders in the hour grid.
 */
function isAllDayEvent(e: GroupEvent): boolean {
  if (!e.endsAt) return false;
  const start = parseIso(e.startsAt).getTime();
  const end = parseIso(e.endsAt).getTime();
  return end - start >= 20 * 60 * 60 * 1000;
}

/** One thing drawn in a day column, placed by `layoutDayBlocks`. */
type PlacedBlock =
  | { key: string; kind: 'event'; event: GroupEvent; place?: DayBlockPlacement }
  | { key: string; kind: 'ghost'; ghost: DeviceGhostEvent; place?: DayBlockPlacement }
  | { key: string; kind: 'leg'; leg: TravelLeg; place?: DayBlockPlacement };

/**
 * One layout pass over everything drawn in a day column, returned lowest layer
 * first so a block drawn over another also renders after it (Android stacks
 * by order). Keys are prefixed by kind because an event, a phone-only ghost
 * and a travel leg come from different tables and their ids can collide.
 */
function dayBlocks(
  events: GroupEvent[],
  legs: TravelLeg[],
  ghosts: DeviceGhostEvent[],
  width: number,
): PlacedBlock[] {
  const blocks: PlacedBlock[] = [
    ...events.map((event) => ({ key: `ev:${event.id}`, kind: 'event' as const, event })),
    ...ghosts.map((ghost) => ({ key: `ghost:${ghost.id}`, kind: 'ghost' as const, ghost })),
    ...legs.map((leg) => ({ key: `leg:${leg.id}`, kind: 'leg' as const, leg })),
  ];
  const places = layoutDayBlocks(
    blocks.map((b) =>
      b.kind === 'event'
        ? { id: b.key, startsAt: b.event.startsAt, endsAt: b.event.endsAt }
        : b.kind === 'ghost'
          ? { id: b.key, startsAt: b.ghost.startsAt, endsAt: b.ghost.endsAt }
          : { id: b.key, startsAt: b.leg.departAt, endsAt: b.leg.arriveAt },
    ),
    { width, minVisibleMs: MIN_VISIBLE_MS, indent: BLOCK_INDENT_PX },
  );
  for (const b of blocks) b.place = places.get(b.key);
  return blocks.sort((a, b) => (a.place?.z ?? 0) - (b.place?.z ?? 0));
}

function DayBlock({
  block,
  compact,
  date,
  onEditEvent,
}: {
  block: PlacedBlock;
  compact?: boolean;
  date: Date;
  onEditEvent: (e: GroupEvent) => void;
}) {
  if (block.kind === 'event') {
    const ev = block.event;
    return (
      <EventBlock
        event={ev}
        compact={compact}
        date={date}
        place={block.place}
        onPress={() => onEditEvent(ev)}
      />
    );
  }
  if (block.kind === 'ghost') return <GhostBlock ghost={block.ghost} date={date} place={block.place} />;
  return <LegBlock leg={block.leg} compact={compact} date={date} place={block.place} />;
}

/** How far a block drawn over an earlier one is indented from it. */
const BLOCK_INDENT_PX = 10;

/**
 * Pixel placement for a block. The base `eventBlock` style spans the whole
 * event area; a placement narrows it. Blocks start at HOUR_GUTTER_WIDTH + 4
 * in the single-day view and at 2 (`eventBlockCompact`) in multi-day columns.
 * A block drawn over another gets a card-coloured outline so the two edges
 * read apart, and a higher zIndex (iOS + web stack by it).
 */
function placeStyle(
  place: DayBlockPlacement | undefined,
  compact: boolean | undefined,
): Record<string, number | string | undefined> | null {
  if (!place) return null;
  const left = (compact ? 2 : HOUR_GUTTER_WIDTH + 4) + place.left;
  const style: Record<string, number | string | undefined> = {
    left,
    right: undefined,
    width: Math.max(0, place.width - 1),
  };
  if (place.z > 0) {
    style.zIndex = 10 + place.z;
    style.borderTopWidth = 1;
    style.borderRightWidth = 1;
    style.borderBottomWidth = 1;
    style.borderTopColor = colors.card;
    style.borderRightColor = colors.card;
    style.borderBottomColor = colors.card;
  }
  return style;
}

/** Title lines that fit in `px` of block height. */
function linesFor(px: number): number {
  return Math.max(1, Math.floor(px / 14));
}

/**
 * A calendar colour mixed at ~22% onto the card colour: the same look as the
 * old translucent fill, but opaque, so a block drawn over another hides it.
 */
function tintOnCard(hex: string): string {
  const card = colors.card;
  if (!HEX6_RE.test(card)) return `${hex}38`;
  const mix = (i: number) => {
    const a = Number.parseInt(hex.slice(i, i + 2), 16);
    const b = Number.parseInt(card.slice(i, i + 2), 16);
    return Math.round(b + (a - b) * 0.22).toString(16).padStart(2, '0');
  };
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

/**
 * Width blocks can use in a day column. `measured` is the column's real width
 * from onLayout. The window-based estimate is only the fallback before the
 * first layout: it counts the web scrollbar (so the last block spilled past
 * the grid) and reads 0 when a web page loads hidden.
 */
function laneArea(measured: number, compact: boolean, columns = 1): number {
  if (measured > 0) {
    return Math.max(0, compact ? measured - 4 : measured - HOUR_GUTTER_WIDTH - 12);
  }
  const winWidth = Dimensions.get('window').width;
  return compact
    ? Math.max(0, (winWidth - HOUR_GUTTER_WIDTH) / columns - 4)
    : Math.max(0, winWidth - HOUR_GUTTER_WIDTH - 12);
}

/**
 * Project ImportantDay rows into concrete dated occurrences inside the
 * window the current view is showing. Recurring entries fire once in
 * the visible year; non-recurring fire only on their stored date.
 *
 * Window is wide enough for the visible month grid (which can extend a
 * week before / after the cursor month). Day/Week views land entirely
 * inside the month grid window so this covers all three.
 */
function computeOccurrences(
  rows: ImportantDay[],
  cursor: Date,
): ImportantOccurrence[] {
  // The neighbouring years too: a month grid spills into them, and a list or
  // multi-day span can run past New Year.
  const anchorYear = cursor.getFullYear();
  const years = [anchorYear - 1, anchorYear, anchorYear + 1];
  const out: ImportantOccurrence[] = [];
  for (const r of rows) {
    const [yStr, mStr, dStr] = r.date.split('-');
    const m = Number.parseInt(mStr ?? '', 10);
    const d = Number.parseInt(dStr ?? '', 10);
    if (!m || !d) continue;
    if (r.recurs || yStr === '0000') {
      for (const y of years) {
        out.push({
          id: `${r.id}@${y}`,
          personName: r.personName,
          kind: r.kind,
          on: new Date(y, m - 1, d),
        });
      }
    } else {
      const y = Number.parseInt(yStr ?? '', 10);
      if (!y) continue;
      out.push({
        id: r.id,
        personName: r.personName,
        kind: r.kind,
        on: new Date(y, m - 1, d),
      });
    }
  }
  return out;
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return 'Noon';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

// ── Styles ───────────────────────────────────────────────────────────

const HOUR_GUTTER_WIDTH = 56;
/**
 * Minimum vertical slot for an event block. Sub-30-min events (1, 5, 15 min)
 * have a natural height below this and would clip their title; we render
 * them at this height (visually extending past their true end time) with a
 * single-line title prefixed by the start time so the label stays legible.
 */
const SHORT_BLOCK_PX = 22;
/** SHORT_BLOCK_PX as time: the extent a stretched short block is drawn at, which
 *  is what overlap has to be judged on. */
const MIN_VISIBLE_MS = (SHORT_BLOCK_PX / HOUR_HEIGHT) * 60 * 60 * 1000;
/**
 * Height (px) below which an event/leg block can't fit its title + meta rows
 * without clipping (padding 6+6 + ~16px title + ~17px meta ≈ 45px). Shorter
 * day-view blocks collapse to a single time-prefixed line instead.
 */
const TWO_LINE_PX = 46;
const tripOrange = () => byScheme('#E07A1F', '#F59E4B');
const tripOrangeLight = () => byScheme('#FCE9D5', '#3A2614');
const importantPink = () => byScheme('#BE185D', '#F472B6');
const importantPinkLight = () => byScheme('#FCE7F3', '#3A1729');

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },

  suggestWrap: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.accentLight,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
  },
  suggestHeadRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  suggestHead: { color: colors.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  suggestRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  suggestTitle: { color: colors.text, fontSize: 14, fontWeight: '500' },
  suggestTitleLink: { textDecorationLine: 'underline', textDecorationColor: colors.border },
  suggestSub: { color: colors.muted, fontSize: 12, marginTop: 1 },
  suggestDest: { color: colors.accent, fontSize: 11, fontWeight: '600', marginTop: 1 },
  suggestBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  suggestConfirm: { backgroundColor: colors.accent, borderColor: colors.accent },
  suggestConfirmTxt: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  suggestDismissTxt: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  suggestBtnBusy: { opacity: 0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  err: { color: colors.red, padding: 12 },

  header: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerLabel: { color: colors.text, fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center' },
  navBtn: { paddingHorizontal: 6 },
  navTxt: { color: colors.accent, fontSize: 26, lineHeight: 28 },
  todayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.accentLight,
  },
  todayTxt: { color: colors.accent, fontWeight: '600', fontSize: 12 },

  viewBtn: {
    width: 34,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentLight,
  },
  menuScrim: { flex: 1 },
  menu: {
    position: 'absolute',
    minWidth: 200,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingRight: 16,
    paddingLeft: 6,
  },
  menuRowPressed: { backgroundColor: colors.bg2 },
  menuCheck: { width: 22, alignItems: 'center' },
  menuTxt: { color: colors.text, fontSize: 15 },

  // List view
  listContent: { paddingHorizontal: 12, paddingBottom: 24 },
  listEmpty: { color: colors.muted, textAlign: 'center', paddingVertical: 32 },
  listSection: { paddingTop: 14 },
  listDay: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  listDayToday: { color: colors.red },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  listBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  listMain: { flex: 1, minWidth: 0 },
  listTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  listTitleOpen: { color: colors.muted },
  listSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  listTimes: { alignItems: 'flex-end' },
  listTime: { color: colors.text, fontSize: 13 },
  listEndTime: { color: colors.muted, fontSize: 13, marginTop: 2 },
  listMore: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 20 },
  listMoreTxt: { color: colors.accent, fontWeight: '600' },

  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  chipTxt: { fontSize: 11, fontWeight: '600', color: colors.muted },
  chipTxtActive: { color: colors.accent },

  // Day view
  hourCol: {
    paddingLeft: HOUR_GUTTER_WIDTH,
    paddingRight: 12,
    paddingTop: 4,
    backgroundColor: colors.card,
  },
  hourRow: { position: 'absolute', left: 0, right: 12 },
  hourLabel: {
    position: 'absolute',
    left: 8,
    top: -7,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    width: HOUR_GUTTER_WIDTH - 16,
  },
  hourLine: {
    marginLeft: HOUR_GUTTER_WIDTH,
    height: 1,
    backgroundColor: colors.border,
  },

  // Event block (positioned absolutely inside hour column)
  eventBlock: {
    position: 'absolute',
    left: HOUR_GUTTER_WIDTH + 4,
    right: 8,
    backgroundColor: colors.accentLight,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 6,
    padding: 6,
    overflow: 'hidden',
  },
  eventBlockCompact: { left: 2, right: 2, padding: 3 },
  // Sub-30-min events get a pill-like single-line block.
  eventBlockShort: { padding: 2, paddingHorizontal: 6, justifyContent: 'center' },
  eventTitleShort: { fontSize: 10, fontWeight: '600' },
  // ADR 0033 - informational ("show me as free") events get a faded fill +
  // dashed left border + reduced opacity to visually separate from blocking
  // events. Still tappable, still legible.
  eventBlockOpen: {
    backgroundColor: 'transparent',
    borderStyle: 'dotted',
    borderColor: colors.muted,
    borderWidth: 1,
    opacity: 0.7,
  },
  // All-day strip rendered above the hour grid.
  allDayStrip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    flexWrap: 'wrap',
  },
  allDayLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginRight: 6,
    paddingTop: 3,
  },
  allDayPill: {
    backgroundColor: colors.accentLight,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: '100%',
  },
  allDayPillOpen: {
    backgroundColor: 'transparent',
    borderStyle: 'dotted',
    borderColor: colors.muted,
    borderWidth: 1,
    opacity: 0.7,
  },
  allDayPillTxt: { fontSize: 12, color: colors.accentDark, fontWeight: '600' },
  weekAllDayRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 22,
  },
  weekAllDayGutter: { width: HOUR_GUTTER_WIDTH, justifyContent: 'center', paddingLeft: 8 },
  weekAllDayGutterTxt: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  weekAllDayCell: {
    flex: 1,
    paddingHorizontal: 2,
    paddingVertical: 2,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    gap: 2,
  },
  weekAllDayPillTxt: { fontSize: 10, color: colors.accentDark, fontWeight: '600' },
  legBlock: {
    backgroundColor: byScheme('#FFF1E0', '#3A2614'),
    borderColor: tripOrange(),
  },
  eventTitle: { color: colors.accentDark, fontSize: 12, fontWeight: '700' },
  eventTitleCompact: { fontSize: 10 },
  eventMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  // Phone-only ghost events: dashed outline, no fill, muted text.
  ghostBlock: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.muted,
    borderLeftWidth: 1,
    borderLeftColor: colors.muted,
  },
  ghostTitle: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  ghostMeta: { color: colors.muted, fontSize: 10, marginTop: 1 },

  // Trip band (day view)
  tripBandWrap: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 4,
    paddingHorizontal: 12,
    gap: 4,
  },
  tripBand: {
    backgroundColor: tripOrangeLight(),
    borderLeftWidth: 3,
    borderLeftColor: tripOrange(),
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tripBandTxt: { color: tripOrange(), fontSize: 12, fontWeight: '700' },

  // Important-day band (day view)
  importantBandWrap: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 4,
    paddingHorizontal: 12,
    gap: 4,
  },
  importantBand: {
    backgroundColor: importantPinkLight(),
    borderLeftWidth: 3,
    borderLeftColor: importantPink(),
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  importantBandTxt: { color: importantPink(), fontSize: 12, fontWeight: '700' },
  importantBandSub: { color: importantPink(), fontSize: 11, fontWeight: '400' },

  // Important-day strip (week view, under day-of-week numbers)
  weekImportantRow: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 4,
  },
  weekImportantCell: {
    flex: 1,
    paddingHorizontal: 1,
    gap: 1,
  },
  weekImportantTxt: {
    color: importantPink(),
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'center',
  },

  // Now-line
  nowLine: { position: 'absolute', left: HOUR_GUTTER_WIDTH, right: 12, height: 0 },
  nowDot: {
    position: 'absolute',
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.red,
  },
  nowBar: { height: 1, backgroundColor: colors.red },

  // Week view
  weekHeader: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 6,
  },
  weekHourGutter: { width: HOUR_GUTTER_WIDTH },
  weekHourLabel: {
    position: 'absolute',
    left: 8,
    top: -7,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
  },
  weekDayCell: { flex: 1, alignItems: 'center', gap: 2 },
  weekDayName: { color: colors.muted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  weekDayNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekDayNumToday: { backgroundColor: colors.accent },
  weekDayNumTxt: { color: colors.text, fontSize: 14, fontWeight: '700' },
  weekDayNumTxtToday: { color: colors.onAccent },

  weekTripBandWrap: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 4,
    gap: 3,
  },
  weekTripBandRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 0 },
  weekTripBand: {
    backgroundColor: tripOrangeLight(),
    borderLeftWidth: 3,
    borderLeftColor: tripOrange(),
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginHorizontal: 1,
  },
  weekTripBandTxt: { color: tripOrange(), fontSize: 10, fontWeight: '700' },

  weekGrid: {
    flexDirection: 'row',
    backgroundColor: colors.card,
  },
  weekColumn: {
    flex: 1,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    position: 'relative',
  },
  weekHourCell: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.border,
  },

  // Month view
  monthHeaderRow: { flexDirection: 'row', paddingBottom: 6 },
  monthDayHeader: {
    flex: 1,
    textAlign: 'center',
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.card,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  monthCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingTop: 6,
    alignItems: 'center',
  },
  monthCellMuted: { backgroundColor: colors.bg },
  monthDayNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthDayNumToday: { backgroundColor: colors.accent },
  monthDayNumTxt: { color: colors.text, fontSize: 13, fontWeight: '600' },
  monthDayNumTxtToday: { color: colors.onAccent },
  monthDots: { flexDirection: 'row', gap: 2, marginTop: 4, height: 4 },
  monthDot: { width: 4, height: 4, borderRadius: 2 },
}));
