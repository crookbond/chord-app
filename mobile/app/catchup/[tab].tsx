import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardModalBody, KeyboardScrollView, DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import type {
  Accommodation,
  Attachment,
  EmailReceiptsOverview,
  List,
  ListItem,
  Memory,
  Proposal,
  RouteSuggestion,
  Save,
  Task,
  TravelLeg,
  TripReservation,
  TripSourceLinks,
  TripStatus,
  UpdateSaveRequest,
  UpdateTaskRequest,
} from '@chord/kernel';
import { applyPendingProposalAnswers, recommendedRsvp, SUGGEST_ANOTHER_TIME, createKeyedLatestGuard, describeRecipients, findingsQuestions, flightTrackingUrl, opensInFileViewer, sameMetro, showSavedThenFresh, suggestionWhen, topShops } from '@chord/kernel';
import {
  clusterProposalsBySource,
  decisionProposalIds,
  proposalDecisions,
  type ProposalDecision,
  listKindLabel,
  listNameKey,
  normalizeText,
  saveKindForListName,
  saveTagForListName,
  LIST_ITEM_TEXT_MAX,
  isTripArchived,
  isTaskStale,
  archivedReasonText,
  isoDay,
  archivedSourceDocIds,
  applyPendingTodoOps,
  type TodoOp,
} from '@chord/kernel';

import {
  addEmailRoute,
  confirmMemory,
  getEmailReceipts,
  createList,
  createSave,
  deleteSave,
  deleteList,
  moveListToSaves,
  renameList,
  attachmentImageSource,
  deleteTrip,
  mergeTrips,
  unmergeTrips,
  moveAccommodation,
  moveTravelLeg,
  restoreTrip,
  updateTrip,
  removeTravelLeg,
  removeAccommodation,
  deleteFile,
  fetchAttachmentBlobUrl,
  openAttachmentFileOnWeb,
  findSourceEmailThread,
  openAttachmentNative,
  listGroups,
  rejectMemory,
  openUserStream,
  rejectProposal,
  readSavedCopy,
  rsvpProposal,
  waitForInvite,
  updateSave,
  uploadFile,
} from '@/api';
import {
  CatchupTopTabs,
  MainBottomNav,
  catchupTabLabel,
  normalizeCatchupTab,
  type CatchupTab,
} from '@/group-nav';
import { useScrollTopOnReselect } from '@/tab-reselect';
import { FindingsChat } from '@/findings-chat';
import { LocationAsk } from '@/location-ask';
import { groupChipName } from '@/names';
import { editReplyDraft, openDraftedReply, replyDraftOf } from '@/reply-draft';
import { CalendarFitNote } from '@/calendar-fit-note';
import { faviconUrl, LinkChip, openExternal, urlHost } from '@/link-chip';
import { useFocusEffect } from 'expo-router';
import { useScreenRefresh } from '@/refresh';
import { rsvpErrorText } from '@/rsvp-error';
import { useApp } from '@/store';
import { loadErrorText } from '@/network';
import {
  itemDelete,
  itemUpdate,
  newTempTodoId,
  onTodoSynced,
  queueTodo,
  taskDelete,
  taskUpdate,
  usePendingTodoOps,
  type TodoSyncPayload,
} from '@/todo-sync';
import { TodoSyncPanel } from '@/todo-sync-panel';
import { TODO_LOADERS, TODO_SAVED_NAMES } from '@/todo-copies';
import {
  answerProposal,
  onProposalAnswered,
  usePendingProposalAnswers,
} from '@/proposal-answers';
import { ProposalAnswerPanel } from '@/proposal-answer-panel';
import { byScheme, colors, themed } from '@/theme';
import { CalendarPicker } from '@/date-field';
import { confirmDestructive } from '@/confirm';
import { showAlert } from '@/alert';
import { GroupChips } from '@/group-chips';
import { CalendarChoice, needsCalendarPick } from '@/calendar-choice';
import { InviteChoice } from '@/invite-choice';
import { ReplaceChoice, needsReplacePick, replaceEventIdFor, type ReplacePick } from '@/replace-choice';
import {
  emailThreadIdOf,
  putAwayErrorText,
  putEmailAway,
  useEmailRemoveAction,
} from '@/email-remove-action';
import { PutAwayButton } from '@/email-put-away-button';
import { onSignOut } from '@/sign-out';
import { StackedCards } from '@/card-stack';
import { SwipeToDismiss } from '@/swipe-panel';
import { useAndroidBottomInset } from '@/system-bars';
import { ActionSheet, type IconName } from '@/email-reader-bar';

/**
 * Calendar-style archive (ADR 0046): archived rows render above the live ones,
 * and on open the shared ScrollView jumps down to the boundary so the archived
 * block sits just above the fold - scroll up to reveal it. Runs once per mount;
 * if the boundary can't be measured it leaves the list at the top (archived
 * visible), never crashing.
 */
function useScrollPastArchived(
  scrollRef: RefObject<ScrollView | null>,
  boundaryRef: RefObject<View | null>,
  enabled: boolean,
): void {
  const didScroll = useRef(false);
  useEffect(() => {
    if (didScroll.current || !enabled) return;
    const raf = requestAnimationFrame(() => {
      const sv = scrollRef.current;
      const boundary = boundaryRef.current;
      if (!sv || !boundary) return;
      // getScrollableNode() is the host node on both platforms (DOM node on web,
      // node handle on native) - unlike findNodeHandle, which throws on web.
      const relativeNode = sv.getScrollableNode?.() as number | undefined;
      if (relativeNode == null) return;
      try {
        boundary.measureLayout(
          relativeNode,
          (_x, y) => {
            sv.scrollTo({ y, animated: false });
            didScroll.current = true;
          },
          () => {},
        );
      } catch {
        // Measurement unsupported/failed - leave the archived block visible.
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollRef, boundaryRef, enabled]);
}

/** Enough to reverse one specific trip merge — captured from the dragged
 *  trip's own TripStatus right before the merge call, so undoing needs no
 *  extra server-side bookkeeping (see trips.service.ts's undoMergeTrips). */
interface TripUndoState {
  groupId: string;
  keepTripId: string;
  mergeTripId: string;
  legIds: string[];
  accommodationIds: string[];
  reservationIds: string[];
  keepStartDate: string;
  keepEndDate: string;
  mergedTripName: string;
  keepTripName: string;
}

interface CatchupCache {
  tasks?: Task[];
  lists?: Array<List & { items: ListItem[] }>;
  saves?: Save[];
  memories?: Memory[];
  trips?: TripStatus[];
  files?: Attachment[];
  proposals?: Proposal[];
}
type CacheKey = keyof CatchupCache;

// Module-scoped cache survives screen remounts (one per route segment),
// so switching tabs shows previous data immediately while a background
// refresh runs. 30s freshness window - within that, no refetch.
const moduleCache: CatchupCache = {};
const moduleCacheTs: Partial<Record<CacheKey, number>> = {};
/** Per key: only the newest load's answer is kept, and a local change makes
 *  an older load in flight stale (a ticked task must not come back unticked). */
const loadGuard = createKeyedLatestGuard<CacheKey>();
const CACHE_FRESH_MS = 30_000;
// The next account on this device must not open onto the last one's to-dos.
onSignOut(() => {
  for (const k of Object.keys(moduleCache) as CacheKey[]) delete moduleCache[k];
  for (const k of Object.keys(moduleCacheTs) as CacheKey[]) delete moduleCacheTs[k];
});

const TAB_DEPS: Record<CatchupTab, CacheKey[]> = {
  actions: ['proposals'],
  tasks: ['tasks', 'proposals'],
  lists: ['lists', 'proposals'],
  saves: ['saves', 'memories', 'proposals'],
  trips: ['trips', 'proposals'],
  finance: [],
  // Files needs trips too: a past trip's source documents archive with it
  // (ADR 0046), and that mapping is computed client-side from trip legs/stays.
  files: ['files', 'trips'],
};

const LOADERS = TODO_LOADERS satisfies {
  [K in CacheKey]: () => Promise<NonNullable<CatchupCache[K]>>;
};

/** A new to-do or item as it will look, before the server has it. */
function showNow(
  tasks: Task[],
  lists: Array<List & { items: ListItem[] }>,
  op: TodoOp,
  createdBy: string | null,
): { tasks: Task[]; lists: Array<List & { items: ListItem[] }> } {
  return applyPendingTodoOps(tasks, lists, [{ localId: '', op }], new Date().toISOString(), createdBy);
}

export default function PersonalScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const allGroups = useApp((s) => s.groups);
  const setGroups = useApp((s) => s.setGroups);
  const user = useApp((s) => s.user);
  const groupNames = useMemo(
    () => Object.fromEntries(allGroups.map((g) => [g.id, groupChipName(g, user)])),
    [allGroups, user],
  );
  // Personal first: every add form here starts on its first option, and the
  // chat list arrives ordered by recent activity, so without this a new to-do
  // defaulted to whichever chat was last busy. Personal is the default; a
  // shared group is a choice the user makes on the picker.
  const groupOptions = useMemo(
    () =>
      [...allGroups]
        .sort((a, b) => Number(b.kind === 'personal') - Number(a.kind === 'personal'))
        .map((g) => ({ id: g.id, name: groupChipName(g, user) })),
    [allGroups, user],
  );
  const [cache, setCache] = useState<CatchupCache>(() => ({ ...moduleCache }));
  const [err, setErr] = useState<string | null>(null);
  const selectedTab = normalizeCatchupTab(tab);
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('catchup', scrollRef);
  // Tracked so the Trips tab's drag-to-combine gesture can auto-scroll
  // near the top/bottom edge — `ScrollView.scrollTo` takes an absolute
  // offset, not a relative one, so nudging it needs to know where it
  // currently is.
  const scrollOffsetY = useRef(0);

  // Optimistic in-place patch: update the module cache and component
  // state without a server round-trip. The caller is responsible for
  // producing the new value; any subsequent loadTab() will reconcile
  // from server state.
  const patchCache = useCallback(
    <K extends CacheKey>(
      key: K,
      updater: (prev: NonNullable<CatchupCache[K]>) => NonNullable<CatchupCache[K]>,
    ) => {
      const prev = (moduleCache[key] ?? []) as NonNullable<CatchupCache[K]>;
      const next = updater(prev);
      loadGuard.invalidate(key);
      moduleCache[key] = next;
      moduleCacheTs[key] = Date.now();
      setCache((c) => ({ ...c, [key]: next }));
    },
    [],
  );

  const loadKey = useCallback(async <K extends CacheKey>(key: K) => {
    const current = loadGuard.begin(key);
    // Nothing in memory yet (a launch, or a tab never opened since): paint the
    // copy this phone saved while the server is asked, instead of a spinner.
    const firstOfLaunch = moduleCache[key] === undefined;
    try {
      await showSavedThenFresh({
        readSaved: () =>
          firstOfLaunch
            ? readSavedCopy<NonNullable<CatchupCache[K]>>(TODO_SAVED_NAMES[key])
            : Promise.resolve(null),
        fetch: () => LOADERS[key]() as Promise<NonNullable<CatchupCache[K]>>,
        show: (result, from) => {
          if (!current()) return;
          if (from === 'saved') {
            // A local change or another load got there first: keep it.
            if (moduleCache[key] !== undefined) return;
            moduleCache[key] = result;
          } else {
            moduleCache[key] = result;
            moduleCacheTs[key] = Date.now();
            setErr(null);
          }
          setCache((c) => ({ ...c, [key]: result }));
        },
      });
    } catch (e) {
      if (current()) setErr(loadErrorText(e));
    }
  }, []);

  const loadTab = useCallback(
    async (t: CatchupTab, force = false) => {
      const now = Date.now();
      await Promise.all(
        TAB_DEPS[t].map((k) => {
          const fresh = (moduleCacheTs[k] ?? 0) > now - CACHE_FRESH_MS;
          if (!force && fresh && moduleCache[k] !== undefined) return Promise.resolve();
          return loadKey(k);
        }),
      );
    },
    [loadKey],
  );

  // Refresh the active tab's data. Mutation handlers call this after a write.
  const refresh = useCallback(async () => {
    await loadTab(selectedTab, true);
  }, [selectedTab, loadTab]);

  const { refreshControl } = useScreenRefresh(refresh);

  // ADR 0311 addendum - every to-do and list change goes through the send
  // queue: sent now when it can be, else replayed when the server answers.
  const sendTodoChange = useCallback(
    async (payload: TodoSyncPayload) => {
      try {
        await queueTodo(payload);
      } catch (e) {
        setErr((e as Error).message);
        void refresh();
      }
    },
    [refresh],
  );

  // A change the server answered (now, or from the queue after reconnecting):
  // reload, so what it actually holds replaces what the phone guessed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadKey('tasks');
        void loadKey('lists');
        void loadKey('proposals');
      }, 300);
    };
    const off = onTodoSynced(reload);
    // A confirmed suggestion makes a to-do, an event or list items.
    const offAnswers = onProposalAnswered(reload);
    return () => {
      off();
      offAnswers();
      if (timer) clearTimeout(timer);
    };
  }, [loadKey]);

  useEffect(() => {
    void loadTab(selectedTab);
  }, [selectedTab, loadTab]);

  // ADR 0105 — a change made anywhere else (the web app, another phone, the
  // bot) arrives here live. The screen used to subscribe to nothing, so a task
  // ticked off on the web stayed un-ticked on the phone behind a 30s cache
  // until a pull-to-refresh or a real background round trip.
  //
  // The event says only "something in this group changed", so this refetches
  // rather than patching: the tabs read enough different shapes that a merge
  // would be its own source of drift, and a refetch is one request.
  //
  // Coalesced, because one bot turn can fire several writes in a row — and
  // `useFocusEffect` rather than `useEffect` so a screen pushed away holds no
  // socket (ADR 0082).
  //
  // The current tab is read through a ref so switching tabs does not close and
  // reopen the socket. The first open of a focus only tops up stale data (the
  // mount effect has already loaded, and a fresh cache is worth keeping); a
  // RE-open missed whatever happened while it was parked, so it forces.
  const selectedTabRef = useRef(selectedTab);
  selectedTabRef.current = selectedTab;
  useFocusEffect(
    useCallback(() => {
      let closed = false;
      let opened = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handle = openUserStream({
        onTodosChanged: () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!closed) void loadTab(selectedTabRef.current, true);
          }, 250);
        },
        onOpen: () => {
          if (closed) return;
          void loadTab(selectedTabRef.current, opened);
          opened = true;
        },
      });
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        void handle.then((s) => s.close()).catch(() => {});
      };
    }, [loadTab]),
  );

  const tabReady = TAB_DEPS[selectedTab].every((k) => cache[k] !== undefined);

  useEffect(() => {
    if (useApp.getState().groups.length > 0) return;
    // Offline with no saved copy this fails; the chips fill in on reconnect.
    listGroups().then(setGroups, () => {});
  }, [setGroups]);

  const [provenance, setProvenance] = useState<ProvenanceState | null>(null);
  const showProvenance = useCallback((label: string, raw: string) => {
    // A to-do mined from mail opens that email in Chord - trashed mail
    // included, since its thread row stays until the mailbox drops it.
    if (!raw.startsWith('gmail:')) {
      setProvenance({ label, raw });
      return;
    }
    findSourceEmailThread(raw)
      .then((threadId) => router.push(`/email/${threadId}`))
      .catch(() => setProvenance({ label, raw, emailGone: true }));
  }, []);

  // Transient "Undo" banner for accidental list-item checks. Holds the
  // pre-toggle state so a tap on Undo can put it back. Auto-dismisses
  // after 5s; only one undo target at a time (newer toggles supersede
  // older ones rather than queuing).
  const [undoToggle, setUndoToggle] = useState<{
    itemId: string;
    text: string;
    prevChecked: boolean;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleUndo = useCallback(
    (target: { itemId: string; text: string; prevChecked: boolean }) => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setUndoToggle(target);
      undoTimerRef.current = setTimeout(() => setUndoToggle(null), 5000);
    },
    [],
  );

  // Tab-level upload entry for the Files / Trips tabs (parallels the chat
  // composer's "+"). Picks a document or photo, uploads it to the chosen group,
  // and surfaces the result. The server runs indexing + the trip/content
  // auto-filer in the background on upload, so a new file shows immediately
  // while any classified trip/event lands a moment later - hence the deferred
  // second refresh. Returns the number uploaded so the caller can collapse its
  // picker UI.
  const pickAndUpload = useCallback(
    async (groupId: string, kind: 'file' | 'photo' | 'camera'): Promise<number> => {
      try {
        let assets: { uri: string; name: string; mimeType?: string; file?: Blob }[] = [];
        if (kind === 'camera') {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            setErr('Camera permission is needed to take a photo.');
            return 0;
          }
          const r = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 1,
          });
          if (r.canceled || !r.assets?.length) return 0;
          assets = r.assets.map((a, i) => {
            const ext = (a.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
            return {
              uri: a.uri,
              name: a.fileName ?? `photo-${i + 1}.${ext}`,
              mimeType: a.mimeType ?? 'image/jpeg',
              file: a.file,
            };
          });
        } else if (kind === 'photo') {
          const r = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            quality: 1,
          });
          if (r.canceled || !r.assets?.length) return 0;
          assets = r.assets.map((a, i) => {
            const ext = (a.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
            return {
              uri: a.uri,
              name: a.fileName ?? `image-${i + 1}.${ext}`,
              mimeType: a.mimeType ?? 'image/jpeg',
              file: a.file,
            };
          });
        } else {
          const r = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: true,
            multiple: true,
          });
          if (r.canceled || !r.assets?.length) return 0;
          assets = r.assets.map((a) => ({
            uri: a.uri,
            name: a.name,
            mimeType: a.mimeType,
            file: a.file,
          }));
        }
        const uploaded: Attachment[] = [];
        for (const asset of assets) {
          uploaded.push(await uploadFile(groupId, asset));
        }
        if (uploaded.length > 0) {
          // Show the new files right away; pull again shortly for any
          // background-classified trip legs / stays / events.
          patchCache('files', (xs) => [...uploaded, ...xs]);
          void refresh();
          setTimeout(() => void refresh(), 2500);
        }
        return uploaded.length;
      } catch (e) {
        setErr((e as Error).message);
        return 0;
      }
    },
    [patchCache, refresh],
  );
  const dismissUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoToggle(null);
  }, []);
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  // Sibling "Undo" banner for a mis-dropped trip merge — same shape as the
  // list-toggle one above (separate state since the payload and the tab
  // it fires from are unrelated), auto-dismisses after 8s (longer than the
  // list one: reading which two trip names got combined takes a beat).
  const [tripUndo, setTripUndo] = useState<TripUndoState | null>(null);
  const tripUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleTripUndo = useCallback((target: TripUndoState) => {
    if (tripUndoTimerRef.current) clearTimeout(tripUndoTimerRef.current);
    setTripUndo(target);
    tripUndoTimerRef.current = setTimeout(() => setTripUndo(null), 8000);
  }, []);
  const dismissTripUndo = useCallback(() => {
    if (tripUndoTimerRef.current) clearTimeout(tripUndoTimerRef.current);
    setTripUndo(null);
  }, []);
  useEffect(() => () => {
    if (tripUndoTimerRef.current) clearTimeout(tripUndoTimerRef.current);
  }, []);

  // Changes still waiting to sync, laid over the last copy from the server so
  // they survive closing the app and a reload offline.
  const pendingTodoOps = usePendingTodoOps();
  const { tasks, lists } = useMemo(
    () =>
      applyPendingTodoOps(
        cache.tasks ?? [],
        cache.lists ?? [],
        pendingTodoOps,
        new Date().toISOString(),
        user?.id ?? null,
      ),
    [cache.tasks, cache.lists, pendingTodoOps, user?.id],
  );
  const saves = cache.saves ?? [];
  const memories = cache.memories ?? [];
  const trips = cache.trips ?? [];
  const files = cache.files ?? [];
  // ✓/✕ answers still waiting to send keep their cards answered.
  const pendingAnswers = usePendingProposalAnswers();
  const proposals = useMemo(
    () => applyPendingProposalAnswers(cache.proposals ?? [], pendingAnswers),
    [cache.proposals, pendingAnswers],
  );
  // Files that are a past trip's source documents are archived with the trip
  // (ADR 0046). Computed from trip legs/stays, which the files tab now loads.
  const archivedFileIds = useMemo(() => archivedSourceDocIds(trips, isoDay(new Date())), [trips]);

  return (
    <ProvenanceCtx.Provider value={showProvenance}>
      <View style={styles.screen}>
        <Stack.Screen
          options={{
            title: catchupTabLabel(selectedTab),
            headerBackVisible: false,
          }}
        />
        <CatchupTopTabs current={selectedTab} />
        <KeyboardScrollView
          ref={scrollRef}
          style={styles.root}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          refreshControl={refreshControl}
          onScroll={(e) => { scrollOffsetY.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
        >
          {err && <Text style={styles.err}>{err}</Text>}
          {!tabReady && (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          )}

          {tabReady && selectedTab === 'actions' && <LocationAsk />}

          {tabReady && selectedTab === 'actions' && (
            <ActionItemsSection
              proposals={proposals}
              groups={groupOptions}
              onResolved={(id, status) =>
                patchCache('proposals', (xs) =>
                  xs.map((p) => (p.id === id ? { ...p, status } : p)),
                )
              }
            />
          )}

          {tabReady && selectedTab === 'finance' && (
            <FindingsSection personalGroupId={allGroups.find((g) => g.kind === 'personal')?.id ?? null} />
          )}

          {tabReady && (selectedTab === 'tasks' || selectedTab === 'lists') && <TodoSyncPanel />}

          {tabReady &&
            (selectedTab === 'actions' ||
              selectedTab === 'tasks' ||
              selectedTab === 'lists' ||
              selectedTab === 'trips') && <ProposalAnswerPanel />}

          {tabReady && selectedTab === 'tasks' && (
            <TasksSection
              tasks={tasks}
              groups={groupOptions}
              groupNames={groupNames}
              selfId={user?.id ?? null}
              proposals={proposals.filter(
                (p) => p.toolName === 'create_task' && p.status === 'pending',
              )}
              auditProposals={proposals.filter(
                (p) =>
                  p.toolName === 'create_task' &&
                  (p.status === 'rejected' || p.status === 'expired'),
              )}
              onSetStatus={async (t, nextStatus) => {
                if (t.status === nextStatus) return;
                patchCache('tasks', (xs) =>
                  xs.map((x) => (x.id === t.id ? { ...x, status: nextStatus } : x)),
                );
                await sendTodoChange(taskUpdate(t, { status: nextStatus }));
              }}
              onDelete={async (t) => {
                patchCache('tasks', (xs) => xs.filter((x) => x.id !== t.id));
                await sendTodoChange(taskDelete(t));
              }}
              onEdit={async (t, patch) => {
                patchCache('tasks', (xs) =>
                  xs.map((x) =>
                    x.id === t.id
                      ? {
                          ...x,
                          title: patch.title ?? x.title,
                          details: patch.details ?? undefined,
                          dueAt: patch.dueAt ?? undefined,
                        }
                      : x,
                  ),
                );
                // The server may change more than was sent (a dropped to-do
                // given a future due date comes back open); the reload after
                // the sync picks that up.
                const set = Object.fromEntries(
                  Object.entries(patch).filter(([, v]) => v !== undefined),
                );
                await sendTodoChange(taskUpdate(t, set));
              }}
              onCreate={async (groupId, title) => {
                const op = { type: 'task.create' as const, tempId: newTempTodoId(), groupId, title };
                // Shown at once; the reload after the sync swaps in the real one.
                patchCache('tasks', (xs) => showNow(xs, [], op, user?.id ?? null).tasks);
                await sendTodoChange({ op, label: title });
              }}
            />
          )}

          {tabReady && selectedTab === 'lists' && (
            <ListsSection
              lists={lists}
              groups={groupOptions}
              personalGroupId={allGroups.find((g) => g.kind === 'personal')?.id ?? null}
              groupNames={groupNames}
              selfId={user?.id ?? null}
              proposals={proposals.filter(
                (p) => p.toolName === 'add_list_item' && p.status === 'pending',
              )}
              auditProposals={proposals.filter(
                (p) =>
                  p.toolName === 'add_list_item' &&
                  (p.status === 'rejected' || p.status === 'expired'),
              )}
              onToggleItem={async (item, next) => {
                const prevChecked = item.checked;
                // A clustered row coerces every copy to ONE target state
                // rather than flipping each - two copies in opposite states
                // would otherwise just swap on every tap and never settle
                // (the same oscillation the Tasks fan-out avoids).
                const nextChecked = next ?? !prevChecked;
                // Server-side setItemChecked also propagates to duplicates
                // by normalized_text within the group; mirror that here so
                // the UI matches without a refetch.
                const normTarget = normalizeText(item.text);
                patchCache('lists', (ls) =>
                  ls.map((l) => ({
                    ...l,
                    items: l.items.map((it) =>
                      normalizeText(it.text) === normTarget
                        ? { ...it, checked: nextChecked }
                        : it,
                    ),
                  })),
                );
                scheduleUndo({ itemId: item.id, text: item.text, prevChecked });
                await sendTodoChange(itemUpdate(item, { checked: nextChecked }));
              }}
              onDeleteList={async (listId) => {
                patchCache('lists', (ls) => ls.filter((l) => l.id !== listId));
                try {
                  await deleteList(listId);
                } catch (e) {
                  setErr((e as Error).message);
                  void refresh();
                }
              }}
              onMoveToSaves={async (listId, name) => {
                patchCache('lists', (ls) => ls.filter((l) => l.id !== listId));
                try {
                  await moveListToSaves(listId, saveKindForListName(name));
                  void loadKey('saves');
                } catch (e) {
                  setErr((e as Error).message);
                  void refresh();
                }
              }}
              onRenameList={async (listId, name) => {
                patchCache('lists', (ls) =>
                  ls.map((l) => (l.id === listId ? { ...l, name } : l)),
                );
                try {
                  const res = await renameList(listId, name);
                  // The name collided and the lists merged: one card is gone
                  // and another absorbed its items, so the optimistic patch is
                  // now a lie. Refetch rather than try to replay the merge.
                  if (res.merged) void refresh();
                } catch (e) {
                  setErr((e as Error).message);
                  void refresh();
                }
              }}
              onDeleteItem={async (item) => {
                patchCache('lists', (ls) =>
                  ls.map((l) => ({ ...l, items: l.items.filter((it) => it.id !== item.id) })),
                );
                await sendTodoChange(itemDelete(item));
              }}
              onEditItem={async (item, text) => {
                patchCache('lists', (ls) =>
                  ls.map((l) => ({
                    ...l,
                    items: l.items.map((it) =>
                      it.id === item.id ? { ...it, text } : it,
                    ),
                  })),
                );
                await sendTodoChange(itemUpdate(item, { text }));
              }}
              onCreateList={async (groupId, name) => {
                try {
                  const created = await createList(groupId, name);
                  patchCache('lists', (ls) => [{ ...created, items: [] }, ...ls]);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              onAddItem={async (listId, text) => {
                const op = { type: 'item.add' as const, tempId: newTempTodoId(), listId, text };
                patchCache('lists', (ls) => showNow([], ls, op, user?.id ?? null).lists);
                await sendTodoChange({ op, label: text });
              }}
            />
          )}

          {tabReady && selectedTab === 'saves' && (
            <>
              <SavesSection
                saves={saves}
                groups={groupOptions}
                groupNames={groupNames}
                selfId={user?.id ?? null}
                proposals={proposals.filter(
                  (p) =>
                    (p.toolName === 'save_link' ||
                      p.toolName === 'save_place' ||
                      p.toolName === 'save_contact' ||
                      p.toolName === 'save_media') &&
                    p.status === 'pending',
                )}
                auditProposals={proposals.filter(
                  (p) =>
                    (p.toolName === 'save_link' ||
                      p.toolName === 'save_place' ||
                      p.toolName === 'save_contact' ||
                      p.toolName === 'save_media') &&
                    (p.status === 'rejected' || p.status === 'expired'),
                )}
                onCreate={async (groupId, title, url) => {
                  try {
                    const created = await createSave(groupId, {
                      kind: url ? 'link' : 'note',
                      title,
                      url,
                      tags: [],
                    });
                    patchCache('saves', (xs) => [created, ...xs]);
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
                onDelete={async (saveId) => {
                  patchCache('saves', (xs) => xs.filter((s) => s.id !== saveId));
                  try {
                    await deleteSave(saveId);
                  } catch (e) {
                    setErr((e as Error).message);
                    void refresh();
                  }
                }}
                onEdit={async (s, patch) => {
                  patchCache('saves', (xs) =>
                    xs.map((x) =>
                      x.id === s.id
                        ? {
                            ...x,
                            title: patch.title ?? x.title,
                            note: patch.note !== undefined ? patch.note || undefined : x.note,
                          }
                        : x,
                    ),
                  );
                  try {
                    await updateSave(s.id, patch);
                  } catch (e) {
                    setErr((e as Error).message);
                    void refresh();
                  }
                }}
              />
              <MemoriesSection memories={memories} currentGroupId="" />
            </>
          )}

          {tabReady && selectedTab === 'trips' && (
            <TripsSection
              trips={trips}
              proposals={proposals.filter(
                (p) =>
                  (p.toolName === 'create_trip' ||
                    p.toolName === 'add_travel_leg' ||
                    p.toolName === 'add_accommodation' ||
                    p.toolName === 'add_reservation') &&
                  p.status === 'pending',
              )}
              auditProposals={proposals.filter(
                (p) =>
                  (p.toolName === 'create_trip' ||
                    p.toolName === 'add_travel_leg' ||
                    p.toolName === 'add_accommodation' ||
                    p.toolName === 'add_reservation') &&
                  (p.status === 'rejected' || p.status === 'expired'),
              )}
              onChanged={refresh}
              scrollRef={scrollRef}
              scrollOffsetY={scrollOffsetY}
              groups={groupOptions}
              onUpload={pickAndUpload}
              onMerged={scheduleTripUndo}
            />
          )}

          {tabReady && selectedTab === 'files' && (
            <FilesSection
              files={files}
              groupNames={groupNames}
              archivedIds={archivedFileIds}
              scrollRef={scrollRef}
              groups={groupOptions}
              onUpload={pickAndUpload}
              onDelete={async (id) => {
                patchCache('files', (xs) => xs.filter((f) => f.id !== id));
                try {
                  await deleteFile(id);
                } catch (e) {
                  setErr((e as Error).message);
                  void refresh();
                }
              }}
            />
          )}

        </KeyboardScrollView>
        {undoToggle && (
          <View style={styles.undoBanner} pointerEvents="box-none">
            <View style={styles.undoCard}>
              <Text style={styles.undoText} numberOfLines={1}>
                {undoToggle.prevChecked ? 'Unchecked' : 'Checked'}: {undoToggle.text}
              </Text>
              <Pressable
                onPress={async () => {
                  const t = undoToggle;
                  dismissUndo();
                  const normTarget = normalizeText(t.text);
                  patchCache('lists', (ls) =>
                    ls.map((l) => ({
                      ...l,
                      items: l.items.map((it) =>
                        normalizeText(it.text) === normTarget
                          ? { ...it, checked: t.prevChecked }
                          : it,
                      ),
                    })),
                  );
                  await sendTodoChange({
                    op: {
                      type: 'item.update',
                      itemId: t.itemId,
                      set: { checked: t.prevChecked },
                      expected: { checked: !t.prevChecked },
                    },
                    label: t.text,
                  });
                }}
                hitSlop={8}
              >
                <Text style={styles.undoBtn}>Undo</Text>
              </Pressable>
            </View>
          </View>
        )}
        {tripUndo && (
          <View style={styles.tripUndoBanner} pointerEvents="box-none">
            <View style={styles.undoCard}>
              <Text style={styles.undoText} numberOfLines={2}>
                Merged "{tripUndo.mergedTripName}" into "{tripUndo.keepTripName}"
              </Text>
              <Pressable
                onPress={async () => {
                  const u = tripUndo;
                  dismissTripUndo();
                  try {
                    await unmergeTrips(u.groupId, u.keepTripId, {
                      mergeTripId: u.mergeTripId,
                      legIds: u.legIds,
                      accommodationIds: u.accommodationIds,
                      reservationIds: u.reservationIds,
                      keepStartDate: u.keepStartDate,
                      keepEndDate: u.keepEndDate,
                    });
                    await refresh();
                  } catch (e) {
                    showAlert('Could not undo', e instanceof Error ? e.message : 'Try again.');
                    void refresh();
                  }
                }}
                hitSlop={8}
              >
                <Text style={styles.undoBtn}>Undo</Text>
              </Pressable>
            </View>
          </View>
        )}
        <MainBottomNav current="catchup" />
        <ProvenanceModal state={provenance} onClose={() => setProvenance(null)} />
      </View>
    </ProvenanceCtx.Provider>
  );
}

// ── Provenance drill-down ────────────────────────────────────────────

interface ProvenanceShow {
  (label: string, raw: string): void;
}

const ProvenanceCtx = createContext<ProvenanceShow>(() => {});

function ProvenanceButton({
  label,
  raw,
  small,
}: {
  label: string;
  raw: string | undefined;
  small?: boolean;
}) {
  const show = useContext(ProvenanceCtx);
  if (!raw) return null;
  return (
    <Pressable
      onPress={() => show(label, raw)}
      hitSlop={8}
      style={small ? styles.provSmallBtn : styles.taskMoreBtn}
    >
      <Text style={small ? styles.provSmallTxt : styles.taskMoreTxt}>ⓘ</Text>
    </Pressable>
  );
}

/**
 * Open the source artifact (PDF / screenshot / forwarded email) an entity was
 * extracted from. On web, fetch an authed blob and open it in a new tab; the
 * tab is opened synchronously inside the click gesture so the browser doesn't
 * pop-up-block it, then pointed at the blob once fetched. On native, download
 * with auth and hand the file to the OS viewer (Quick Look / app chooser).
 */
async function openAttachmentTab(id: string, label: string, mimeType?: string): Promise<void> {
  if (Platform.OS !== 'web') {
    try {
      await openAttachmentNative({ id, filename: label, mimeType });
    } catch (err) {
      Alert.alert('Couldn’t open file', `${label}: ${(err as Error).message}`);
    }
    return;
  }
  if (typeof window === 'undefined') return;
  if (opensInFileViewer(mimeType, label, 'web')) {
    try {
      await openAttachmentFileOnWeb(id, label, mimeType);
    } catch (err) {
      window.alert(`Couldn't open ${label}: ${(err as Error).message}`);
    }
    return;
  }
  const win = window.open('', '_blank');
  try {
    const blobUrl = await fetchAttachmentBlobUrl(id);
    if (win) {
      win.location.href = blobUrl;
    } else if (typeof document !== 'undefined') {
      // Popup blocked outright - fall back to an anchor click.
      const a = document.createElement('a');
      a.href = blobUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (err) {
    win?.close();
    window.alert(`Couldn't open the source for ${label}: ${(err as Error).message}`);
  }
}

/** What a trip item was read from: a file (shown in-app when it's an image),
 *  else the email thread it was mined from (ADR 0158 — no file exists). */
interface TripSource {
  label: string;
  docId?: string;
  doc?: TripSourceLinks['sourceDoc'];
  emailThreadId?: string;
}

function tripSourceOf(
  item: TripSourceLinks & { sourceDocId?: string },
  label: string,
): TripSource | null {
  const docId = item.sourceDoc?.id ?? item.sourceDocId;
  if (!docId && !item.sourceEmailThreadId) return null;
  return { label, docId, doc: item.sourceDoc, emailThreadId: item.sourceEmailThreadId };
}

/**
 * Opens a trip item's source. A screenshot shows in an in-app lightbox with
 * what indexing extracted from it — never the OS share sheet, which reads as
 * a download prompt. A PDF still goes to the platform viewer; an item mined
 * from an email body opens that thread.
 */
function useTripSourceViewer(): { open: (src: TripSource) => void; viewer: ReactNode } {
  const [shown, setShown] = useState<TripSource | null>(null);
  const [img, setImg] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    setShown(null);
    setImg(null);
    setFailed(null);
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);
  useEffect(() => () => cleanupRef.current?.(), []);

  const open = useCallback((src: TripSource) => {
    const mime = src.doc?.mimeType;
    if (src.docId && mime?.startsWith('image/')) {
      setShown(src);
      void attachmentImageSource(src.docId)
        .then((s) => {
          cleanupRef.current = s.cleanup ?? null;
          setImg({ uri: s.uri, headers: s.headers });
        })
        .catch((err: Error) =>
          setFailed(isBlobMissingError(err.message) ? 'This file is no longer available.' : err.message),
        );
      return;
    }
    if (src.docId) {
      void openAttachmentTab(src.docId, src.doc?.filename ?? src.label, mime);
      return;
    }
    if (src.emailThreadId) router.push(`/email/${src.emailThreadId}`);
  }, []);

  const emailId = shown?.doc?.emailThreadId ?? shown?.emailThreadId;
  const viewer = (
    <Modal visible={!!shown} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={lightboxStyles.backdrop} onPress={close}>
        {failed ? (
          <Text style={lightboxStyles.summary}>{failed}</Text>
        ) : img ? (
          <Image
            source={img}
            style={lightboxStyles.image}
            resizeMode="contain"
            onError={() => setFailed('This file could not be displayed.')}
          />
        ) : (
          <ActivityIndicator color={colors.onAccent} />
        )}
        <View style={lightboxStyles.caption}>
          <Text style={lightboxStyles.filename} numberOfLines={1}>
            {shown?.doc?.filename ?? shown?.label}
          </Text>
          <Text style={lightboxStyles.summary} numberOfLines={6}>
            {shown?.doc?.summary ?? 'Nothing was extracted from this file yet.'}
          </Text>
          {emailId ? (
            <Pressable
              onPress={() => {
                close();
                router.push(`/email/${emailId}`);
              }}
              hitSlop={6}
            >
              <Text style={styles.fileEmailLink}>✉ View original email</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
  return { open, viewer };
}

function SourceEmailGone({ item }: { item: TripSourceLinks }) {
  if (!item.sourceEmailGone) return null;
  return <Text style={styles.tripSourceGone}>Source email deleted from your mailbox</Text>;
}

function TripSourceButton({ src, onOpen }: { src: TripSource | null; onOpen: (s: TripSource) => void }) {
  if (!src) return null;
  const isDoc = !!src.docId;
  return (
    <Pressable
      onPress={() => onOpen(src)}
      hitSlop={8}
      style={styles.provSmallBtn}
      accessibilityLabel={`Open the ${isDoc ? 'document' : 'email'} ${src.label} came from`}
    >
      <Text style={styles.provSmallTxt}>{isDoc ? '📎' : '✉️'}</Text>
    </Pressable>
  );
}

interface ProvenanceState {
  label: string;
  raw: string;
  /** The email it came from is no longer mirrored (deleted / emptied from Trash). */
  emailGone?: boolean;
}

function ProvenanceModal({
  state,
  onClose,
}: {
  state: ProvenanceState | null;
  onClose: () => void;
}) {
  const bottomInset = useAndroidBottomInset();
  return (
    <Modal
      visible={!!state}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.provBackdrop} onPress={onClose}>
        <Pressable
          style={[styles.provSheet, { paddingBottom: 28 + bottomInset }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.provHeader}>
            <Text style={styles.provTitle} numberOfLines={2}>
              Why &ldquo;{state?.label}&rdquo;?
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.provClose}>✕</Text>
            </Pressable>
          </View>
          {state?.emailGone ? (
            <Text style={styles.provBody}>
              This came from an email that is no longer in your mailbox.
            </Text>
          ) : (
            <>
              <Text style={styles.provSub}>Extracted from:</Text>
              <ScrollView style={styles.provScroll}>
                <Text style={styles.provBody}>{state?.raw ?? ''}</Text>
              </ScrollView>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Proposals (ADR 0009) ────────────────────────────────────────────

// No "which group" chips: these change something that has no group (an event
// or task already in one, or the user's own mailing-list subscription).
const CHANGE_TOOLS = new Set([
  'delete_event',
  'update_event',
  'complete_task',
  'update_task',
  'unsubscribe_from_sender',
  'unsubscribe_from_senders',
  'trash_future_mail',
  'add_mail_filter',
]);

interface ProposalDescriptor {
  label: string;
  subtitle?: string;
}

/**
 * Mirror of `proposeCardFor` on the server - derives a human-readable label
 * and subtitle from a proposal's tool call.
 */
function describeProposal(p: Proposal): ProposalDescriptor {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(p.argsJson) as Record<string, unknown>;
  } catch {
    return { label: `(${p.toolName} - unparseable)` };
  }
  const s = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  const arr = (k: string): string[] | undefined =>
    Array.isArray(a[k]) ? (a[k] as string[]) : undefined;
  // A suggestion's date as a person reads it, never the ISO string it carries.
  const when = (k: string, withTime = true, clock: 'viewer' | 'written' = 'viewer') =>
    suggestionWhen(a[k], { withTime, allDay: a.allDay === true, clock }) ?? undefined;
  const due = when('dueAt', false);

  switch (p.toolName) {
    case 'create_task':
      return {
        label: s('title') ?? '(untitled task)',
        subtitle:
          [
            s('assigneeName') && `@${s('assigneeName')}`,
            due && `due ${due}`,
            s('remindCue'),
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
      };
    case 'add_list_item': {
      const items = arr('items') ?? [];
      return {
        label: `${items.length} item${items.length === 1 ? '' : 's'} → ${s('listName') ?? 'list'}`,
        subtitle: items.join(', '),
      };
    }
    case 'create_event': {
      // ADR 0315 addendum - confirming sends these people a calendar
      // invitation, so the card says so before the tap.
      const invitees = arr('invitees') ?? [];
      return {
        label: s('title') ?? '(untitled event)',
        subtitle:
          [when('startsAt'), s('location'), invitees.length > 0 && `Invites ${invitees.join(', ')}`]
            .filter(Boolean)
            .join(' · ') || undefined,
      };
    }
    // ADR 0248 - staged by an email that changes something already there;
    // nothing changes until confirmed. Only an email's card carries the
    // display title, so a chat proposal of the same tool falls through.
    case 'delete_event':
    case 'update_event':
    case 'complete_task':
    case 'update_task': {
      const fmt = (iso: string | undefined, withTime = true) => suggestionWhen(iso, { withTime });
      const event = s('eventTitle');
      const task = s('taskTitle');
      const why = s('why');
      if (p.toolName === 'delete_event' && event) {
        return {
          label: `Remove from calendar: ${event}`,
          subtitle: [fmt(s('eventStartsAt')), why, 'from an email · applies when you confirm']
            .filter(Boolean)
            .join(' · '),
        };
      }
      if (p.toolName === 'update_event' && event) {
        return {
          label: `Move: ${event}`,
          subtitle: [`to ${fmt(s('startsAt')) ?? '?'}`, why, 'from an email · applies when you confirm']
            .filter(Boolean)
            .join(' · '),
        };
      }
      if (p.toolName === 'complete_task' && task) {
        return {
          label: a.drop === true ? `No longer needed: ${task}` : `Mark done: ${task}`,
          subtitle: [why, 'from an email · applies when you confirm'].filter(Boolean).join(' · '),
        };
      }
      if (p.toolName === 'update_task' && task) {
        return {
          label: `New due date: ${task}`,
          subtitle: [`due ${fmt(s('dueAt'), false) ?? '?'}`, why, 'from an email · applies when you confirm']
            .filter(Boolean)
            .join(' · '),
        };
      }
      return { label: p.toolName };
    }
    case 'reply_to_email': {
      // The draft IS the decision - "does this say what I mean" cannot be
      // judged from a summary, so the body is the label, not a description.
      const body = s('body') ?? '';
      const who = describeRecipients(
        { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
        { max: 3 },
      );
      const verb = a.replyAll === true ? 'Reply all' : 'Reply';
      return {
        // Whole, never clipped: what is being approved is every word of it.
        label: body || '(empty reply)',
        // The audience rides on the row, so a reply-all is never a surprise.
        subtitle: `${verb}${who ? ` · ${who}` : ''} · sends when you confirm`,
      };
    }
    case 'compose_email': {
      const who = describeRecipients(
        { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
        { max: 3 },
      );
      return {
        // As with a reply, what is being approved is every word of it.
        label: `${s('subject') ?? '(no subject)'}\n\n${s('body') ?? ''}`,
        subtitle: `New email${who ? ` · ${who}` : ''} · sends when you confirm`,
      };
    }
    case 'forward_email': {
      const who = describeRecipients(
        { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
        { max: 3 },
      );
      const files = a.includeAttachments === false ? ' · without attachments' : '';
      return {
        label: `Forward "${s('threadSubject') ?? 'email'}"${s('note') ? `\n\n${s('note')}` : ''}`,
        subtitle: `Forward${who ? ` · ${who}` : ''}${files} · sends when you confirm`,
      };
    }
    case 'add_mail_filter': {
      return {
        label: `File mail from ${s('who') ?? s('from') ?? 'this sender'} into "${s('folder') ?? '?'}"`,
        subtitle: [
          (arr('matches') ?? []).join(', '),
          a.alsoExisting === true ? 'new and existing mail' : 'new mail from now on',
          'applies when you confirm',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    }
    case 'trash_future_mail': {
      const names = arr('senderNames') ?? arr('senderEmails') ?? arr('senders') ?? [];
      return {
        label: `Send future mail to Trash: ${names.join(', ')}`,
        subtitle: 'new mail only · recoverable from Trash · applies when you confirm',
      };
    }
    case 'unsubscribe_from_senders': {
      const names = arr('senderNames') ?? arr('senderEmails') ?? arr('senders') ?? [];
      return {
        label: `Unsubscribe from ${names.length} list${names.length === 1 ? '' : 's'}`,
        subtitle: [names.join(', '), 'sends when you confirm'].filter(Boolean).join(' · '),
      };
    }
    case 'unsubscribe_from_sender':
      return {
        label: `Unsubscribe from ${s('senderName') ?? s('sender') ?? s('senderEmail') ?? 'this list'}`,
        subtitle: [s('why'), s('senderEmail'), 'sends when you confirm'].filter(Boolean).join(' · '),
      };
    case 'record_rsvp':
      return {
        label: `RSVP · ${s('displayName') ?? ''} → ${s('status') ?? ''}`,
        subtitle: s('dish') ?? s('notes'),
      };
    case 'save_link':
      return { label: s('title') ?? s('url') ?? '(link)', subtitle: s('url') };
    case 'save_place':
      return {
        label: s('name') ?? '(place)',
        subtitle: [s('area'), s('city')].filter(Boolean).join(' · ') || s('note'),
      };
    case 'save_contact':
      return { label: s('name') ?? '(contact)', subtitle: s('org') ?? s('note') };
    case 'save_media':
      return { label: s('title') ?? '(media)', subtitle: s('kind') };
    case 'create_trip':
      return {
        label: s('name') ?? '(trip)',
        subtitle: `${s('destination') ?? ''} · ${when('startDate', false) ?? '?'} → ${when('endDate', false) ?? '?'}`,
      };
    case 'add_travel_leg':
      return {
        label: `${s('origin') ?? '?'} → ${s('destination') ?? '?'}`,
        subtitle:
          [s('carrier'), s('flightNo'), when('departAt', true, 'written')].filter(Boolean).join(' · ') || undefined,
      };
    case 'add_accommodation':
      return {
        label: s('propertyName') ?? '(stay)',
        subtitle: `${when('checkinDate', false) ?? '?'} → ${when('checkoutDate', false) ?? '?'}`,
      };
    case 'add_reservation':
      return {
        label: s('name') ?? '(reservation)',
        subtitle: [s('kind'), when('dateTime', true, 'written')].filter(Boolean).join(' · ') || undefined,
      };
    // ADR 0076 — these reach Action Items from every email pass, and without a
    // case here they rendered as the bare tool name. "add_person" is not a
    // decision anyone can make: it doesn't say who.
    case 'add_person':
      return {
        label: `Add ${s('displayName') ?? 'a person'} to People`,
        subtitle: [s('notes'), s('email')].filter(Boolean).join(' · ') || undefined,
      };
    case 'add_important_date':
      return {
        label: `${importantDateKindLabel(s('kind'))} for ${s('personName') ?? 'someone'}`,
        subtitle: importantDateLabel(s('date')),
      };
    default:
      return { label: p.toolName };
  }
}

/** The stored kind is an enum value, and "other for Mrs. Chen" reads like a
 *  leaked field name. */
function importantDateKindLabel(kind: string | undefined): string {
  switch (kind) {
    case 'birthday':
      return 'Birthday';
    case 'anniversary':
      return 'Anniversary';
    case 'death':
      return 'Remembrance';
    default:
      return 'Important date';
  }
}

/** `0000-MM-DD` is ADR 0076's "recurs, year unknown" — showing the zeros reads
 *  like corrupt data, so an unknown year renders as just the day. */
function importantDateLabel(date: string | undefined): string | undefined {
  if (!date || date.length < 10) return date;
  const [y, m, d] = date.split('-');
  const month = Number(m);
  if (!Number.isFinite(month) || month < 1 || month > 12) return date;
  const name = MONTH_NAMES[month - 1];
  return y === '0000' ? `${name} ${Number(d)} (every year)` : `${name} ${Number(d)}, ${y}`;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Names the destination of a proposal's `sourceHref`. A bare chevron is a link
 * nobody sees, and a suggestion lifted out of an email can't be judged without
 * the email — so the way back says where it goes.
 */
function sourceCta(href: string | null | undefined): string {
  if (href?.startsWith('/email/')) return 'Read the email ›';
  if (href === '/catchup/files') return 'Open the attachment ›';
  if (href?.startsWith('/groups/')) return 'Open the chat ›';
  return 'Open the source ›';
}

/**
 * ADR 0104 — is this suggestion a calendar invitation someone sent us?
 *
 * An invitation is answered, not filed: the buttons say yes/maybe/no, and it
 * cannot be routed into a shared group because the thing being decided is one
 * person's RSVP.
 */
function isInviteProposal(p: Proposal): boolean {
  if (p.toolName !== 'create_event') return false;
  try {
    const args = JSON.parse(p.argsJson || '{}') as { alreadyInGoogle?: boolean };
    return args.alreadyInGoogle === true;
  } catch {
    return false;
  }
}

/** ADR 0348 - the people an email meeting card could invite (only if asked). */
function meetingInviteesOf(p: Proposal): string[] {
  if (p.toolName !== 'create_event' || !p.provenance?.startsWith('gmail:')) return [];
  try {
    const a = JSON.parse(p.argsJson || '{}') as { invitees?: unknown };
    return Array.isArray(a.invitees) ? a.invitees.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** ADR 0346 phase 5 - an email meeting card that asks who sends the invite. */
function whoSendsAsk(p: Proposal): { note?: string } | null {
  if (p.toolName !== 'create_event') return null;
  try {
    const a = JSON.parse(p.argsJson || '{}') as { whoSends?: string; lapsedNote?: string };
    if (a.whoSends === 'ask') return {};
    if (typeof a.lapsedNote === 'string') return { note: a.lapsedNote };
    return null;
  } catch {
    return null;
  }
}

function ProposalRow({
  proposal,
  busy,
  groups,
  onConfirm,
  onReject,
  onRsvp,
  onRemoveEmail,
  removeAction = 'archive',
  error,
}: {
  proposal: Proposal;
  busy: boolean;
  /** Shared groups this can be routed into. Omitted = confirm keeps it private. */
  groups?: { id: string; name: string }[];
  /** `replaceEventId` (ADR 0343): move that event instead of adding one. */
  onConfirm: (
    targetGroupIds?: string[],
    calendarId?: string,
    replaceEventId?: string,
    sendInvites?: boolean,
  ) => void;
  onReject: () => void;
  /** Present only when the suggestion came from an email: puts that email
   *  away (archive or Trash, per the swipe setting) and dismisses this. */
  onRemoveEmail?: () => void;
  removeAction?: 'archive' | 'trash';
  /** Present only where an invitation can actually be answered. */
  onRsvp?: (response: 'accepted' | 'tentative' | 'declined') => void;
  /** Shown on the row itself: a failure that leaves the row standing needs to
   *  say why, or it reads as a dead button. */
  error?: string | null;
}) {
  const invite = !!onRsvp && isInviteProposal(proposal);
  const { label, subtitle } = describeProposal(proposal);
  const [editErr, setEditErr] = useState<string | null>(null);
  // ADR 0248 — removing an event has no destination to choose.
  const routable =
    // ADR 0248 - a change applies to the item where it already is.
    CHANGE_TOOLS.has(proposal.toolName) ? [] : (groups ?? []).filter((g) => g.id !== proposal.groupId);
  // ADR 0097 — where this lands is the user's call, not the model's. Default is
  // private; picking a group here is the whole consent step, so it is a visible
  // choice on the row rather than a setting somewhere else.
  // ADR 0150 — a standing routing rule may have staged a destination. Start the
  // strip on that group (when it is one the user can still see) so the
  // pre-selected chip matches where a bare ✓ will actually send — a rule
  // pre-selects, it never routes silently.
  // ADR 0247 — several groups may be picked; each gets its own copy.
  const [targets, setTargets] = useState<string[]>(() =>
    proposal.targetGroupId && routable.some((g) => g.id === proposal.targetGroupId)
      ? [proposal.targetGroupId]
      : [],
  );
  // ADR 0312 — an email event goes on its mailbox's calendar, or asks.
  const [calendarId, setCalendarId] = useState<string | null>(null);
  // ADR 0343 — this may be an event the user already has, moved.
  const [replacePick, setReplacePick] = useState<ReplacePick>(null);
  const moving = replacePick === 'move';
  // ADR 0348 — ✓ adds the meeting; inviting its guests is this box.
  const invitees = !invite && !moving ? meetingInviteesOf(proposal) : [];
  const [sendInvites, setSendInvites] = useState(false);
  const mustPickCalendar =
    needsReplacePick(proposal.replaces, replacePick) ||
    (!moving && needsCalendarPick(proposal.calendarChoice, calendarId));
  // Tapping the body opens what generated the proposal (source email thread,
  // chat, attachments) so the user can judge before confirming.
  const openSource = proposal.sourceHref
    ? () => router.push(proposal.sourceHref as never)
    : undefined;
  return (
    <View style={[styles.row, styles.memoryPendingRow]}>
      <Text style={[styles.tag, styles.memoryPendingTag]}>proposed</Text>
      <Pressable
        onPress={openSource}
        disabled={!openSource}
        style={({ pressed }) => [{ flex: 1 }, pressed && openSource ? { opacity: 0.6 } : null]}
      >
        <Text style={styles.rowText}>{label}</Text>
        {subtitle ? <Text style={styles.tripTimelineSub}>{subtitle}</Text> : null}
        {error ? <Text style={styles.proposalError}>{error}</Text> : null}
        {editErr ? <Text style={styles.proposalError}>{editErr}</Text> : null}
        {openSource ? (
          <Text style={styles.proposalSourceHint}>{sourceCta(proposal.sourceHref)}</Text>
        ) : null}
        {proposal.replaces && !invite ? (
          <ReplaceChoice offer={proposal.replaces} picked={replacePick} onChange={setReplacePick} />
        ) : null}
        {routable.length > 0 && !invite && !moving ? (
          <GroupChips groups={routable} selected={targets} onChange={setTargets} />
        ) : null}
        {proposal.calendarChoice && !invite && !moving ? (
          <CalendarChoice choice={proposal.calendarChoice} selected={calendarId} onChange={setCalendarId} />
        ) : null}
        {whoSendsAsk(proposal) ? (
          <Text style={styles.tripTimelineSub}>
            {whoSendsAsk(proposal)!.note
              ? `${whoSendsAsk(proposal)!.note}: ✓ adds it to your calendar`
              : 'Nobody said who sends the invite: ✓ adds it to your calendar, Wait holds the slot for theirs'}
          </Text>
        ) : null}
        {invitees.length > 0 ? (
          <InviteChoice invitees={invitees} checked={sendInvites} onChange={setSendInvites} disabled={busy} />
        ) : null}
        {proposal.fit ? (
          <CalendarFitNote
            fit={proposal.fit}
            proposalId={proposal.id}
            onSuggestTime={
              invite && proposal.sourceHref?.startsWith('/email/')
                ? () => {
                    setEditErr(null);
                    openDraftedReply(proposal.sourceHref!.slice('/email/'.length), SUGGEST_ANOTHER_TIME).catch(
                      (e: Error) => setEditErr(e.message),
                    );
                  }
                : undefined
            }
          />
        ) : null}
      </Pressable>
      {invite ? (
        <View style={styles.rsvpBtns}>
          {(
            [
              ['accepted', 'Yes', styles.rsvpYes],
              ['tentative', 'Maybe', styles.rsvpMaybe],
              ['declined', 'No', styles.rsvpNo],
            ] as const
          ).map(([value, label, tone]) => (
            <Pressable
              key={value}
              onPress={() => onRsvp!(value)}
              disabled={busy}
              hitSlop={4}
              style={({ pressed }) => [
                styles.rsvpBtn,
                tone,
                recommendedRsvp(proposal.fit) === value && styles.rsvpPick,
                pressed && !busy && { opacity: 0.6 },
                busy && { opacity: 0.4 },
              ]}
            >
              <Text style={styles.rsvpBtnTxt}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <>
          {replyDraftOf(proposal) ? (
            <Pressable
              onPress={() => {
                setEditErr(null);
                editReplyDraft(proposal).catch((e: Error) => setEditErr(e.message));
              }}
              disabled={busy}
              accessibilityLabel="Edit this reply in the email"
              style={({ pressed }) => [
                styles.memoryActionBtn,
                styles.replyEditBtn,
                pressed && !busy && { opacity: 0.6 },
                busy && { opacity: 0.4 },
              ]}
            >
              <Text style={styles.replyEditTxt}>Edit</Text>
            </Pressable>
          ) : null}
          {onRemoveEmail ? (
            <PutAwayButton
              action={removeAction}
              busy={busy}
              onPress={onRemoveEmail}
              style={styles.removeEmailBtn}
            />
          ) : null}
          {whoSendsAsk(proposal) && !whoSendsAsk(proposal)!.note ? (
            <Pressable
              onPress={() => {
                setEditErr(null);
                waitForInvite(proposal.id)
                  .then(onReject)
                  .catch((e: Error) => setEditErr(e.message));
              }}
              disabled={busy}
              accessibilityLabel="Wait for their invite"
              style={({ pressed }) => [
                styles.memoryActionBtn,
                styles.replyEditBtn,
                pressed && !busy && { opacity: 0.6 },
                busy && { opacity: 0.4 },
              ]}
            >
              <Text style={styles.replyEditTxt}>Wait</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() =>
              moving
                ? onConfirm(undefined, undefined, replaceEventIdFor(proposal.replaces, replacePick))
                : onConfirm(targets.length > 0 ? targets : undefined, calendarId ?? undefined, undefined, sendInvites)
            }
            disabled={busy || mustPickCalendar}
            accessibilityHint={
              needsReplacePick(proposal.replaces, replacePick)
                ? 'Pick Move it or Add as new first'
                : mustPickCalendar
                  ? 'Pick a calendar first'
                  : undefined
            }
            style={({ pressed }) => [
              styles.memoryActionBtn,
              styles.memoryConfirmBtn,
              pressed && !busy && { opacity: 0.6 },
              (busy || mustPickCalendar) && { opacity: 0.4 },
            ]}
          >
            <Text style={styles.memoryConfirmTxt}>✓</Text>
          </Pressable>
          <Pressable
            onPress={onReject}
            disabled={busy}
            style={({ pressed }) => [
              styles.memoryActionBtn,
              styles.memoryRejectBtn,
              pressed && !busy && { opacity: 0.6 },
              busy && { opacity: 0.4 },
            ]}
          >
            <Text style={styles.memoryRejectTxt}>✗</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

/**
 * Per-section "Proposed - N" sub-block. Owns the busy state so rapid taps
 * across rows don't collide. Returns the rendered block (or null if empty)
 * plus a "Confirmed" divider to slot in above the real items.
 */
function useProposedBlock(proposals: Proposal[], confirmedCount: number) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const resolve = async (
    p: Proposal,
    action: 'confirm' | 'reject',
    calendarId?: string,
    replaceEventId?: string,
    sendInvites?: boolean,
  ) => {
    setBusy((prev) => {
      const n = new Set(prev);
      n.add(p.id);
      return n;
    });
    try {
      await answerProposal({
        proposalId: p.id,
        memberIds: [p.id],
        action,
        ...(calendarId ? { calendarId } : {}),
        ...(replaceEventId ? { replaceEventId } : {}),
        ...(sendInvites ? { sendInvites: true } : {}),
        label: describeProposal(p).label,
      });
    } catch (err) {
      console.warn('proposal resolve failed', err);
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(p.id);
        return n;
      });
    }
  };

  if (proposals.length === 0) return { block: null, divider: null };
  const block = (
    <>
      <Text style={[styles.subCardTitle, { marginTop: 0 }]}>
        Proposed - {proposals.length}
      </Text>
      {proposals.map((p) => (
        <ProposalRow
          key={p.id}
          proposal={p}
          busy={busy.has(p.id)}
          onConfirm={(_targets, calendarId, replaceEventId, sendInvites) =>
            void resolve(p, 'confirm', calendarId, replaceEventId, sendInvites)
          }
          onReject={() => void resolve(p, 'reject')}
        />
      ))}
    </>
  );
  const divider =
    confirmedCount > 0 ? (
      <Text style={[styles.subCardTitle, { marginTop: 10 }]}>Confirmed</Text>
    ) : null;
  return { block, divider };
}

/**
 * ADR 0150 — one-tap offer to turn a hand-made routing correction into a
 * standing `sender_domain` rule. Shown after the user picked a shared-group
 * chip and confirmed; tapping Yes creates the rule so the NEXT proposal from
 * that sender arrives pre-selected. It never routes anything on its own.
 */
function RouteOfferRow({
  suggestion,
  onDone,
}: {
  suggestion: RouteSuggestion;
  onDone: () => void;
}) {
  const [state, setState] = useState<'ask' | 'saving' | 'saved' | 'error'>('ask');
  const save = async () => {
    setState('saving');
    try {
      await addEmailRoute({
        pattern: suggestion.pattern,
        targetGroupId: suggestion.targetGroupId,
      });
      setState('saved');
    } catch (err) {
      console.warn('add email route failed', err);
      setState('error');
    }
  };

  if (state === 'saved') {
    return (
      <View style={styles.routeOfferRow}>
        <Text style={styles.routeOfferSaved}>
          ✓ Mail from {suggestion.pattern} will go to {suggestion.targetGroupName}.
        </Text>
        <Pressable onPress={onDone} hitSlop={6}>
          <Text style={styles.routeOfferDismiss}>✕</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.routeOfferRow}>
      <Text style={styles.routeOfferText}>
        {suggestion.replaces
          ? `Send ${suggestion.pattern} mail to ${suggestion.targetGroupName} instead of ${suggestion.replaces.targetGroupName}?`
          : `Always send mail from ${suggestion.pattern} to ${suggestion.targetGroupName}?`}
      </Text>
      <View style={styles.routeOfferBtns}>
        <Pressable
          onPress={() => void save()}
          disabled={state === 'saving'}
          hitSlop={6}
          style={({ pressed }) => [
            styles.routeOfferYes,
            pressed && state !== 'saving' && { opacity: 0.6 },
            state === 'saving' && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.routeOfferYesTxt}>{state === 'error' ? 'Retry' : 'Yes'}</Text>
        </Pressable>
        <Pressable onPress={onDone} hitSlop={6}>
          <Text style={styles.routeOfferDismiss}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Action Items (ADR 0070) ──────────────────────────────────────────
//
// Email-derived suggestions front and center: every pending proposal whose
// provenance is a gmail thread (ADR 0063 magics) with one-tap confirm/reject.
// The same suggestions also dock beside their email rows (ADR 0068); resolving
// in either place resolves both.

function ActionItemsSection({
  proposals,
  groups,
  onResolved,
}: {
  proposals: Proposal[];
  groups: { id: string; name: string }[];
  onResolved: (id: string, status: 'confirmed' | 'rejected') => void;
}) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  // ADR 0150 — after a user routes a proposal into a shared group by hand, the
  // confirm response may carry a one-tap offer to make that routing standing.
  // Keyed by the (now-resolved) proposal id; the row itself has unmounted.
  const [routeOffers, setRouteOffers] = useState<Record<string, RouteSuggestion>>({});
  // Emails whose stacked suggestions the user opened. Several suggestions
  // from one email stack behind the first, so one long email cannot push
  // every other email's suggestions out of sight.
  const [openSources, setOpenSources] = useState<Set<string>>(() => new Set());
  const toggleSource = (key: string) =>
    setOpenSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // ADR 0335 - and suggestions a connected AI app (Claude, ChatGPT) made.
  const fromEmail = proposals.filter(
    (p) => p.provenance?.startsWith('gmail:') || p.provenance?.startsWith('connector:'),
  );
  const pending = fromEmail.filter((p) => p.status === 'pending');
  const audit = fromEmail.filter((p) => p.status !== 'pending');

  const removeAction = useEmailRemoveAction();

  /**
   * Put the source email away and dismiss this suggestion. Trash also
   * withdraws every other pending suggestion from that email on the server
   * (ADR 0073/0215), so those rows leave too; an archived email keeps its
   * other suggestions (ADR 0073), so only this row goes.
   */
  const removeEmail = async (p: Proposal) => {
    const threadId = emailThreadIdOf(p.sourceHref);
    if (!threadId) return;
    setBusy((prev) => new Set(prev).add(p.id));
    setErrors((prev) => {
      const n = { ...prev };
      delete n[p.id];
      return n;
    });
    try {
      await putEmailAway(threadId, removeAction);
      await rejectProposal(p.id).catch(() => {});
      const gone =
        removeAction === 'trash'
          ? pending.filter((q) => emailThreadIdOf(q.sourceHref) === threadId)
          : [p];
      for (const q of gone) onResolved(q.id, 'rejected');
    } catch (err) {
      console.warn('action item email remove failed', err);
      setErrors((prev) => ({ ...prev, [p.id]: putAwayErrorText(removeAction) }));
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(p.id);
        return n;
      });
    }
  };

  const dismissOffer = (pid: string) =>
    setRouteOffers((prev) => {
      const n = { ...prev };
      delete n[pid];
      return n;
    });

  const resolve = async (
    p: Proposal,
    action: 'confirm' | 'reject',
    targetGroupIds?: string[],
    calendarId?: string,
    replaceEventId?: string,
    sendInvites?: boolean,
  ) => {
    setBusy((prev) => new Set(prev).add(p.id));
    try {
      const res = await answerProposal({
        proposalId: p.id,
        memberIds: [p.id],
        action,
        ...(targetGroupIds ? { targetGroupIds } : {}),
        ...(calendarId ? { calendarId } : {}),
        ...(replaceEventId ? { replaceEventId } : {}),
        ...(sendInvites ? { sendInvites: true } : {}),
        label: describeProposal(p).label,
      });
      if (res.routeSuggestion) {
        setRouteOffers((prev) => ({ ...prev, [p.id]: res.routeSuggestion! }));
      }
      onResolved(p.id, action === 'confirm' ? 'confirmed' : 'rejected');
    } catch (err) {
      console.warn('action item resolve failed', err);
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(p.id);
        return n;
      });
    }
  };

  /** A trip bundle is answered by one tap on any member (the server resolves
   *  every sibling), so every member leaves the list together. */
  const resolveBundle = async (
    members: Proposal[],
    action: 'confirm' | 'reject',
    targetGroupIds?: string[],
  ) => {
    const anchor = members.find((m) => m.toolName === 'create_trip') ?? members[0]!;
    const ids = members.map((m) => m.id);
    setBusy((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.add(id);
      return n;
    });
    try {
      await answerProposal({
        proposalId: anchor.id,
        memberIds: ids,
        action,
        ...(targetGroupIds ? { targetGroupIds } : {}),
        label: describeProposal(anchor).label,
      });
      for (const id of ids) onResolved(id, action === 'confirm' ? 'confirmed' : 'rejected');
    } catch (err) {
      console.warn('action item bundle resolve failed', err);
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        for (const id of ids) n.delete(id);
        return n;
      });
    }
  };

  /**
   * ADR 0104 — the organizer is answered first; only then is anything recorded
   * here. A failure must NOT clear the row: an invitation that still needs a
   * reply has to keep looking like one.
   */
  const answer = async (p: Proposal, response: 'accepted' | 'tentative' | 'declined') => {
    setBusy((prev) => new Set(prev).add(p.id));
    setErrors((prev) => {
      const n = { ...prev };
      delete n[p.id];
      return n;
    });
    try {
      await rsvpProposal(p.id, response);
      onResolved(p.id, response === 'declined' ? 'rejected' : 'confirmed');
    } catch (err) {
      console.warn('rsvp failed', err);
      setErrors((prev) => ({ ...prev, [p.id]: rsvpErrorText(err) }));
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(p.id);
        return n;
      });
    }
  };

  const clusters = clusterProposalsBySource(pending).map((c) => ({
    ...c,
    decisions: proposalDecisions(c.members),
  }));
  const decisionCount = clusters.reduce((n, c) => n + c.decisions.length, 0);

  return (
    <Section
      title={
        pending.some((p) => p.provenance?.startsWith('connector:')) ? 'Suggested for you' : 'Suggested from your email'
      }
      count={decisionCount}
    >
      {Object.entries(routeOffers).map(([pid, s]) => (
        <RouteOfferRow key={pid} suggestion={s} onDone={() => dismissOffer(pid)} />
      ))}
      {pending.length === 0 ? (
        Object.keys(routeOffers).length === 0 ? (
          <Text style={styles.empty}>
            Nothing waiting on you. Chord scans new mail for events, to-dos, and list items -
            suggestions land here (and beside the email itself).
          </Text>
        ) : null
      ) : (
        clusters.map((c) => {
          // Phones: swipe a card left to dismiss it, same as its ✕ (web keeps
          // the button). Each card goes on its own, so one email's suggestions
          // can be taken one at a time.
          const row = (d: ProposalDecision) => {
            if (d.kind === 'bundle') {
              const isBusy = decisionProposalIds(d).some((id) => busy.has(id));
              return (
                <SwipeToDismiss
                  key={d.key}
                  onDismiss={isBusy ? undefined : () => void resolveBundle(d.members, 'reject')}
                >
                  <TripBundleCard
                    members={d.members}
                    busy={isBusy}
                    groups={groups}
                    onConfirm={(targetGroupIds) =>
                      void resolveBundle(d.members, 'confirm', targetGroupIds)
                    }
                    onReject={() => void resolveBundle(d.members, 'reject')}
                  />
                </SwipeToDismiss>
              );
            }
            const p = d.proposal;
            return (
              <SwipeToDismiss
                key={d.key}
                onDismiss={busy.has(p.id) ? undefined : () => void resolve(p, 'reject')}
              >
                <ProposalRow
                  proposal={p}
                  busy={busy.has(p.id)}
                  groups={groups}
                  onConfirm={(targetGroupIds, calendarId, replaceEventId, sendInvites) =>
                    void resolve(p, 'confirm', targetGroupIds, calendarId, replaceEventId, sendInvites)
                  }
                  onReject={() => void resolve(p, 'reject')}
                  onRsvp={(response) => void answer(p, response)}
                  onRemoveEmail={
                    emailThreadIdOf(p.sourceHref) ? () => void removeEmail(p) : undefined
                  }
                  removeAction={removeAction}
                  error={errors[p.id] ?? null}
                />
              </SwipeToDismiss>
            );
          };
          // One decision from a source needs no card around it — the row
          // already carries its own tap-through to the email.
          if (c.decisions.length < 2) return <View key={c.key}>{c.decisions.map(row)}</View>;
          return (
            <View key={c.key} style={styles.proposalCluster}>
              <Pressable
                onPress={c.href ? () => router.push(c.href as never) : undefined}
                disabled={!c.href}
                hitSlop={4}
              >
                <Text style={styles.proposalClusterHead} numberOfLines={2}>
                  {c.label ?? 'From one email'}
                  {c.href ? <Text style={styles.proposalSourceHint}>  ›</Text> : null}
                </Text>
              </Pressable>
              <Text style={styles.proposalClusterSub}>
                {c.decisions.length} suggestions - confirm or dismiss each
              </Text>
              <StackedCards
                items={c.decisions}
                open={openSources.has(c.key)}
                onToggle={() => toggleSource(c.key)}
                limit={1}
                minStacked={1}
                label={(n) =>
                  c.key.startsWith('connector:') ? `${n} more from this app` : `${n} more from this email`
                }
                render={row}
              />
            </View>
          );
        })
      )}
      <AuditBlock proposals={audit} />
    </Section>
  );
}

// ── Finance (ADR 0070 - scaffold) ────────────────────────────────────

function money(amount: number, currency: string): string {
  if (currency === 'unspecified') return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Findings (ADR 0249): questions to try about your own mail, then the
 * receipts Chord has read. Questions are answered in the tab's own chat
 * (ADR 0277), never posted to the personal chat.
 */
function FindingsSection({ personalGroupId }: { personalGroupId: string | null }) {
  const [data, setData] = useState<EmailReceiptsOverview | null>(null);
  const [failed, setFailed] = useState(false);

  const questions = findingsQuestions(topShops(data?.receipts ?? []));
  const askBlock = (
    <Section title="Ask about your mail">
      <FindingsChat questions={questions} personalGroupId={personalGroupId} />
    </Section>
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      getEmailReceipts()
        .then((d) => {
          if (!live) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => {
          if (live) setFailed(true);
        });
      return () => {
        live = false;
      };
    }, []),
  );

  if (!data) {
    return (
      <>
        {askBlock}
        <Section title="Receipts">
          {failed ? (
            <Text style={styles.empty}>Could not load receipts. Pull down to try again.</Text>
          ) : (
            <ActivityIndicator style={{ padding: 12 }} />
          )}
        </Section>
      </>
    );
  }

  const openThread = (threadId: string | null) => {
    if (threadId) router.push(`/email/${threadId}`);
  };

  return (
    <>
      {askBlock}
      <Text style={styles.financeNote}>
        From receipts that arrived by email and that Chord has read. Not your total spending.
        Receipts stay here after you delete the email.
        {data.truncated ? ' Older receipts are left out.' : ''}
      </Text>

      {data.recurring.length > 0 && (
        <Section title="Repeating charges" count={data.recurring.length}>
          {data.recurring.map((c) => (
            <Pressable
              key={`${c.merchant}|${c.currency}`}
              style={styles.financeRow}
              disabled={!c.threadId}
              onPress={() => openThread(c.threadId)}
            >
              <View style={styles.financeRowMain}>
                <Text style={styles.financeMerchant} numberOfLines={1}>
                  {c.merchant}
                </Text>
                <Text style={styles.financeSub}>
                  {c.cadence} · last {shortDate(c.lastAt)} · next about {shortDate(c.nextExpectedAt)}
                </Text>
              </View>
              <Text style={styles.financeAmount}>{money(c.amount, c.currency)}</Text>
            </Pressable>
          ))}
        </Section>
      )}

      {data.months.length > 0 && (
        <Section title="By month">
          {data.months.map((m) => (
            <View key={`${m.month}|${m.currency}`} style={styles.financeRow}>
              <View style={styles.financeRowMain}>
                <Text style={styles.financeMerchant}>{monthLabel(m.month)}</Text>
                <Text style={styles.financeSub}>
                  {m.count} {m.count === 1 ? 'receipt' : 'receipts'}
                </Text>
              </View>
              <Text style={styles.financeAmount}>{money(m.total, m.currency)}</Text>
            </View>
          ))}
        </Section>
      )}

      <Section title="Receipts" count={data.receipts.length}>
        {data.receipts.length === 0 ? (
          <Text style={styles.empty}>
            No receipts yet. They appear here as Chord reads purchase emails in your mailbox.
          </Text>
        ) : (
          data.receipts.map((r) => (
            <Pressable
              key={`${r.threadId ?? r.merchant}|${r.at}|${r.amount}`}
              style={styles.financeRow}
              disabled={!r.threadId}
              onPress={() => openThread(r.threadId)}
            >
              <View style={styles.financeRowMain}>
                <Text style={styles.financeMerchant} numberOfLines={1}>
                  {r.merchant}
                </Text>
                <Text style={styles.financeSub}>
                  {[
                    shortDate(r.at),
                    r.paymentMethod,
                    r.mailbox,
                    r.orderNumber ? `order ${r.orderNumber}` : null,
                    r.threadId ? null : 'email deleted',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <Text style={styles.financeAmount}>{money(r.amount, r.currency)}</Text>
            </Pressable>
          ))
        )}
      </Section>
    </>
  );
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Collapsible "Recent activity" footer for a section. Shows the last 5
 * rejected/expired proposals so the audit trail is visible - the "what
 * the bot wanted to do but didn't land" story.
 */
function AuditBlock({ proposals }: { proposals: Proposal[] }) {
  const [open, setOpen] = useState(false);
  const recent = [...proposals]
    .sort(
      (a, b) =>
        Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt),
    )
    .slice(0, 5);
  if (recent.length === 0) return null;
  return (
    <View style={{ marginTop: 8 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6}>
        <Text style={styles.auditToggle}>
          {open ? '▾' : '▸'} Recent activity - {proposals.length}
        </Text>
      </Pressable>
      {open && (
        <View style={{ marginTop: 4 }}>
          {recent.map((p) => {
            const { label, subtitle } = describeProposal(p);
            const icon = p.status === 'expired' ? '⌛' : '✗';
            return (
              <View key={p.id} style={styles.auditRow}>
                <Text style={styles.auditIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.auditLabel} numberOfLines={1}>
                    {label}
                  </Text>
                  {subtitle ? (
                    <Text style={styles.auditSubtitle} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.auditMeta}>
                  {p.status} · {relTime(p.resolvedAt ?? p.createdAt)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────

function TaskProvenanceButton({ task }: { task: Task }) {
  return <ProvenanceButton label={task.title} raw={task.sourceRawContext} />;
}

interface TaskAction {
  key: string;
  label: string;
  icon: IconName;
  destructive?: boolean;
  onPress: () => void;
}

function taskActions(
  task: Task,
  onEdit: () => void,
  onDelete: () => void,
  onDrop: () => void,
): TaskAction[] {
  return [
    { key: 'edit', label: '✏️ Edit', icon: 'pencil-outline', onPress: onEdit },
    {
      key: 'uber',
      label: '🚗 Uber',
      icon: 'car-outline',
      onPress: () => Alert.alert('Would open Uber', `pickup: home\ndropoff: ${task.title}`),
    },
    {
      key: 'maps',
      label: '🗺 Maps',
      icon: 'map-outline',
      onPress: () => Alert.alert('Would open Maps', `route to ${task.title}`),
    },
    {
      key: 'mail',
      label: '✉ Mail',
      icon: 'email-outline',
      onPress: () => Alert.alert('Would compose email', `re: ${task.title}`),
    },
    {
      key: 'phone',
      label: '📞 Phone',
      icon: 'phone-outline',
      onPress: () => Alert.alert('Would call', `related contact for "${task.title}"`),
    },
    {
      key: 'drop',
      label: '🗄 Drop (keep in Archived)',
      icon: 'archive-arrow-down-outline',
      onPress: onDrop,
    },
    { key: 'delete', label: 'Delete', icon: 'delete-outline', destructive: true, onPress: onDelete },
  ];
}

/**
 * Android draws at most three buttons in an alert and drops the rest, which
 * would leave Drop and Delete unreachable. There the caller shows the same
 * actions in a sheet instead (`onSheet`); iOS and web are unchanged.
 */
function openTaskActions(
  task: Task,
  onEdit: () => void,
  onDelete: () => void,
  onDrop: () => void,
  onSheet: (actions: TaskAction[]) => void,
): void {
  // RN Web can't render this multi-button action sheet, so on web it would
  // silently no-op (and task delete would be unreachable). Edit is already
  // available via the inline ✎ button; the deep-link rows are demo
  // placeholders - so on web the ⋯ menu collapses to confirms. web's
  // confirm is binary, so offer the recoverable action first and fall
  // through to permanent delete only when the user declines it — dropping
  // is what people want for work they're no longer going to do, but
  // delete must not become unreachable on web to get there.
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    if (window.confirm(`${task.title}\n\nDrop this task? It stays under Archived.`)) {
      onDrop();
      return;
    }
    if (window.confirm(`${task.title}\n\nDelete it permanently instead? This cannot be undone.`)) {
      onDelete();
    }
    return;
  }
  const pre = task.assigneePersonaName
    ? ` · for ${task.assigneePersonaName}`
    : task.assigneeId
      ? ` · for ${task.assigneeId}`
      : '';
  const actions = taskActions(task, onEdit, onDelete, onDrop);
  if (Platform.OS === 'android') {
    onSheet(actions);
    return;
  }
  Alert.alert(
    task.title,
    `Edit, or deep-link actions (demo placeholders)${pre}`,
    [
      ...actions.map((a) => ({
        text: a.label,
        style: a.destructive ? ('destructive' as const) : undefined,
        onPress: a.onPress,
      })),
      { text: 'Cancel', style: 'cancel' },
    ],
    { cancelable: true },
  );
}

// ── Rich-content helpers (links, places) ─────────────────────────────

const URL_RE = /(https?:\/\/[^\s<>"']+)/i;

function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[1] : null;
}

/** Tap target for opening a place on Google Maps (system browser). */
function placeMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const richStyles = themed(() => ({
  favicon: { width: 14, height: 14, borderRadius: 3 },
  mapPin: { fontSize: 14 },
}));

const tagStyles = themed((colors) => ({
  filterRow: { marginTop: 4, marginBottom: 6, flexGrow: 0 },
  filterRowContent: { gap: 6, paddingRight: 8 },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterChipText: { fontSize: 12, color: colors.muted },
  filterChipTextActive: { color: colors.onAccent, fontWeight: '600' },
  inlineTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    alignItems: 'center',
  },
  inlineTagChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: colors.bg2,
  },
  inlineTagText: { fontSize: 11, color: colors.muted },
  inlineTagMore: { fontSize: 11, color: colors.muted, marginLeft: 2 },
}));

// ── Shared helpers for the three list-style sections ────────────────

type SortKey = 'due-asc' | 'added-desc' | 'added-asc' | 'alpha';

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const ms = Date.now() - t;
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "due Mar 4" / "due today" / "3d overdue" — the row never showed a due
 *  date at all, which made an overdue pile impossible to triage on sight. */
function dueLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days >= 1) return `${days}d overdue`;
  if (days === 0) return 'due today';
  const when = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `due ${when}`;
}

function creatorLabel(
  createdBy: string | null,
  createdByName: string | undefined,
  selfId: string | null,
): string {
  if (!createdBy) return 'Chord';
  if (selfId && createdBy === selfId) return 'you';
  return createdByName ?? '-';
}

function GroupPicker({
  groups,
  selected,
  onSelect,
}: {
  groups: { id: string; name: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (groups.length <= 1) return null;
  return (
    <View style={addStyles.groupPicker}>
      {groups.map((g) => (
        <Pressable
          key={g.id}
          onPress={() => onSelect(g.id)}
          style={[
            addStyles.groupChip,
            g.id === selected && addStyles.groupChipActive,
          ]}
        >
          <Text
            style={[
              addStyles.groupChipText,
              g.id === selected && addStyles.groupChipTextActive,
            ]}
            numberOfLines={1}
          >
            {g.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Tab-level upload affordance for the Files / Trips tabs - the read-only-tab
 * equivalent of the inline "+ Add task / New list" rows. Toggles open to a group
 * picker + picker button(s); the actual file/photo/camera pick + upload happens
 * in the parent's `onUpload`. On web one dialog lists every type; native splits
 * Files / Photos / Camera into the system pickers (matching the chat composer).
 */
function UploadAddRow({
  label,
  groups,
  onUpload,
}: {
  label: string;
  groups: { id: string; name: string }[];
  onUpload: (groupId: string, kind: 'file' | 'photo' | 'camera') => Promise<number>;
}) {
  const [open, setOpen] = useState(false);
  const [targetGroup, setTargetGroup] = useState<string | null>(groups[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (kind: 'file' | 'photo' | 'camera') => {
      const g = targetGroup ?? groups[0]?.id ?? null;
      if (!g) return;
      setBusy(true);
      try {
        const n = await onUpload(g, kind);
        if (n > 0) setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [targetGroup, groups, onUpload],
  );

  return (
    <View style={{ marginBottom: 10 }}>
      <View style={addStyles.addRow}>
        <Pressable style={addStyles.addBtn} onPress={() => setOpen((v) => !v)} hitSlop={8}>
          <PlusGlyph open={open} />
        </Pressable>
        <Text style={addStyles.addLabel}>{label}</Text>
      </View>
      {open && (
        <View style={{ marginTop: 6 }}>
          <GroupPicker groups={groups} selected={targetGroup} onSelect={setTargetGroup} />
          <View style={[addStyles.addRow, { gap: 8, flexWrap: 'wrap' }]}>
            {Platform.OS === 'web' ? (
              <Pressable
                style={[addStyles.uploadBtn, busy && { opacity: 0.5 }]}
                disabled={busy}
                onPress={() => void run('file')}
              >
                <Text style={addStyles.uploadBtnText}>{busy ? 'Uploading…' : 'Choose file'}</Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  style={[addStyles.uploadBtn, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={() => void run('file')}
                >
                  <Text style={addStyles.uploadBtnText}>{busy ? '…' : '📄 File'}</Text>
                </Pressable>
                <Pressable
                  style={[addStyles.uploadBtn, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={() => void run('photo')}
                >
                  <Text style={addStyles.uploadBtnText}>{busy ? '…' : '🖼 Photos'}</Text>
                </Pressable>
                <Pressable
                  style={[addStyles.uploadBtn, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={() => void run('camera')}
                >
                  <Text style={addStyles.uploadBtnText}>{busy ? '…' : '📷 Camera'}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function SortBar({
  sort,
  onChange,
  alphaLabel,
  dueLabel,
}: {
  sort: SortKey;
  onChange: (k: SortKey) => void;
  alphaLabel?: string;
  /** Only sections whose rows carry a date offer this chip. */
  dueLabel?: string;
}) {
  const opts: { key: SortKey; label: string }[] = [
    ...(dueLabel ? [{ key: 'due-asc' as SortKey, label: dueLabel }] : []),
    { key: 'added-desc', label: 'Latest' },
    { key: 'added-asc', label: 'Oldest' },
    { key: 'alpha', label: alphaLabel ?? 'A–Z' },
  ];
  return (
    <View style={addStyles.sortBar}>
      {opts.map((o) => (
        <Pressable
          key={o.key}
          onPress={() => onChange(o.key)}
          style={[
            addStyles.sortChip,
            o.key === sort && addStyles.sortChipActive,
          ]}
        >
          <Text
            style={[
              addStyles.sortChipText,
              o.key === sort && addStyles.sortChipTextActive,
            ]}
          >
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function applySort<T extends { createdAt: string }>(
  rows: T[],
  sort: SortKey,
  alphaKey: (r: T) => string,
  dueKey?: (r: T) => string | null | undefined,
): T[] {
  const copy = [...rows];
  if (sort === 'due-asc' && dueKey) {
    // Dated work first, soonest at the top; undated work sits below it in its
    // own newest-first order. A row with no date is NOT "infinitely far away"
    // - nobody gave it a deadline - so it must not sort as though it had one.
    // Same NULLS LAST rule the briefing context reads in SQL (ADR 0092).
    copy.sort((a, b) => {
      const da = dueKey(a) ?? '';
      const db = dueKey(b) ?? '';
      if (da && db) return da.localeCompare(db) || b.createdAt.localeCompare(a.createdAt);
      if (da) return -1;
      if (db) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  } else if (sort === 'alpha') {
    copy.sort((a, b) => alphaKey(a).localeCompare(alphaKey(b)));
  } else if (sort === 'added-asc') {
    copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } else {
    copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return copy;
}

// Input caps mirror the server zod schemas (kernel: CreateTaskRequest,
// UpsertListRequest, AddListItemRequest). Keep these in sync so the UI
// blocks over-length input before the request 400s.
const TASK_TITLE_MAX = 200;
const LIST_NAME_MAX = 80;
// Imported from the kernel schema so the UI cap can't drift from the server's.
const LIST_ITEM_MAX = LIST_ITEM_TEXT_MAX;

/** Right-aligned `n/max` hint that appears only as the user nears the cap. */
function CharCount({ value, max }: { value: string; max: number }) {
  if (value.length < max - 20) return null;
  return (
    <Text style={[addStyles.charCount, value.length >= max && addStyles.charCountMax]}>
      {value.length}/{max}
    </Text>
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
    maxWidth: 480,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
  fieldLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
    backgroundColor: colors.bg,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  dueCurrent: { color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 8 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.bg,
  },
  presetTxt: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  manualRow: { flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' },
  manualInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 14,
    backgroundColor: colors.bg,
  },
  manualSet: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.bg,
  },
  manualSetTxt: { color: colors.accent, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 20 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  cancelBtn: { borderWidth: 1, borderColor: colors.border, backgroundColor: 'transparent' },
  cancelTxt: { color: colors.text, fontWeight: '600' },
  saveBtn: { backgroundColor: colors.accent },
  saveTxt: { color: colors.onAccent, fontWeight: '600' },
}));

// Plus / close glyph drawn as two bars rather than a text "+"/"×". A text
// glyph can't be reliably centered in the circular button: its ink sits high
// in the line box and `textAlignVertical` is a no-op on web, so the character
// always rides above center. Two absolutely-positioned bars are geometrically
// exact on every platform; rotating the pair 45° turns the plus into a close.
const PLUS_SIZE = 12;
const PLUS_THICK = 2;

function PlusGlyph({ open = false }: { open?: boolean }) {
  return (
    <View style={[addStyles.plusGlyph, open && addStyles.plusGlyphOpen]}>
      <View style={addStyles.plusBarH} />
      <View style={addStyles.plusBarV} />
    </View>
  );
}

const addStyles = themed((colors) => ({
  plusGlyph: {
    width: PLUS_SIZE,
    height: PLUS_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusGlyphOpen: { transform: [{ rotate: '45deg' }] },
  plusBarH: {
    position: 'absolute',
    top: (PLUS_SIZE - PLUS_THICK) / 2,
    left: 0,
    width: PLUS_SIZE,
    height: PLUS_THICK,
    borderRadius: PLUS_THICK / 2,
    backgroundColor: colors.onAccent,
  },
  plusBarV: {
    position: 'absolute',
    left: (PLUS_SIZE - PLUS_THICK) / 2,
    top: 0,
    width: PLUS_THICK,
    height: PLUS_SIZE,
    borderRadius: PLUS_THICK / 2,
    backgroundColor: colors.onAccent,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingVertical: 4,
  },
  addBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: {
    color: colors.onAccent,
    fontSize: 16,
    fontWeight: '700',
    // Match the circle height + center so the glyph sits dead-center rather than
    // riding high off the text baseline (the line box, not the ink, was being
    // flex-centered). includeFontPadding is an Android no-op elsewhere.
    lineHeight: 26,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  addBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtnGhostText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.text,
    backgroundColor: colors.card,
  },
  addLabel: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  uploadBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadBtnText: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  charCount: {
    fontSize: 11,
    color: colors.muted,
    textAlign: 'right',
    marginTop: 2,
    marginRight: 32,
  },
  charCountMax: { color: colors.red },
  groupPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 6,
  },
  groupChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  groupChipActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  groupChipText: { fontSize: 11, color: colors.muted },
  groupChipTextActive: { color: colors.accentDark, fontWeight: '600' },
  sortBar: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  sortChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sortChipActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  sortChipText: { fontSize: 11, color: colors.muted },
  sortChipTextActive: { color: colors.accentDark, fontWeight: '600' },
  metaText: { fontSize: 11, color: colors.muted },
  expandBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandBtnText: {
    color: colors.muted,
    fontWeight: '700',
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  deleteBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    color: colors.muted,
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
}));

/** ISO string for a date at local 09:00 (a sensible default time for a due date). */
function isoAtLocalNine(d: Date): string {
  const x = new Date(d);
  x.setHours(9, 0, 0, 0);
  return x.toISOString();
}

function fmtDueLabel(iso: string | null): string {
  if (!iso) return 'No due date';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Lightweight due-date picker: one-tap presets, a calendar (ADR 0273) and a
 * manual YYYY-MM-DD field, working identically on web and native (no native
 * date-picker dependency).
 * Emits a full ISO datetime (the task schema requires one) anchored to local
 * 09:00, or null to clear.
 */
/** The local calendar date of an ISO instant, as YYYY-MM-DD. */
function localYmd(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function DueDatePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
}) {
  const [manual, setManual] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);
  const presets: Array<{ label: string; days: number }> = [
    { label: 'Today', days: 0 },
    { label: 'Tomorrow', days: 1 },
    { label: 'Next week', days: 7 },
  ];
  const applyManual = () => {
    const m = manual.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m)) return;
    const [y, mo, d] = m.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    if (Number.isNaN(dt.getTime())) return;
    onChange(isoAtLocalNine(dt));
    setManual('');
  };
  return (
    <View>
      <Text style={editStyles.dueCurrent}>{fmtDueLabel(value)}</Text>
      <View style={editStyles.presetRow}>
        {presets.map((p) => (
          <Pressable
            key={p.label}
            style={editStyles.presetBtn}
            onPress={() => {
              const dt = new Date();
              dt.setDate(dt.getDate() + p.days);
              onChange(isoAtLocalNine(dt));
            }}
          >
            <Text style={editStyles.presetTxt}>{p.label}</Text>
          </Pressable>
        ))}
        <Pressable style={editStyles.presetBtn} onPress={() => setCalendarOpen(true)}>
          <Text style={editStyles.presetTxt}>📅 Pick date</Text>
        </Pressable>
        {value && (
          <Pressable style={editStyles.presetBtn} onPress={() => onChange(null)}>
            <Text style={[editStyles.presetTxt, { color: colors.red }]}>Clear</Text>
          </Pressable>
        )}
      </View>
      <View style={editStyles.manualRow}>
        <TextInput
          style={editStyles.manualInput}
          value={manual}
          onChangeText={setManual}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={applyManual}
          returnKeyType="done"
        />
        <Pressable style={editStyles.manualSet} onPress={applyManual}>
          <Text style={editStyles.manualSetTxt}>Set</Text>
        </Pressable>
      </View>
      <CalendarPicker
        visible={calendarOpen}
        value={value ? localYmd(value) : null}
        onCancel={() => setCalendarOpen(false)}
        onPick={(v) => {
          setCalendarOpen(false);
          const [y, mo, d] = v.split('-').map(Number);
          onChange(isoAtLocalNine(new Date(y, mo - 1, d)));
        }}
      />
    </View>
  );
}

function TaskEditModal({
  task,
  onClose,
  onSave,
}: {
  task: Task | null;
  onClose: () => void;
  onSave: (patch: UpdateTaskRequest) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDetails(task.details ?? '');
      setDueAt(task.dueAt ?? null);
    }
  }, [task]);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onSave({
        title: trimmed,
        details: details.trim() ? details.trim() : null,
        dueAt: dueAt ?? null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={!!task} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardModalBody>
      <View style={editStyles.scrim}>
        <View style={editStyles.modal}>
          <Text style={editStyles.title}>Edit task</Text>
          <Text style={editStyles.fieldLabel}>Title</Text>
          <TextInput
            style={editStyles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={TASK_TITLE_MAX}
            placeholder="Task title"
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <Text style={editStyles.fieldLabel}>Details</Text>
          <TextInput
            style={[editStyles.input, editStyles.multiline]}
            value={details}
            onChangeText={setDetails}
            maxLength={2000}
            placeholder="Optional notes"
            placeholderTextColor={colors.muted}
            multiline
          />
          <Text style={editStyles.fieldLabel}>Due date</Text>
          <DueDatePicker value={dueAt} onChange={setDueAt} />
          <View style={editStyles.actions}>
            <Pressable style={[editStyles.btn, editStyles.cancelBtn]} onPress={onClose} disabled={busy}>
              <Text style={editStyles.cancelTxt}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[editStyles.btn, editStyles.saveBtn, (busy || !title.trim()) && { opacity: 0.5 }]}
              onPress={() => void submit()}
              disabled={busy || !title.trim()}
            >
              <Text style={editStyles.saveTxt}>{busy ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardModalBody>
    </Modal>
  );
}

function SaveEditModal({
  save,
  onClose,
  onSave,
}: {
  save: Save | null;
  onClose: () => void;
  onSave: (patch: UpdateSaveRequest) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (save) {
      setTitle(save.title);
      setNote(save.note ?? '');
    }
  }, [save]);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      // Empty note clears it (UpdateSaveRequest treats '' as a clear).
      await onSave({ title: trimmed, note: note.trim() });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={!!save} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardModalBody>
      <View style={editStyles.scrim}>
        <View style={editStyles.modal}>
          <Text style={editStyles.title}>Edit save</Text>
          <Text style={editStyles.fieldLabel}>Title</Text>
          <TextInput
            style={editStyles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={200}
            placeholder="Title"
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <Text style={editStyles.fieldLabel}>Note</Text>
          <TextInput
            style={[editStyles.input, editStyles.multiline]}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
            placeholder="Optional note"
            placeholderTextColor={colors.muted}
            multiline
          />
          <View style={editStyles.actions}>
            <Pressable style={[editStyles.btn, editStyles.cancelBtn]} onPress={onClose} disabled={busy}>
              <Text style={editStyles.cancelTxt}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[editStyles.btn, editStyles.saveBtn, (busy || !title.trim()) && { opacity: 0.5 }]}
              onPress={() => void submit()}
              disabled={busy || !title.trim()}
            >
              <Text style={editStyles.saveTxt}>{busy ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardModalBody>
    </Modal>
  );
}

/** Completed, whether or not the 7-day auto-archive (ADR 0092) has since
 *  moved the row to status='archived'. A finished task must read as finished
 *  in either state — keying off `status === 'done'` alone made every
 *  auto-archived task render like fresh open work. */
function isTaskCompleted(t: Task): boolean {
  return t.status === 'done' || (t.status === 'archived' && !!t.completedAt);
}
/** Retired without being done: dropped (ADR 0092), source-deleted (ADR 0143),
 *  or bot-superseded. Never carried a completedAt. */
function isTaskDropped(t: Task): boolean {
  return t.status === 'superseded' || (t.status === 'archived' && !t.completedAt);
}

/**
 * Where a merged row lives: every group holding a copy, by name, so the same
 * to-do saved personally and in a shared group reads "Personal + RDMS" rather
 * than one name and a count. Past three names the rest are counted.
 */
function groupsLabel(groupIds: string[], groupNames: Record<string, string>): string {
  const names = Array.from(new Set(groupIds.map((id) => groupNames[id] ?? id)));
  const shown = names.slice(0, 3).join(' + ');
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

function TasksSection({
  tasks,
  groups,
  groupNames,
  selfId,
  proposals,
  auditProposals,
  onSetStatus,
  onDelete,
  onEdit,
  onCreate,
}: {
  tasks: Task[];
  groups: { id: string; name: string }[];
  groupNames: Record<string, string>;
  selfId: string | null;
  proposals: Proposal[];
  auditProposals: Proposal[];
  onSetStatus: (t: Task, nextStatus: Task['status']) => Promise<void>;
  onDelete: (t: Task) => Promise<void>;
  onEdit: (t: Task, patch: UpdateTaskRequest) => Promise<void>;
  onCreate: (groupId: string, title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Task | null>(null);
  const [taskSheet, setTaskSheet] = useState<TaskAction[] | null>(null);
  const { block, divider } = useProposedBlock(proposals, tasks.length);
  // Tasks lead with the deadline, not the keystroke: a to-do list ordered by
  // when it was typed buries the thing that is due tomorrow under whatever
  // was captured most recently.
  const [sort, setSort] = useState<SortKey>('due-asc');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [targetGroup, setTargetGroup] = useState<string | null>(groups[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  // Tasks are deduped by normalized title - "call dentist" in two
  // different groups is the same logical task. The visible row's effective
  // status is the MOST-OPEN status across all siblings: if any instance is
  // still open/active, the merged row shows in the active list (even if
  // the newest-by-createdAt copy is already done). Otherwise the newest
  // copy is the lead. Toggle/delete fan out across siblings in lockstep.
  const STATUS_PRIORITY: Record<Task['status'], number> = {
    open: 0,
    active: 1,
    done: 2,
    superseded: 3,
    archived: 4,
  };
  const merged = useMemo(() => {
    const byKey = new Map<string, { lead: Task; siblings: Task[] }>();
    for (const t of tasks) {
      const k = normalizeText(t.title);
      const existing = byKey.get(k);
      if (!existing) {
        byKey.set(k, { lead: t, siblings: [] });
        continue;
      }
      // Prefer the most-open sibling as the lead; on a tie, prefer the newer.
      const leadScore = STATUS_PRIORITY[existing.lead.status];
      const candScore = STATUS_PRIORITY[t.status];
      const candWins =
        candScore < leadScore ||
        (candScore === leadScore && t.createdAt > existing.lead.createdAt);
      if (candWins) {
        byKey.set(k, { lead: t, siblings: [existing.lead, ...existing.siblings] });
      } else {
        existing.siblings.push(t);
      }
    }
    return Array.from(byKey.values());
  }, [tasks]);

  const sorted = useMemo(
    () => applySort(
      merged.map((m) => ({ ...m.lead, _siblings: m.siblings })),
      sort,
      (t) => t.title,
      (t) => t.dueAt,
    ),
    [merged, sort],
  );

  // Split active from completed for the collapsible Done section. open
  // and active stay above the fold; done/archived/superseded collapse
  // into a single foldable bucket so the active list stays readable.
  // Stale work (>48h past due, spec v4 §6.2) sinks below live work but stays
  // in the active list — it is not closed, just no longer competing for the
  // top of the screen. Stable within each half, so the chosen sort still
  // governs ordering.
  const activeSorted = useMemo(() => {
    const active = sorted.filter((t) => t.status === 'open' || t.status === 'active');
    const now = Date.now();
    return [
      ...active.filter((t) => !isTaskStale(t.dueAt, now)),
      ...active.filter((t) => isTaskStale(t.dueAt, now)),
    ];
  }, [sorted]);
  // "Done" = completed, in either the done or the auto-archived state.
  const doneSorted = useMemo(
    () => sorted.filter((t) => isTaskCompleted(t)),
    [sorted],
  );
  // "Archived" = retired unfinished / superseded, whether the user dropped it
  // or Chord retired it (each row says which, ADR 0285). Kept separate so
  // completed work isn't buried under work that was abandoned.
  const droppedSorted = useMemo(
    () => sorted.filter((t) => isTaskDropped(t)),
    [sorted],
  );
  const [doneOpen, setDoneOpen] = useState(false);
  const [droppedOpen, setDroppedOpen] = useState(false);

  // Compute the target status ONCE from the visible lead, then coerce the
  // siblings. Toggling each sibling independently produced oscillation when a
  // same-titled task in another group had a different status.
  //
  // The tap only ever moves a row between "live" and "open" — it never sends
  // an already-terminal row to 'done'. Re-checking an auto-archived (ADR 0092)
  // row used to re-stamp completed_at and restart its 7-day archive clock, so
  // the same task appeared to "flip" back to not-done every week.
  const fanOutToggle = async (lead: Task, siblings: Task[]) => {
    const leadLive = lead.status === 'open' || lead.status === 'active';
    const nextStatus: Task['status'] = leadLive ? 'done' : 'open';
    await onSetStatus(lead, nextStatus);
    for (const s of siblings) {
      if (nextStatus === 'done') {
        // Close only siblings that are genuinely open; leave done/archived
        // copies untouched so their completion time and archive clock stand.
        if (s.status === 'open' || s.status === 'active') await onSetStatus(s, 'done');
      } else if (s.status !== 'superseded') {
        // Reopen the recoverable copies (done / archived); 'superseded' is
        // bot-managed and left alone.
        await onSetStatus(s, 'open');
      }
    }
  };
  const fanOutDelete = async (lead: Task, siblings: Task[]) => {
    await onDelete(lead);
    for (const s of siblings) await onDelete(s);
  };
  const fanOutDrop = async (lead: Task, siblings: Task[]) => {
    await onSetStatus(lead, 'archived');
    for (const s of siblings) await onSetStatus(s, 'archived');
  };

  const submit = useCallback(async () => {
    if (!targetGroup || !draft.trim()) return;
    setBusy(true);
    try {
      await onCreate(targetGroup, draft.trim());
      setDraft('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }, [targetGroup, draft, onCreate]);

  // Count the live list only — the badge used to include done, archived and
  // superseded rows, so it read far higher than what was on screen.
  return (
    <Section title="Tasks" count={activeSorted.length + proposals.length}>
      <View style={addStyles.addRow}>
        <Pressable style={addStyles.addBtn} onPress={() => setAdding((v) => !v)} hitSlop={8}>
          <PlusGlyph open={adding} />
        </Pressable>
        <Text style={addStyles.addLabel}>Add task</Text>
      </View>
      {adding && (
        <View style={{ marginBottom: 10 }}>
          <GroupPicker groups={groups} selected={targetGroup} onSelect={setTargetGroup} />
          <View style={addStyles.addRow}>
            <TextInput
              style={addStyles.addInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Task title"
              maxLength={TASK_TITLE_MAX}
              autoFocus
              onSubmitEditing={() => void submit()}
              returnKeyType="done"
            />
            <Pressable
              style={[addStyles.addBtn, busy && { opacity: 0.5 }]}
              disabled={busy || !draft.trim() || !targetGroup}
              onPress={() => void submit()}
            >
              <Text style={addStyles.addBtnText}>↵</Text>
            </Pressable>
          </View>
          <CharCount value={draft} max={TASK_TITLE_MAX} />
        </View>
      )}
      <SortBar sort={sort} onChange={setSort} alphaLabel="A–Z" dueLabel="Due" />
      {block}
      {divider}
      {activeSorted.map((t) => renderTaskRow(t))}
      {doneSorted.length > 0 && (
        <>
          <Pressable
            onPress={() => setDoneOpen((v) => !v)}
            style={styles.doneToggle}
            hitSlop={6}
          >
            <Text style={styles.doneToggleText}>
              {doneOpen ? '▾' : '▸'} Done · {doneSorted.length}
            </Text>
          </Pressable>
          {doneOpen && doneSorted.map((t) => renderTaskRow(t))}
        </>
      )}
      {droppedSorted.length > 0 && (
        <>
          <Pressable
            onPress={() => setDroppedOpen((v) => !v)}
            style={styles.doneToggle}
            hitSlop={6}
          >
            <Text style={styles.doneToggleText}>
              {droppedOpen ? '▾' : '▸'} Archived · {droppedSorted.length}
            </Text>
          </Pressable>
          {droppedOpen && droppedSorted.map((t) => renderTaskRow(t))}
        </>
      )}
      <AuditBlock proposals={auditProposals} />
      <TaskEditModal
        task={editing}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (editing) await onEdit(editing, patch);
        }}
      />
      <ActionSheet
        open={taskSheet !== null}
        rows={(taskSheet ?? []).map((a) => ({
          key: a.key,
          icon: a.icon,
          label: a.label,
          onPress: a.onPress,
        }))}
        onClose={() => setTaskSheet(null)}
      />
    </Section>
  );

  function renderTaskRow(t: Task & { _siblings?: Task[] }) {
    const siblings = t._siblings ?? [];
    const live = t.status === 'open' || t.status === 'active';
    const completed = isTaskCompleted(t);
    const dropped = isTaskDropped(t);
    const stale = live && isTaskStale(t.dueAt);
    const due = dueLabel(t.dueAt);
    const overdue = live && due?.endsWith('overdue');
    return (
      <View key={t.id} style={styles.row}>
        <Pressable onPress={() => void fanOutToggle(t, siblings)}>
          <View
            style={[
              styles.check,
              completed && { backgroundColor: colors.green, borderColor: colors.green },
            ]}
          />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => void fanOutToggle(t, siblings)}>
            <Text
              style={[
                styles.rowText,
                completed && { color: colors.muted, textDecorationLine: 'line-through' },
                dropped && { color: colors.muted },
                t.status === 'active' && { color: colors.accent },
                stale && { color: colors.muted },
              ]}
            >
              {t.title}
              {t.status === 'active' ? '  ⟳' : ''}
            </Text>
          </Pressable>
          {dropped && t.archivedReason ? (
            <Text style={addStyles.metaText} numberOfLines={1}>
              Archived: {archivedReasonText(t.archivedReason)}
            </Text>
          ) : null}
          <Text style={addStyles.metaText} numberOfLines={1}>
            {due ? (
              <Text style={overdue && !stale ? { color: colors.accent } : undefined}>
                {due}
                {' · '}
              </Text>
            ) : null}
            {t.assigneePersonaName ? `for ${t.assigneePersonaName} · managed · ` : ''}
            {fmtRelative(t.createdAt)} · by {creatorLabel(t.createdBy, t.createdByName, selfId)}
            {' · '}
            {groupsLabel([t.groupId, ...siblings.map((x) => x.groupId)], groupNames)}
          </Text>
        </View>
        <TaskProvenanceButton task={t} />
        <Pressable
          onPress={() => setEditing(t)}
          hitSlop={8}
          style={{ paddingHorizontal: 6 }}
          accessibilityLabel={`Edit ${t.title}`}
        >
          <Text style={{ color: colors.muted, fontSize: 14 }}>✎</Text>
        </Pressable>
        <Pressable
          style={styles.taskMoreBtn}
          onPress={() =>
            openTaskActions(
              t,
              () => setEditing(t),
              () => void fanOutDelete(t, siblings),
              () => void fanOutDrop(t, siblings),
              setTaskSheet,
            )
          }
          hitSlop={8}
        >
          <Text style={styles.taskMoreTxt}>⋯</Text>
        </Pressable>
      </View>
    );
  }
}

// ── Lists ────────────────────────────────────────────────────────────

/**
 * Infer a visual "kind" from the list's name - we don't yet persist a kind
 * column, but the name pattern is reliable enough for the demo.
 */
function listKind(
  name: string,
): { label: string; icon: string; bg: string; fg: string } {
  const label = listKindLabel(name);
  if (label === 'grocery') {
    return { label, icon: '🛒', ...byScheme({ bg: '#e6f4ea', fg: '#1e7a3b' }, { bg: '#16301F', fg: '#4ADE80' }) };
  }
  if (label === 'packing') {
    return { label, icon: '🧳', ...byScheme({ bg: '#e8efff', fg: '#1c4db3' }, { bg: '#1B2440', fg: '#93B4FF' }) };
  }
  if (label === 'todo') {
    return { label, icon: '✅', ...byScheme({ bg: '#fff4d6', fg: '#8a6100' }, { bg: '#3A3014', fg: '#FBBF24' }) };
  }
  return { label, icon: '📋', ...byScheme({ bg: '#ebe9e4', fg: '#5a5750' }, { bg: '#2B2A27', fg: '#C9C6BC' }) };
}

// `listKindLabel` lives in @chord/kernel/list-kind so the server tests can
// exercise it without an RN runtime.

type ListWithItems = List & { items: ListItem[] };
type ClusterMember = ListWithItems & { groupName: string };

/** One visible row: the item we act on, plus its twins in other groups. */
interface ClusterItem {
  lead: ListItem;
  siblings: ListItem[];
  /** Every group holding this text, in cluster order. */
  groupNames: string[];
  /** Done only when EVERY copy is - a copy still open in another group is
   *  still to do. Mirrors the most-open-wins rule the Tasks tab merges by;
   *  reading the lead alone would strike out a row that is not finished, and
   *  now that done rows sink it would also sink it. */
  checked: boolean;
}

/** One card: every same-named list across the user's groups. */
interface ListCluster {
  key: string;
  /** Sorting + the displayed date follow the NEWEST member, so "Latest"
   *  still means what it says once four lists share a card. */
  createdAt: string;
  /** Names + receives new items: the OLDEST member, the same tiebreak
   *  `mergeListInto` uses when it really does fold two lists together. */
  lead: ClusterMember;
  name: string;
  lists: ClusterMember[];
  /** Distinct group names for the card's meta line - shorter than `lists`
   *  whenever one group holds two same-named lists. */
  groupNames: string[];
  items: ClusterItem[];
}

/**
 * Open rows on top, done rows at the bottom, each half in the list's own
 * order (oldest first, the order the server returns items in).
 *
 * A checked item is not deleted and has nowhere else to go, so left in place
 * it sits between the things still to do - and on a list the bot keeps
 * appending to, the finished half is the older half, so it accumulates at
 * exactly the top of the card. The same shape the Tasks tab already has,
 * minus the fold: a list item is one line, not worth hiding behind a
 * disclosure, and seeing what was done is half of why people keep the list.
 *
 * Sorting across member lists rather than within each one also fixes a
 * clustering artifact: items used to run all of group A's, then all of
 * group B's.
 */
function sinkChecked(items: ClusterItem[]): ClusterItem[] {
  const byAge = (a: ClusterItem, b: ClusterItem) =>
    a.lead.createdAt.localeCompare(b.lead.createdAt);
  return [
    ...items.filter((i) => !i.checked).sort(byAge),
    ...items.filter((i) => i.checked).sort(byAge),
  ];
}

/**
 * Group same-named lists across groups into one card - a view, never a write.
 *
 * The name rule is `listNameKey` (ADR 0094), the same one the bot resolves
 * with, so "restaurant" and "Restaurant list" land on one card exactly when
 * the bot would treat them as one list. Items dedup on `normalizeText`, the
 * rule `addItem` already dedups on within a list.
 */
function clusterListsByName(
  lists: ListWithItems[],
  groupNames: Record<string, string>,
): ListCluster[] {
  const oldestFirst = [...lists]
    .map((l) => ({ ...l, groupName: groupNames[l.groupId] ?? l.groupId }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byKey = new Map<string, ClusterMember[]>();
  for (const l of oldestFirst) {
    const key = listNameKey(l.name);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(l);
    else byKey.set(key, [l]);
  }

  return Array.from(byKey.entries()).map(([key, members]) => {
    const lead = members[0]!;
    const items = new Map<string, ClusterItem>();
    for (const l of members) {
      for (const it of l.items) {
        const k = normalizeText(it.text);
        const seen = items.get(k);
        if (seen) {
          seen.siblings.push(it);
          seen.checked = seen.checked && it.checked;
          if (!seen.groupNames.includes(l.groupName)) seen.groupNames.push(l.groupName);
        } else {
          items.set(k, {
            lead: it,
            siblings: [],
            groupNames: [l.groupName],
            checked: it.checked,
          });
        }
      }
    }
    return {
      key,
      createdAt: members.reduce((n, l) => (l.createdAt > n ? l.createdAt : n), lead.createdAt),
      lead,
      name: lead.name,
      lists: members,
      groupNames: Array.from(new Set(members.map((l) => l.groupName))),
      items: sinkChecked(Array.from(items.values())),
    };
  });
}


function ListsSection({
  lists,
  groups,
  personalGroupId,
  groupNames,
  selfId: _selfId,
  proposals,
  auditProposals,
  onToggleItem,
  onDeleteList,
  onMoveToSaves,
  onRenameList,
  onDeleteItem,
  onEditItem,
  onCreateList,
  onAddItem,
}: {
  lists: ListWithItems[];
  groups: { id: string; name: string }[];
  personalGroupId: string | null;
  groupNames: Record<string, string>;
  selfId: string | null;
  proposals: Proposal[];
  auditProposals: Proposal[];
  onToggleItem: (item: ListItem, next?: boolean) => Promise<void>;
  onDeleteList: (listId: string) => Promise<void>;
  onMoveToSaves: (listId: string, name: string) => Promise<void>;
  onRenameList: (listId: string, name: string) => Promise<void>;
  onDeleteItem: (item: ListItem) => Promise<void>;
  onEditItem: (item: ListItem, text: string) => Promise<void>;
  onCreateList: (groupId: string, name: string) => Promise<void>;
  onAddItem: (listId: string, text: string) => Promise<void>;
}) {
  const { block, divider } = useProposedBlock(proposals, lists.length);
  const [sort, setSort] = useState<SortKey>('added-desc');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [targetGroup, setTargetGroup] = useState<string | null>(groups[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  // Lists with the same name in different groups are shown as ONE card, not
  // merged: four "To-dos" cards were four groups, and reading them as four
  // separate lists is the user's problem, not the data's. Group scope is a
  // security boundary (ADR 0004), so the rows stay where they are - the card
  // is a view over them, and every row says which group it came from.
  const clusters = useMemo(
    () => clusterListsByName(lists, groupNames),
    [lists, groupNames],
  );

  const sorted = useMemo(
    () => applySort(clusters, sort, (c) => c.name),
    [clusters, sort],
  );

  // Tab badge counts ACTIONABLE leaves, parallel to Tasks (task rows) and
  // Saves (save rows). For lists the leaf is the list_item - not the list
  // container - and after clustering the visible leaf is the merged row, so
  // "milk" in two groups counts once, the way it now renders once. Checked
  // rows are excluded for the same reason Tasks excludes done ones: the
  // badge is what's outstanding, and a badge that never falls when you tick
  // things off is a badge nobody reads.
  const visibleItemCount = useMemo(
    () => clusters.reduce((sum, c) => sum + c.items.filter((i) => !i.checked).length, 0),
    [clusters],
  );

  const submit = useCallback(async () => {
    if (!targetGroup || !draft.trim()) return;
    setBusy(true);
    try {
      await onCreateList(targetGroup, draft.trim());
      setDraft('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }, [targetGroup, draft, onCreateList]);

  return (
    <Section title="Lists" count={visibleItemCount + proposals.length}>
      <View style={addStyles.addRow}>
        <Pressable style={addStyles.addBtn} onPress={() => setAdding((v) => !v)} hitSlop={8}>
          <PlusGlyph open={adding} />
        </Pressable>
        <Text style={addStyles.addLabel}>New list</Text>
      </View>
      {adding && (
        <View style={{ marginBottom: 10 }}>
          <GroupPicker groups={groups} selected={targetGroup} onSelect={setTargetGroup} />
          <View style={addStyles.addRow}>
            <TextInput
              style={addStyles.addInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="List name"
              maxLength={LIST_NAME_MAX}
              autoFocus
              onSubmitEditing={() => void submit()}
              returnKeyType="done"
            />
            <Pressable
              style={[addStyles.addBtn, busy && { opacity: 0.5 }]}
              disabled={busy || !draft.trim() || !targetGroup}
              onPress={() => void submit()}
            >
              <Text style={addStyles.addBtnText}>↵</Text>
            </Pressable>
          </View>
          <CharCount value={draft} max={LIST_NAME_MAX} />
        </View>
      )}
      <SortBar sort={sort} onChange={setSort} alphaLabel="Name" />
      {block}
      {divider}
      {sorted.map((c) => (
        <ListCard
          key={c.key}
          cluster={c}
          personalGroupId={personalGroupId}
          onToggleItem={onToggleItem}
          onDeleteList={onDeleteList}
          onMoveToSaves={onMoveToSaves}
          onRenameList={onRenameList}
          onDeleteItem={onDeleteItem}
          onEditItem={onEditItem}
          onAddItem={onAddItem}
        />
      ))}
      <AuditBlock proposals={auditProposals} />
    </Section>
  );
}

function ListCard({
  cluster,
  personalGroupId,
  onToggleItem,
  onDeleteList,
  onMoveToSaves,
  onRenameList,
  onDeleteItem,
  onEditItem,
  onAddItem,
}: {
  cluster: ListCluster;
  personalGroupId: string | null;
  onToggleItem: (item: ListItem, next?: boolean) => Promise<void>;
  onDeleteList: (listId: string) => Promise<void>;
  onMoveToSaves: (listId: string, name: string) => Promise<void>;
  onRenameList: (listId: string, name: string) => Promise<void>;
  onDeleteItem: (item: ListItem) => Promise<void>;
  onEditItem: (item: ListItem, text: string) => Promise<void>;
  onAddItem: (listId: string, text: string) => Promise<void>;
}) {
  const kind = listKind(cluster.name);
  // A card over several groups cannot carry the whole-list controls in its
  // header: one tap on `×` would delete four groups' lists, and a rename
  // would silently retitle somebody else's. Those move into the footer, one
  // row per real list.
  const spans = cluster.lists.length > 1;
  const showRowGroups = cluster.groupNames.length > 1;
  const [expanded, setExpanded] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [itemDraft, setItemDraft] = useState('');
  // Personal is the default: on a card spanning groups a new item starts on
  // the personal copy when there is one, and reaches a shared group only by
  // picking it. With no personal copy it starts on the list naming the card.
  const [addTargetId, setAddTargetId] = useState(
    () => (cluster.lists.find((l) => l.groupId === personalGroupId) ?? cluster.lead).id,
  );
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(cluster.name);
  // Per-item inline edit, keyed by the lead item's id.
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemTextDraft, setItemTextDraft] = useState('');

  const submitRename = useCallback(async () => {
    const next = nameDraft.trim();
    if (!next || next === cluster.name) {
      setEditingName(false);
      setNameDraft(cluster.name);
      return;
    }
    setBusy(true);
    try {
      await onRenameList(cluster.lead.id, next);
      setEditingName(false);
    } finally {
      setBusy(false);
    }
  }, [nameDraft, cluster.name, cluster.lead.id, onRenameList]);

  const submitItem = useCallback(async () => {
    if (!itemDraft.trim()) return;
    // The picked list can vanish under us (a rename splits the cluster, a
    // refetch drops it); fall back to the one that names the card.
    const targetId = cluster.lists.some((l) => l.id === addTargetId)
      ? addTargetId
      : cluster.lead.id;
    setBusy(true);
    try {
      await onAddItem(targetId, itemDraft.trim());
      setItemDraft('');
    } finally {
      setBusy(false);
    }
  }, [itemDraft, addTargetId, cluster.lists, cluster.lead.id, onAddItem]);

  const totalItems = cluster.items.length;
  const doneItems = cluster.items.filter((i) => i.checked).length;
  const openItems = totalItems - doneItems;
  // What's left is the number that matters; the done count rides along so a
  // list that reads "0 left" doesn't look emptied.
  const itemSummary = totalItems === 0
    ? 'empty'
    : doneItems > 0
      ? `${openItems} left · ${doneItems} done`
      : `${totalItems} item${totalItems === 1 ? '' : 's'}`;

  const confirmDelete = useCallback(() => {
    confirmDestructive(cluster.name, 'Delete this list and all its items?', () =>
      void onDeleteList(cluster.lead.id),
    );
  }, [cluster.name, cluster.lead.id, onDeleteList]);

  // Every copy is coerced to ONE target state rather than flipped
  // individually: two copies in opposite states would swap on each tap and
  // the merged row would never settle.
  const fanOutToggle = async (ci: ClusterItem) => {
    const next = !ci.checked;
    await onToggleItem(ci.lead, next);
    for (const s of ci.siblings) await onToggleItem(s, next);
  };

  const fanOutDelete = (ci: ClusterItem) => {
    const run = async () => {
      await onDeleteItem(ci.lead);
      for (const s of ci.siblings) await onDeleteItem(s);
    };
    if (ci.siblings.length === 0) {
      void run();
      return;
    }
    confirmDestructive(
      ci.lead.text,
      `Remove this from ${ci.groupNames.join(' and ')}?`,
      () => void run(),
    );
  };

  const submitItemEdit = async (ci: ClusterItem) => {
    const next = itemTextDraft.trim();
    setEditingItemId(null);
    if (!next || next === ci.lead.text) return;
    // Siblings take the same text, or the row splits in two on the next
    // render and the edit looks like it half-applied.
    await onEditItem(ci.lead, next);
    for (const s of ci.siblings) await onEditItem(s, next);
  };

  return (
    <View style={styles.subCard}>
      <View style={styles.listHeader}>
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          hitSlop={8}
          style={addStyles.expandBtn}
        >
          <Text style={addStyles.expandBtnText}>{expanded ? '−' : '+'}</Text>
        </Pressable>
        {editingName ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TextInput
              style={[addStyles.addInput, { flex: 1 }]}
              value={nameDraft}
              onChangeText={setNameDraft}
              maxLength={LIST_NAME_MAX}
              autoFocus
              onSubmitEditing={() => void submitRename()}
              onBlur={() => void submitRename()}
              returnKeyType="done"
              editable={!busy}
            />
          </View>
        ) : (
          <Pressable style={{ flex: 1 }} onPress={() => setExpanded((v) => !v)}>
            <Text style={styles.subCardTitle}>{cluster.name}</Text>
            <Text style={addStyles.metaText} numberOfLines={1}>
              {itemSummary} · {fmtRelative(cluster.createdAt)} ·{' '}
              {cluster.groupNames.join(' · ')}
            </Text>
          </Pressable>
        )}
        <View style={[styles.listKindChip, { backgroundColor: kind.bg }]}>
          <Text style={[styles.listKindChipText, { color: kind.fg }]}>
            {kind.icon} {kind.label}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            setExpanded(true);
            setAddingItem((v) => !v);
          }}
          hitSlop={8}
          style={[addStyles.addBtn, { marginLeft: 6 }]}
        >
          <PlusGlyph open={addingItem} />
        </Pressable>
        {!spans && (
          <>
            <Pressable
              onPress={() => {
                setNameDraft(cluster.name);
                setEditingName((v) => !v);
              }}
              hitSlop={8}
              style={[addStyles.addBtn, { marginLeft: 6 }]}
            >
              <Text style={addStyles.addBtnText}>✎</Text>
            </Pressable>
            <Pressable
              onPress={confirmDelete}
              hitSlop={8}
              style={[addStyles.deleteBtn, { marginLeft: 6 }]}
            >
              <Text style={addStyles.deleteBtnText}>×</Text>
            </Pressable>
          </>
        )}
      </View>
      {expanded && addingItem && (
        <>
        <GroupPicker
          groups={cluster.lists.map((l) => ({ id: l.id, name: l.groupName }))}
          selected={addTargetId}
          onSelect={setAddTargetId}
        />
        <View style={[addStyles.addRow, { marginTop: 8 }]}>
          <TextInput
            style={addStyles.addInput}
            value={itemDraft}
            onChangeText={setItemDraft}
            placeholder="Add item…"
            maxLength={LIST_ITEM_MAX}
            autoFocus
            onSubmitEditing={() => void submitItem()}
            returnKeyType="done"
          />
          <Pressable
            style={[addStyles.addBtn, busy && { opacity: 0.5 }]}
            disabled={busy || !itemDraft.trim()}
            onPress={() => void submitItem()}
          >
            <Text style={addStyles.addBtnText}>↵</Text>
          </Pressable>
        </View>
        <CharCount value={itemDraft} max={LIST_ITEM_MAX} />
        </>
      )}
      {expanded &&
        cluster.items.map((ci) => {
          const item = ci.lead;
          const checked = ci.checked;
          const itemUrl = extractUrl(item.text);
          // Strip the URL out of the visible label when present, so the
          // text reads "Mt Si trail" not "Mt Si trail https://…".
          const labelText = itemUrl ? item.text.replace(itemUrl, '').trim() : item.text;
          const editingItem = editingItemId === item.id;
          return (
            <View key={item.id} style={[styles.row, { alignItems: 'center' }]}>
              <Pressable onPress={() => void fanOutToggle(ci)}>
                <View
                  style={[
                    styles.check,
                    checked && { backgroundColor: colors.green, borderColor: colors.green },
                    { marginRight: 8 },
                  ]}
                />
              </Pressable>
              <View style={{ flex: 1, gap: 2 }}>
                {editingItem ? (
                  <TextInput
                    style={[addStyles.addInput, { flex: 1 }]}
                    value={itemTextDraft}
                    onChangeText={setItemTextDraft}
                    maxLength={LIST_ITEM_MAX}
                    autoFocus
                    onSubmitEditing={() => void submitItemEdit(ci)}
                    onBlur={() => void submitItemEdit(ci)}
                    returnKeyType="done"
                  />
                ) : (
                  <Pressable onPress={() => void fanOutToggle(ci)}>
                    {labelText.length > 0 && (
                      <Text
                        style={[
                          styles.rowText,
                          checked && { color: colors.muted, textDecorationLine: 'line-through' },
                        ]}
                      >
                        {labelText}
                      </Text>
                    )}
                  </Pressable>
                )}
                {itemUrl && <LinkChip url={itemUrl} />}
                {showRowGroups && (
                  <View style={styles.rowGroupChips}>
                    {ci.groupNames.map((g) => (
                      <View key={g} style={styles.rowGroupChip}>
                        <Text style={styles.rowGroupChipText} numberOfLines={1}>
                          {g}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              {!editingItem && (
                <Pressable
                  onPress={() => {
                    setItemTextDraft(item.text);
                    setEditingItemId(item.id);
                  }}
                  hitSlop={8}
                  style={{ paddingHorizontal: 6 }}
                >
                  <Text style={{ color: colors.muted, fontSize: 14 }}>✎</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => fanOutDelete(ci)}
                hitSlop={8}
                style={{ paddingHorizontal: 6 }}
              >
                <Text style={{ color: colors.muted, fontSize: 16 }}>×</Text>
              </Pressable>
            </View>
          );
        })}
      {expanded && !spans && (
        <Pressable
          onPress={() => confirmMoveToSaves(cluster.lead, onMoveToSaves)}
          hitSlop={8}
          style={{ marginTop: 8, alignSelf: 'flex-start' }}
        >
          <Text style={addStyles.metaText}>🔖 Move to Saves</Text>
        </Pressable>
      )}
      {expanded && spans && (
        <>
          <Text style={[addStyles.metaText, { marginTop: 10, marginBottom: 2 }]}>
            {cluster.lists.length} lists · rename, move or delete each on its own
          </Text>
          {cluster.lists.map((l) => (
            <ClusterMemberRow
              key={l.id}
              list={l}
              groupName={l.groupName}
              onRename={(name) => onRenameList(l.id, name)}
              onDelete={() => onDeleteList(l.id)}
              onMoveToSaves={() => confirmMoveToSaves(l, onMoveToSaves)}
            />
          ))}
        </>
      )}
    </View>
  );
}

/**
 * One real list inside a multi-group card. Rename and delete stay per-list:
 * the card is a view, and these two are the operations that would otherwise
 * reach into a group the user did not name.
 */
function ClusterMemberRow({
  list,
  groupName,
  onRename,
  onDelete,
  onMoveToSaves,
}: {
  list: ListWithItems;
  groupName: string;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onMoveToSaves: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(list.name);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === list.name) {
      setDraft(list.name);
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.row, { alignItems: 'center' }]}>
      {editing ? (
        <TextInput
          style={[addStyles.addInput, { flex: 1 }]}
          value={draft}
          onChangeText={setDraft}
          maxLength={LIST_NAME_MAX}
          autoFocus
          onSubmitEditing={() => void submit()}
          onBlur={() => void submit()}
          returnKeyType="done"
          editable={!busy}
        />
      ) : (
        <Text style={[styles.rowText, { flex: 1 }]} numberOfLines={1}>
          {list.name} · <Text style={{ color: colors.muted }}>{groupName}</Text>
        </Text>
      )}
      {!editing && (
        <Pressable
          onPress={() => {
            setDraft(list.name);
            setEditing(true);
          }}
          hitSlop={8}
          style={{ paddingHorizontal: 6 }}
        >
          <Text style={{ color: colors.muted, fontSize: 14 }}>✎</Text>
        </Pressable>
      )}
      <Pressable onPress={onMoveToSaves} hitSlop={8} style={{ paddingHorizontal: 6 }}>
        <Text style={{ color: colors.muted, fontSize: 14 }}>🔖</Text>
      </Pressable>
      <Pressable
        onPress={() =>
          confirmDestructive(
            `${list.name} · ${groupName}`,
            'Delete this list and all its items?',
            () => void onDelete(),
          )
        }
        hitSlop={8}
        style={{ paddingHorizontal: 6 }}
      >
        <Text style={{ color: colors.muted, fontSize: 16 }}>×</Text>
      </Pressable>
    </View>
  );
}
/** Lists are for ticking off; places and the like belong in Saves (ADR 0290).
 *  Confirmed because the list itself goes away. */
function confirmMoveToSaves(
  list: { id: string; name: string; items: ListItem[] },
  onMove: (listId: string, name: string) => Promise<void>,
): void {
  const n = list.items.length;
  confirmDestructive(
    list.name,
    `Move ${n} item${n === 1 ? '' : 's'} to Saves, tagged "${saveTagForListName(list.name)}"? The list will be removed.`,
    () => void onMove(list.id, list.name),
    { confirmLabel: 'Move' },
  );
}

// ── Saves ────────────────────────────────────────────────────────────

function SavesSection({
  saves,
  groups,
  groupNames,
  selfId,
  proposals,
  auditProposals,
  onCreate,
  onDelete,
  onEdit,
}: {
  saves: Save[];
  groups: { id: string; name: string }[];
  groupNames: Record<string, string>;
  selfId: string | null;
  proposals: Proposal[];
  auditProposals: Proposal[];
  onCreate: (groupId: string, title: string, url: string | undefined) => Promise<void>;
  onDelete: (saveId: string) => Promise<void>;
  onEdit: (s: Save, patch: UpdateSaveRequest) => Promise<void>;
}) {
  const { block, divider } = useProposedBlock(proposals, saves.length);
  const [sort, setSort] = useState<SortKey>('added-desc');
  const [editing, setEditing] = useState<Save | null>(null);
  const [adding, setAdding] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [targetGroup, setTargetGroup] = useState<string | null>(groups[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Dedupe saves by (kind + canonical url + createdBy). When the same
  // user has saved the same link in multiple groups, show one row.
  // We keep the most recent occurrence and remember the others as
  // group context shown in the meta line.
  const deduped = useMemo(() => {
    const byKey = new Map<string, Save & { extraGroups: string[] }>();
    for (const s of saves) {
      const urlKey = s.url ? s.url.trim().toLowerCase() : `title:${s.title.trim().toLowerCase()}`;
      const k = `${s.kind}|${urlKey}|${s.createdBy ?? '-'}`;
      const existing = byKey.get(k);
      if (!existing) {
        byKey.set(k, { ...s, extraGroups: [] });
      } else if (s.createdAt > existing.createdAt) {
        byKey.set(k, {
          ...s,
          extraGroups: [...existing.extraGroups, existing.groupId],
        });
      } else {
        existing.extraGroups.push(s.groupId);
      }
    }
    return Array.from(byKey.values());
  }, [saves]);

  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of deduped) {
      for (const t of s.tags) {
        const key = t.trim().toLowerCase();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [deduped]);

  const filtered = useMemo(() => {
    if (!tagFilter) return deduped;
    return deduped.filter((s) =>
      s.tags.some((t) => t.trim().toLowerCase() === tagFilter),
    );
  }, [deduped, tagFilter]);

  const sorted = useMemo(
    () => applySort(filtered, sort, (s) => s.title),
    [filtered, sort],
  );

  const submit = useCallback(async () => {
    if (!targetGroup || !titleDraft.trim()) return;
    setBusy(true);
    try {
      await onCreate(targetGroup, titleDraft.trim(), urlDraft.trim() || undefined);
      setTitleDraft('');
      setUrlDraft('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }, [targetGroup, titleDraft, urlDraft, onCreate]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Section title="Saves" count={saves.length + proposals.length}>
      <View style={addStyles.addRow}>
        <Pressable style={addStyles.addBtn} onPress={() => setAdding((v) => !v)} hitSlop={8}>
          <PlusGlyph open={adding} />
        </Pressable>
        <Text style={addStyles.addLabel}>Add save</Text>
      </View>
      {adding && (
        <View style={{ marginBottom: 10, gap: 6 }}>
          <GroupPicker groups={groups} selected={targetGroup} onSelect={setTargetGroup} />
          <TextInput
            style={addStyles.addInput}
            value={titleDraft}
            onChangeText={setTitleDraft}
            placeholder="Title"
            autoFocus
          />
          <View style={addStyles.addRow}>
            <TextInput
              style={addStyles.addInput}
              value={urlDraft}
              onChangeText={setUrlDraft}
              placeholder="URL (optional)"
              autoCapitalize="none"
              keyboardType="url"
              onSubmitEditing={() => void submit()}
              returnKeyType="done"
            />
            <Pressable
              style={[addStyles.addBtn, busy && { opacity: 0.5 }]}
              disabled={busy || !titleDraft.trim() || !targetGroup}
              onPress={() => void submit()}
            >
              <Text style={addStyles.addBtnText}>↵</Text>
            </Pressable>
          </View>
        </View>
      )}
      <SortBar sort={sort} onChange={setSort} alphaLabel="Title" />
      {tagCounts.length > 0 && (
        <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={tagStyles.filterRow}
          contentContainerStyle={tagStyles.filterRowContent}
        >
          <Pressable
            onPress={() => setTagFilter(null)}
            style={[tagStyles.filterChip, tagFilter === null && tagStyles.filterChipActive]}
          >
            <Text style={[tagStyles.filterChipText, tagFilter === null && tagStyles.filterChipTextActive]}>
              All ({deduped.length})
            </Text>
          </Pressable>
          {tagCounts.map(([tag, count]) => (
            <Pressable
              key={tag}
              onPress={() => setTagFilter(tagFilter === tag ? null : tag)}
              style={[tagStyles.filterChip, tagFilter === tag && tagStyles.filterChipActive]}
            >
              <Text style={[tagStyles.filterChipText, tagFilter === tag && tagStyles.filterChipTextActive]}>
                {tag} ({count})
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {block}
      {divider}
      {sorted.map((s) => {
        const expanded = expandedIds.has(s.id);
        const isPlace = s.kind === 'place';
        const placeQuery = isPlace ? `${s.title}${s.note ? ' ' + s.note : ''}` : null;
        return (
          <View key={s.id} style={styles.row}>
            <Pressable
              onPress={() => toggleExpand(s.id)}
              hitSlop={8}
              style={addStyles.expandBtn}
            >
              <Text style={addStyles.expandBtnText}>{expanded ? '−' : '+'}</Text>
            </Pressable>
            <Pressable style={{ flex: 1 }} onPress={() => toggleExpand(s.id)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {s.url && (
                  <Image source={{ uri: faviconUrl(s.url) }} style={richStyles.favicon} />
                )}
                {isPlace && <Text style={richStyles.mapPin}>📍</Text>}
                <Text style={styles.tag}>{s.kind}</Text>
                <Text style={[styles.rowText, { flex: 1 }]} numberOfLines={1}>
                  {s.title}
                </Text>
              </View>
              <Text style={addStyles.metaText} numberOfLines={1}>
                {fmtRelative(s.createdAt)} · by {creatorLabel(s.createdBy, s.createdByName, selfId)}
                {' · '}
                {groupsLabel([s.groupId, ...s.extraGroups], groupNames)}
              </Text>
              {!expanded && s.tags.length > 0 && (
                <View style={tagStyles.inlineTagRow}>
                  {s.tags.slice(0, 4).map((t) => (
                    <Pressable
                      key={t}
                      onPress={() => setTagFilter(t.trim().toLowerCase())}
                      hitSlop={4}
                      style={tagStyles.inlineTagChip}
                    >
                      <Text style={tagStyles.inlineTagText}>#{t}</Text>
                    </Pressable>
                  ))}
                  {s.tags.length > 4 && (
                    <Text style={tagStyles.inlineTagMore}>+{s.tags.length - 4}</Text>
                  )}
                </View>
              )}
              {expanded && (
                <View style={{ marginTop: 6, gap: 4 }}>
                  {s.url && <LinkChip url={s.url} label={s.title} />}
                  {isPlace && placeQuery && (
                    <LinkChip url={placeMapsUrl(placeQuery)} label="Open in Maps" icon="🗺️" />
                  )}
                  {s.note && (
                    <Text style={addStyles.metaText} numberOfLines={3}>
                      {s.note}
                    </Text>
                  )}
                  {s.tags.length > 0 && (
                    <Text style={addStyles.metaText} numberOfLines={1}>
                      tags: {s.tags.join(', ')}
                    </Text>
                  )}
                </View>
              )}
            </Pressable>
            <ProvenanceButton label={s.title} raw={s.sourceRawContext} small />
            <Pressable
              onPress={() => setEditing(s)}
              hitSlop={8}
              style={{ paddingHorizontal: 6 }}
            >
              <Text style={{ color: colors.muted, fontSize: 15 }}>✏️</Text>
            </Pressable>
            <Pressable
              onPress={() => void onDelete(s.id)}
              hitSlop={8}
              style={{ paddingHorizontal: 6 }}
            >
              <Text style={{ color: colors.muted, fontSize: 16 }}>×</Text>
            </Pressable>
          </View>
        );
      })}
      <AuditBlock proposals={auditProposals} />
      <SaveEditModal
        save={editing}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (editing) await onEdit(editing, patch);
        }}
      />
    </Section>
  );
}

// ── Trips (read-only completeness card) ─────────────────────────────

const MODE_LABEL: Record<string, string> = {
  flight: 'flight',
  train: 'train',
  car: 'drive',
  ferry: 'ferry',
  other: 'travel',
};

function fmtDt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtDate(iso: string): string {
  // iso is YYYY-MM-DD - parse as local date to avoid UTC-shift
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const RESERVATION_LABEL: Record<string, string> = {
  restaurant: 'dining',
  tour: 'tour',
  event: 'event',
  activity: 'activity',
  other: 'reserve',
};

/**
 * Per-row drag machinery, threaded down from TripsSection (via
 * DraggableTripCard) so a single leg/accommodation row can be long-pressed
 * and dragged onto a DIFFERENT trip card — split one item out without
 * moving the whole trip. Omitted entirely outside the "live trips" render
 * path (past/deleted trips aren't drag sources, same restriction the
 * whole-card merge gesture already has).
 */
interface RowDragProps {
  dragHoverId: SharedValue<string | null>;
  measureRowTargets: (sourceTripId: string, groupId: string) => Promise<DropRect[]>;
  onRowDrop: (kind: 'leg' | 'accommodation', itemId: string, fromTripId: string, targetTripId: string) => void;
  /** The enclosing card's own long-press-drag gesture (whole-trip merge) —
   *  a row's gesture blocks it once the row's own long-press activates, so
   *  one touch is never read as both "move this leg" and "merge this trip". */
  cardPan: GestureType;
  disabled: boolean;
}

function TripCard({
  t,
  currentUserId,
  onChanged,
  rowDrag,
}: {
  t: TripStatus;
  currentUserId?: string | null;
  onChanged?: () => void | Promise<void>;
  rowDrag?: RowDragProps;
}) {
  const isDeleted = !!t.trip.deletedAt;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(t.trip.name);
  // The title row renders as "{name} · {destination}" (below), so editing
  // only the name left the destination half stuck forever — the "always
  // keeps part of the old name" report. Both fields are part of what the
  // user sees as "the trip's name," so both are editable together.
  const [destDraft, setDestDraft] = useState(t.trip.destination);
  const [renaming, setRenaming] = useState(false);
  const submitRename = useCallback(async () => {
    const nextName = nameDraft.trim();
    const nextDest = destDraft.trim();
    const patch: { name?: string; destination?: string } = {};
    if (nextName && nextName !== t.trip.name) patch.name = nextName;
    if (nextDest && nextDest !== t.trip.destination) patch.destination = nextDest;
    if (Object.keys(patch).length === 0) {
      setEditingName(false);
      setNameDraft(t.trip.name);
      setDestDraft(t.trip.destination);
      return;
    }
    setRenaming(true);
    try {
      await updateTrip(t.trip.groupId, t.trip.id, patch);
      setEditingName(false);
      await onChanged?.();
    } catch {
      setNameDraft(t.trip.name);
      setDestDraft(t.trip.destination);
    } finally {
      setRenaming(false);
    }
  }, [nameDraft, destDraft, t.trip.name, t.trip.destination, t.trip.groupId, t.trip.id, onChanged]);
  type TimelineItem =
    | { sortKey: string; kind: 'leg'; leg: TravelLeg }
    | { sortKey: string; kind: 'stay'; stay: Accommodation }
    | { sortKey: string; kind: 'reservation'; reservation: TripReservation };

  const personaNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    t.trip.participants.forEach((pid, i) => {
      const name = t.participantNames[i];
      if (name) map[pid] = name;
    });
    return map;
  }, [t.trip.participants, t.participantNames]);

  const isMyTrip =
    !currentUserId ||
    t.trip.createdBy === currentUserId ||
    t.trip.participants.includes(currentUserId);

  const items: TimelineItem[] = [
    ...t.legs.map((leg) => ({ sortKey: leg.departAt, kind: 'leg' as const, leg })),
    ...t.accommodations.map((stay) => ({ sortKey: stay.checkinDate, kind: 'stay' as const, stay })),
    ...t.reservations.map((reservation) => ({
      sortKey: reservation.dateTime ?? reservation.createdAt,
      kind: 'reservation' as const, reservation,
    })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // The trip's "source artifact" is what any of its legs/stays was extracted
  // from (the forwarded PNR, hotel confirmation, screenshot, or the email
  // itself). Surface the first one at the trip level so tapping the trip opens it.
  const { open: openSource, viewer: sourceViewer } = useTripSourceViewer();
  const tripSource =
    t.legs.map((l) => tripSourceOf(l, t.trip.name)).find(Boolean) ??
    t.accommodations.map((a) => tripSourceOf(a, t.trip.name)).find(Boolean) ??
    tripSourceOf(t.trip, t.trip.name);

  return (
    <View style={[styles.tripCard, !isMyTrip && styles.tripCardOther]}>
      {sourceViewer}
      {/* ADR 0168 — cancelled from an OTA/hotel/agency notice; the trip stays
          visible (never deleted), just no longer reads as a live plan. */}
      {!!t.trip.cancelledAt && <Text style={styles.tripCancelledBadge}>CANCELLED</Text>}
      {isDeleted && <Text style={styles.tripDeletedBadge}>DELETED</Text>}
      <View style={styles.tripTitleRow}>
        {editingName ? (
          <View style={{ flex: 1, gap: 6 }}>
            <TextInput
              style={addStyles.addInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              maxLength={120}
              autoFocus
              placeholder="Trip name"
              onSubmitEditing={() => void submitRename()}
              returnKeyType="next"
              editable={!renaming}
            />
            <TextInput
              style={addStyles.addInput}
              value={destDraft}
              onChangeText={setDestDraft}
              maxLength={120}
              placeholder="Destination"
              onSubmitEditing={() => void submitRename()}
              onBlur={() => void submitRename()}
              returnKeyType="done"
              editable={!renaming}
            />
          </View>
        ) : (
          // Tapping the trip opens its source file when one exists (the leg/stay
          // it was built from); otherwise it's a plain, non-interactive title.
          <Pressable
            style={{ flex: 1 }}
            disabled={!tripSource}
            onPress={tripSource ? () => openSource(tripSource) : undefined}
            accessibilityRole={tripSource ? 'button' : undefined}
          >
            <Text style={styles.tripTitle}>
              {t.trip.name} · {t.trip.destination}
              {tripSource ? (tripSource.docId ? '  📎' : '  ✉️') : ''}
            </Text>
          </Pressable>
        )}
        {!isDeleted && !editingName && (
          <Pressable
            onPress={() => {
              setNameDraft(t.trip.name);
              setDestDraft(t.trip.destination);
              setEditingName(true);
            }}
            hitSlop={8}
            style={[addStyles.addBtn, { marginLeft: 6 }]}
          >
            <Text style={addStyles.addBtnText}>✎</Text>
          </Pressable>
        )}
        <ProvenanceButton label={t.trip.name} raw={t.trip.sourceRawContext} small />
        {isDeleted ? (
          <Pressable
            onPress={() => {
              void restoreTrip(t.trip.groupId, t.trip.id)
                .then(() => onChanged?.())
                .catch(() => {});
            }}
            style={({ pressed }) => [styles.tripRestoreBtn, pressed && { opacity: 0.5 }]}
            hitSlop={8}
          >
            <Text style={styles.tripRestoreTxt}>↺ Restore</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              // Soft-delete on the server, then refresh so the card moves into
              // "Deleted trips" immediately instead of lingering until the
              // next focus.
              void deleteTrip(t.trip.groupId, t.trip.id)
                .then(() => onChanged?.())
                .catch(() => {});
            }}
            style={({ pressed }) => [styles.tripDeleteBtn, pressed && { opacity: 0.5 }]}
            hitSlop={8}
          >
            <Text style={styles.tripDeleteTxt}>✕</Text>
          </Pressable>
        )}
      </View>

      {t.participantNames.length > 0 && (
        <Text style={styles.tripPassengers} numberOfLines={2}>
          {t.participantNames.join(' · ')}
        </Text>
      )}

      {items.length > 0 && (
        <View style={styles.tripTimeline}>
          {items.map((item, i) => {
            if (item.kind === 'leg') {
              const { leg } = item;
              const isCancelled = !!leg.cancelledAt;
              const label = MODE_LABEL[leg.mode] ?? leg.mode;
              const detail = [leg.carrier, leg.flightNo].filter(Boolean).join(' ');
              const legTrackUrl =
                leg.mode === 'flight' && !isCancelled
                  ? flightTrackingUrl(leg.carrier, leg.flightNo)
                  : null;
              // Shared flights are collapsed (getTripStatus groups by flight)
              // and carry every passenger in `passengers` - show them all,
              // not just the representative leg's single name.
              const paxLabel =
                leg.passengers && leg.passengers.length > 0
                  ? leg.passengers.join(', ')
                  : leg.personaId && personaNameMap[leg.personaId]
                    ? personaNameMap[leg.personaId]
                    : leg.passengerName;
              const legSource = tripSourceOf(leg, `${leg.origin}→${leg.destination}`);
              const legRow = (
                <View
                  style={[
                    styles.tripTimelineRow,
                    i > 0 && styles.tripTimelineRowBorder,
                    isCancelled && styles.tripTimelineRowCancelled,
                  ]}
                >
                  <Text style={[styles.tripTimelineTag, isCancelled && styles.tripTimelineTagCancelled]}>
                    {isCancelled ? 'cancelled' : label}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Pressable
                      disabled={!legSource}
                      onPress={legSource ? () => openSource(legSource) : undefined}
                      accessibilityRole={legSource ? 'button' : undefined}
                    >
                      <Text style={[styles.tripTimelineMain, isCancelled && styles.tripTimelineMainCancelled]}>
                        {leg.origin} → {leg.destination}
                      </Text>
                      <Text style={styles.tripTimelineSub}>
                        {fmtDt(leg.departAt)}{detail ? `  ·  ${detail}` : ''}
                        {leg.confirmation ? `  ·  ${leg.confirmation}` : ''}
                      </Text>
                    </Pressable>
                    {paxLabel ? (
                      <Text style={styles.tripLegPassenger}>{paxLabel}</Text>
                    ) : null}
                    <SourceEmailGone item={leg} />
                    {/* ADR 0138 — the leg already holds both halves of the
                        designator; an airline we cannot name gets no chip. */}
                    {legTrackUrl ? (
                      <LinkChip url={legTrackUrl} label={`Track ${detail}`} icon="✈️" />
                    ) : null}
                    {isCancelled && !isDeleted ? (
                      <Pressable
                        onPress={() => {
                          void removeTravelLeg(t.trip.groupId, t.trip.id, leg.id)
                            .then(() => onChanged?.())
                            .catch(() => {});
                        }}
                        style={styles.tripTimelineRemoveBtn}
                        hitSlop={6}
                      >
                        <Text style={styles.tripTimelineRemoveTxt}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <TripSourceButton src={legSource} onOpen={openSource} />
                  <ProvenanceButton label={`${leg.origin}→${leg.destination}`} raw={leg.sourceRawContext} small />
                </View>
              );
              return (
                <TripRowDraggable
                  key={leg.id}
                  active={!isDeleted}
                  kind="leg"
                  itemId={leg.id}
                  tripId={t.trip.id}
                  groupId={t.trip.groupId}
                  rowDrag={rowDrag}
                >
                  {legRow}
                </TripRowDraggable>
              );
            } else if (item.kind === 'stay') {
              const { stay } = item;
              const isCancelled = !!stay.cancelledAt;
              const staySource = tripSourceOf(stay, stay.propertyName);
              const stayRow = (
                <View
                  style={[
                    styles.tripTimelineRow,
                    i > 0 && styles.tripTimelineRowBorder,
                    isCancelled && styles.tripTimelineRowCancelled,
                  ]}
                >
                  <Text
                    style={[
                      styles.tripTimelineTag,
                      isCancelled ? styles.tripTimelineTagCancelled : styles.tripTimelineTagStay,
                    ]}
                  >
                    {isCancelled ? 'cancelled' : 'stay'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Pressable
                      disabled={!staySource}
                      onPress={staySource ? () => openSource(staySource) : undefined}
                      accessibilityRole={staySource ? 'button' : undefined}
                    >
                      <Text style={[styles.tripTimelineMain, isCancelled && styles.tripTimelineMainCancelled]}>
                        {stay.propertyName}
                      </Text>
                      <Text style={styles.tripTimelineSub}>
                        {fmtDate(stay.checkinDate)} → {fmtDate(stay.checkoutDate)}
                        {stay.confirmation ? `  ·  ${stay.confirmation}` : ''}
                      </Text>
                    </Pressable>
                    <SourceEmailGone item={stay} />
                    {isCancelled && !isDeleted ? (
                      <Pressable
                        onPress={() => {
                          void removeAccommodation(t.trip.groupId, t.trip.id, stay.id)
                            .then(() => onChanged?.())
                            .catch(() => {});
                        }}
                        style={styles.tripTimelineRemoveBtn}
                        hitSlop={6}
                      >
                        <Text style={styles.tripTimelineRemoveTxt}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <TripSourceButton src={staySource} onOpen={openSource} />
                </View>
              );
              return (
                <TripRowDraggable
                  key={stay.id}
                  active={!isDeleted}
                  kind="accommodation"
                  itemId={stay.id}
                  tripId={t.trip.id}
                  groupId={t.trip.groupId}
                  rowDrag={rowDrag}
                >
                  {stayRow}
                </TripRowDraggable>
              );
            } else {
              const { reservation } = item;
              const label = RESERVATION_LABEL[reservation.kind] ?? reservation.kind;
              return (
                <View key={reservation.id} style={[styles.tripTimelineRow, i > 0 && styles.tripTimelineRowBorder]}>
                  <Text style={[styles.tripTimelineTag, styles.tripTimelineTagReservation]}>{label}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tripTimelineMain}>{reservation.name}</Text>
                    <Text style={styles.tripTimelineSub}>
                      {reservation.dateTime ? fmtDt(reservation.dateTime) : ''}
                      {reservation.confirmation ? `  ·  ${reservation.confirmation}` : ''}
                      {reservation.notes ? `  ·  ${reservation.notes}` : ''}
                    </Text>
                    <SourceEmailGone item={reservation} />
                  </View>
                  <TripSourceButton src={tripSourceOf(reservation, reservation.name)} onOpen={openSource} />
                  <ProvenanceButton label={reservation.name} raw={reservation.sourceRawContext} small />
                </View>
              );
            }
          })}
        </View>
      )}
    </View>
  );
}

/** Enough of a View ref to hit-test drop targets — Animated.View forwards the
 *  underlying native view, which has this, but its own TS types don't say so. */
interface MeasurableNode {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

type DropRect = { id: string; x0: number; y0: number; x1: number; y1: number };

function hitTestRect(x: number, y: number, rects: DropRect[]): string | null {
  'worklet';
  for (const r of rects) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.id;
  }
  return null;
}

/**
 * The dragged row's current point to hit-test, preferring `self`'s pre-drag
 * rect (its center) plus the live translation — the coordinate space `self`
 * and `rects` share, whatever it actually is (see measureRowTargets). Falls
 * back to the gesture's own absolute position only if `self` hasn't been
 * measured yet (a drag ending faster than the measurement promise
 * resolves). Only DraggableTripRow uses this: its own drag never triggers
 * the whole-card drag's edge auto-scroll (that's wired to DraggableTripCard
 * alone), so there's no programmatic scroll to drift out from under a
 * frozen measurement the way there is for the card (see DraggableTripCard's
 * own comment on why IT re-measures on a timer instead).
 */
function currentHit(
  self: DropRect | null,
  translationX: number,
  translationY: number,
  fallbackX: number,
  fallbackY: number,
  rects: DropRect[],
): string | null {
  'worklet';
  if (self) {
    const x = (self.x0 + self.x1) / 2 + translationX;
    const y = (self.y0 + self.y1) / 2 + translationY;
    return hitTestRect(x, y, rects);
  }
  return hitTestRect(fallbackX, fallbackY, rects);
}

/**
 * A trip card that can be long-pressed and dragged onto another one to
 * combine them (the Trips tab's "hard-press, move, combine" gesture). A
 * plain `Gesture.Pan().activateAfterLongPress(...)` rather than a separate
 * long-press recognizer — one gesture that only starts moving the card once
 * it has activated is also what keeps an ordinary scroll from being
 * hijacked by an accidental long touch.
 *
 * Hit-testing uses the gesture's own live `absoluteX/Y` — genuinely
 * viewport-relative, and correct at any instant `measureInWindow` was just
 * called. The reason it's re-measured on a timer (not once at drag start)
 * rather than combined with the live translation is the edge auto-scroll
 * below: it can move the page without the finger moving at all, so a
 * frozen measurement plus finger-only translation would silently drift
 * from what's actually on screen the longer you hold near an edge.
 */
function DraggableTripCard({
  t,
  currentUserId,
  onChanged,
  registerRef,
  dragHoverId,
  measureDropTargets,
  onDrop,
  onDragStart,
  onDragMove,
  onDragEnd,
  disabled,
  measureRowTargets,
  onRowDrop,
}: {
  t: TripStatus;
  currentUserId?: string | null;
  onChanged?: () => void | Promise<void>;
  registerRef: (id: string, node: MeasurableNode | null) => void;
  dragHoverId: SharedValue<string | null>;
  measureDropTargets: (draggedId: string) => Promise<DropRect[]>;
  onDrop: (fromId: string, intoId: string) => void;
  /** Fires when the long-press activates — starts the edge auto-scroll. */
  onDragStart: () => void;
  /** The pointer's live absolute Y, for the auto-scroll's edge check. */
  onDragMove: (y: number) => void;
  /** Fires once the drag ends, hit or not — stops the edge auto-scroll. */
  onDragEnd: () => void;
  disabled: boolean;
  measureRowTargets: (sourceTripId: string, groupId: string) => Promise<DropRect[]>;
  onRowDrop: (kind: 'leg' | 'accommodation', itemId: string, fromTripId: string, targetTripId: string) => void;
}) {
  const tripId = t.trip.id;
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const isDraggingSelf = useSharedValue(false);
  const dropRects = useSharedValue<DropRect[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshDropRects = useCallback(() => {
    void measureDropTargets(tripId).then((targets) => {
      dropRects.value = targets;
    });
  }, [measureDropTargets, tripId, dropRects]);

  const beginTracking = useCallback(() => {
    refreshDropRects();
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    // 200ms: often enough that a held edge-auto-scroll can't drift far
    // out of date, rare enough that it's a handful of measureInWindow
    // calls per drag, not a per-frame cost.
    refreshTimer.current = setInterval(refreshDropRects, 200);
  }, [refreshDropRects]);

  const stopTracking = useCallback(() => {
    if (refreshTimer.current) {
      clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  useEffect(() => stopTracking, [stopTracking]);

  const finishDrop = useCallback(
    (targetId: string) => onDrop(tripId, targetId),
    [onDrop, tripId],
  );

  // A fresh inline `ref={(node) => ...}` arrow is a new function every
  // render, and React treats a changed ref-callback identity as "detach the
  // old one, attach the new one" — on every re-render, not just on mount.
  // That repeated detach/attach was the same class of bug as the unmemoized
  // gesture above, just for the measurable ref rather than the press timer.
  const attachRef = useCallback(
    (node: MeasurableNode | null) => registerRef(tripId, node),
    [registerRef, tripId],
  );

  // Memoized: GestureDetector tears down and rebuilds its recognizer whenever
  // the `gesture` object's identity changes, which resets an in-progress
  // long-press timer. Gesture.Pan() returns a fresh object every call, so
  // building it inline (unmemoized) meant an unrelated re-render mid-press —
  // e.g. from the parent's own state — could silently cancel the hold before
  // it ever reached 350ms. Depends only on `disabled`; every shared value and
  // useCallback below already has a stable identity across renders.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .activateAfterLongPress(350)
        .onStart(() => {
          isDraggingSelf.value = true;
          scale.value = withSpring(1.05);
          runOnJS(beginTracking)();
          runOnJS(onDragStart)();
        })
        .onUpdate((e) => {
          tx.value = e.translationX;
          ty.value = e.translationY;
          dragHoverId.value = hitTestRect(e.absoluteX, e.absoluteY, dropRects.value);
          runOnJS(onDragMove)(e.absoluteY);
        })
        .onEnd((e) => {
          const hit = hitTestRect(e.absoluteX, e.absoluteY, dropRects.value);
          isDraggingSelf.value = false;
          dragHoverId.value = null;
          runOnJS(stopTracking)();
          runOnJS(onDragEnd)();
          if (hit) {
            // Fire the merge immediately — never gate a real action on an
            // animation's completion callback, since an unrelated re-render
            // (a live refetch from another device, a parent state update)
            // can interrupt the animation and silently skip that callback.
            // The collapse below is purely a visual flourish alongside it.
            runOnJS(finishDrop)(hit);
            scale.value = withTiming(0.05, { duration: 220 });
            opacity.value = withTiming(0, { duration: 220 });
          } else {
            tx.value = withSpring(0);
            ty.value = withSpring(0);
            scale.value = withSpring(1);
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, beginTracking, stopTracking, finishDrop, onDragStart, onDragMove, onDragEnd],
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
    opacity: opacity.value,
    zIndex: isDraggingSelf.value ? 100 : 0,
    elevation: isDraggingSelf.value ? 8 : 0,
    shadowOpacity: isDraggingSelf.value ? 0.25 : 0,
    shadowRadius: isDraggingSelf.value ? 10 : 0,
    shadowOffset: { width: 0, height: isDraggingSelf.value ? 4 : 0 },
  }));

  const hoverStyle = useAnimatedStyle(() => {
    const isTarget = dragHoverId.value === tripId && !isDraggingSelf.value;
    return {
      borderColor: isTarget ? colors.accent : 'transparent',
      borderWidth: isTarget ? 2 : 0,
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        ref={attachRef as unknown as (node: unknown) => void}
        collapsable={false}
        // Web only: without this, a mousedown-drag starting on the card's
        // own text is captured by the browser as a text selection instead of
        // reaching the pan gesture — the same press-and-drag a touchscreen
        // never has to contend with. Harmless no-op on native.
        style={[cardStyle, hoverStyle, { borderRadius: 12, userSelect: 'none' } as never]}
      >
        <TripCard
          t={t}
          currentUserId={currentUserId}
          onChanged={onChanged}
          rowDrag={{
            dragHoverId,
            measureRowTargets,
            onRowDrop,
            cardPan: pan,
            disabled,
          }}
        />
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * Renders `children` unwrapped when row-dragging isn't offered (past/deleted
 * trips, or no rowDrag machinery passed down at all); otherwise wraps them in
 * `DraggableTripRow`. Kept as a thin wrapper so the leg/stay render blocks in
 * TripCard don't repeat the same JSX twice.
 */
function TripRowDraggable({
  active,
  kind,
  itemId,
  tripId,
  groupId,
  rowDrag,
  children,
}: {
  active: boolean;
  kind: 'leg' | 'accommodation';
  itemId: string;
  tripId: string;
  groupId: string;
  rowDrag?: RowDragProps;
  children: ReactNode;
}) {
  if (!active || !rowDrag) return <>{children}</>;
  return (
    <DraggableTripRow
      kind={kind}
      itemId={itemId}
      tripId={tripId}
      groupId={groupId}
      cardPan={rowDrag.cardPan}
      dragHoverId={rowDrag.dragHoverId}
      measureRowTargets={rowDrag.measureRowTargets}
      onRowDrop={rowDrag.onRowDrop}
      disabled={rowDrag.disabled}
    >
      {children}
    </DraggableTripRow>
  );
}

/**
 * A single leg/accommodation row that can be long-pressed and dragged onto a
 * DIFFERENT trip card to move just that one item — same long-press-then-pan,
 * DropRect hit-testing mechanics as DraggableTripCard, scaled to a row. This
 * row sits INSIDE a card that is itself a long-press-drag target
 * (DraggableTripCard, for whole-trip merging), so the two gestures compete
 * for the same touch: `.blocksExternalGesture(cardPan)` gives the row
 * priority — once the row's own long-press activates, the enclosing card's
 * pan gesture is cancelled, so one touch is never read as both "move this
 * leg" and "merge this whole trip".
 *
 * Drop targets are every OTHER live trip card in the same group — the same
 * `cardRefs` TripsSection already measures for whole-card drags — never the
 * dragged item's own card (measureRowTargets excludes it by tripId).
 */
function DraggableTripRow({
  kind,
  itemId,
  tripId,
  groupId,
  cardPan,
  dragHoverId,
  measureRowTargets,
  onRowDrop,
  disabled,
  children,
}: {
  kind: 'leg' | 'accommodation';
  itemId: string;
  tripId: string;
  groupId: string;
  cardPan: GestureType;
  dragHoverId: SharedValue<string | null>;
  measureRowTargets: (sourceTripId: string, groupId: string) => Promise<DropRect[]>;
  onRowDrop: (kind: 'leg' | 'accommodation', itemId: string, fromTripId: string, targetTripId: string) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const isDraggingSelf = useSharedValue(false);
  const dropRects = useSharedValue<DropRect[]>([]);
  const selfRect = useSharedValue<DropRect | null>(null);
  const rowNode = useRef<MeasurableNode | null>(null);

  const beginMeasure = useCallback(() => {
    const node = rowNode.current;
    const measureSelf = new Promise<DropRect | null>((resolve) => {
      if (!node) { resolve(null); return; }
      node.measureInWindow((x, y, width, height) => {
        resolve(width === 0 && height === 0 ? null : { id: itemId, x0: x, y0: y, x1: x + width, y1: y + height });
      });
    });
    void Promise.all([measureSelf, measureRowTargets(tripId, groupId)]).then(([self, targets]) => {
      selfRect.value = self;
      dropRects.value = targets;
    });
  }, [itemId, tripId, groupId, measureRowTargets, selfRect, dropRects]);

  const finishDrop = useCallback(
    (targetTripId: string) => onRowDrop(kind, itemId, tripId, targetTripId),
    [onRowDrop, kind, itemId, tripId],
  );

  const attachRef = useCallback((node: MeasurableNode | null) => { rowNode.current = node; }, []);

  const rowPan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .activateAfterLongPress(350)
        .blocksExternalGesture(cardPan)
        .onStart(() => {
          isDraggingSelf.value = true;
          scale.value = withSpring(1.03);
          runOnJS(beginMeasure)();
        })
        .onUpdate((e) => {
          tx.value = e.translationX;
          ty.value = e.translationY;
          dragHoverId.value = currentHit(selfRect.value, tx.value, ty.value, e.absoluteX, e.absoluteY, dropRects.value);
        })
        .onEnd((e) => {
          const hit = currentHit(selfRect.value, tx.value, ty.value, e.absoluteX, e.absoluteY, dropRects.value);
          isDraggingSelf.value = false;
          dragHoverId.value = null;
          if (hit) {
            runOnJS(finishDrop)(hit);
            scale.value = withTiming(0.05, { duration: 220 });
            opacity.value = withTiming(0, { duration: 220 });
          } else {
            tx.value = withSpring(0);
            ty.value = withSpring(0);
            scale.value = withSpring(1);
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, cardPan, beginMeasure, finishDrop],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
    opacity: opacity.value,
    zIndex: isDraggingSelf.value ? 100 : 0,
  }));

  return (
    <GestureDetector gesture={rowPan}>
      <Animated.View
        ref={attachRef as unknown as (node: unknown) => void}
        collapsable={false}
        style={[rowStyle, { userSelect: 'none' } as never]}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

type TripDateGroup = { start: string; end: string; items: TripStatus[] };

/** Sweep-line group: trips whose date windows overlap share one container. */
function groupTripsByOverlap(trips: TripStatus[]): TripDateGroup[] {
  const sorted = [...trips].sort((a, b) => a.trip.startDate.localeCompare(b.trip.startDate));
  const groups: TripDateGroup[] = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    if (last && t.trip.startDate <= last.end) {
      if (t.trip.endDate > last.end) last.end = t.trip.endDate;
      last.items.push(t);
    } else {
      groups.push({ start: t.trip.startDate, end: t.trip.endDate, items: [t] });
    }
  }
  return groups;
}

function TripsSection({
  trips,
  proposals,
  auditProposals,
  onChanged,
  scrollRef,
  scrollOffsetY,
  groups,
  onUpload,
  onMerged,
}: {
  trips: TripStatus[];
  proposals: Proposal[];
  auditProposals: Proposal[];
  onChanged: () => void | Promise<void>;
  scrollRef: RefObject<ScrollView | null>;
  scrollOffsetY: { current: number };
  groups: { id: string; name: string }[];
  onUpload: (groupId: string, kind: 'file' | 'photo' | 'camera') => Promise<number>;
  onMerged: (undo: TripUndoState) => void;
}) {
  const currentUserId = useApp((s) => s.user?.id);

  // ── Drag-to-combine: long-press a trip card, drag it onto another ─────
  // One shared value so every card can cheaply read "who's the drop target
  // right now" without a re-render per frame; the dragged card writes it,
  // every other card reads it for its own hover highlight.
  const dragHoverId = useSharedValue<string | null>(null);
  const cardRefs = useRef<Map<string, MeasurableNode | null>>(new Map());
  const [mergingId, setMergingId] = useState<string | null>(null);

  const registerCardRef = useCallback((id: string, node: MeasurableNode | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  }, []);

  // ── Auto-scroll near the top/bottom edge while dragging ────────────────
  // The trip you're combining onto is often off-screen — a fresh flight
  // leg is usually added to whatever trip is already showing, but a date
  // far enough away needs a scroll to even see. Edge-triggered, gentle
  // (a few px per tick), and in both directions.
  const dragPointerY = useRef<number | null>(null);
  const scrollBounds = useRef<{ top: number; bottom: number } | null>(null);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const AUTO_SCROLL_EDGE = 70;
  const AUTO_SCROLL_STEP = 5;

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current) {
      clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
    dragPointerY.current = null;
    scrollBounds.current = null;
  }, []);

  const startAutoScroll = useCallback(() => {
    const sv = scrollRef.current as unknown as MeasurableNode | null;
    sv?.measureInWindow?.((_x, y, _width, height) => {
      scrollBounds.current = { top: y, bottom: y + height };
    });
    if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
    autoScrollTimer.current = setInterval(() => {
      const bounds = scrollBounds.current;
      const pointerY = dragPointerY.current;
      if (!bounds || pointerY === null) return;
      const nearTop = pointerY - bounds.top;
      const nearBottom = bounds.bottom - pointerY;
      let delta = 0;
      if (nearTop < AUTO_SCROLL_EDGE) {
        // Full speed right at the edge, easing to nothing at the trigger
        // zone's own boundary — "gentle" rather than an abrupt jump/stop.
        delta = -AUTO_SCROLL_STEP * (1 - Math.max(0, Math.min(1, nearTop / AUTO_SCROLL_EDGE)));
      } else if (nearBottom < AUTO_SCROLL_EDGE) {
        delta = AUTO_SCROLL_STEP * (1 - Math.max(0, Math.min(1, nearBottom / AUTO_SCROLL_EDGE)));
      }
      if (delta !== 0) {
        const next = Math.max(0, scrollOffsetY.current + delta);
        scrollRef.current?.scrollTo({ y: next, animated: false });
        scrollOffsetY.current = next; // optimistic; the real onScroll confirms it moments later
      }
    }, 16);
  }, [scrollRef, scrollOffsetY]);

  const updateDragPointerY = useCallback((y: number) => {
    dragPointerY.current = y;
  }, []);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  // A merge can't cross Chord groups (ADR 0004), so only cards in the same
  // group as the one being dragged are even offered as drop targets.
  //
  // Shared by the whole-card drag (below) and the per-row drag (a leg or
  // accommodation dragged out of ITS card onto a different one) — both hit-
  // test against the same set of card rects, just filtered differently.
  // The whole-card drag re-runs this periodically while dragging (not just
  // once at the start) so the edge auto-scroll below doesn't leave it stale —
  // each call reflects wherever the list has actually scrolled to right now.
  // The per-row drag has no auto-scroll of its own, so it measures once at
  // drag start, same as it always has.
  const measureCardRects = useCallback((ids: string[]): Promise<DropRect[]> => {
    const measureOne = (id: string) =>
      new Promise<DropRect | null>((resolve) => {
        const node = cardRefs.current.get(id);
        if (!node) { resolve(null); return; }
        node.measureInWindow((x, y, width, height) => {
          resolve(width === 0 && height === 0 ? null : { id, x0: x, y0: y, x1: x + width, y1: y + height });
        });
      });
    return Promise.all(ids.map(measureOne)).then((rects) => rects.filter((r): r is DropRect => r !== null));
  }, []);

  const measureDropTargets = useCallback(
    (draggedId: string): Promise<DropRect[]> => {
      const dragged = trips.find((tr) => tr.trip.id === draggedId);
      if (!dragged) return Promise.resolve([]);
      const candidates = trips.filter(
        (tr) => tr.trip.id !== draggedId && tr.trip.groupId === dragged.trip.groupId && !tr.trip.deletedAt,
      );
      return measureCardRects(candidates.map((tr) => tr.trip.id));
    },
    [trips, measureCardRects],
  );

  // A leg/accommodation row's own rect is measured locally by the row itself
  // (it isn't one of the registered card refs) — this only needs to answer
  // "which OTHER live cards in this group can it drop onto", excluding its
  // own card by tripId rather than by looking the dragged id up in `trips`
  // (a leg/accommodation id isn't a trip id).
  const measureRowTargets = useCallback(
    (sourceTripId: string, groupId: string): Promise<DropRect[]> => {
      const relevant = trips.filter(
        (tr) => tr.trip.groupId === groupId && !tr.trip.deletedAt && tr.trip.id !== sourceTripId,
      );
      return measureCardRects(relevant.map((tr) => tr.trip.id));
    },
    [trips, measureCardRects],
  );

  const performMerge = useCallback(
    async (fromId: string, intoId: string) => {
      const from = trips.find((tr) => tr.trip.id === fromId);
      const into = trips.find((tr) => tr.trip.id === intoId);
      if (!from || !into) return;
      setMergingId(fromId);
      try {
        const status = await mergeTrips(into.trip.groupId, intoId, fromId);
        await onChanged?.();
        onMerged({
          groupId: into.trip.groupId,
          keepTripId: intoId,
          mergeTripId: fromId,
          legIds: from.legs.map((l) => l.id),
          accommodationIds: from.accommodations.map((a) => a.id),
          reservationIds: from.reservations.map((r) => r.id),
          keepStartDate: into.trip.startDate,
          keepEndDate: into.trip.endDate,
          mergedTripName: from.trip.name,
          keepTripName: status.trip.name,
        });
        const lines: string[] = [];
        if (status.gaps.length > 0) {
          lines.push(
            `No accommodation for ${status.gaps
              .map((g) => (g.start === g.end ? g.start : `${g.start} – ${g.end}`))
              .join(', ')}.`,
          );
        }
        for (const g of status.legGaps) {
          lines.push(
            `Arrives ${g.arrivedAt}, but the next leg leaves from ${g.departingFrom}` +
              `${g.passengerName ? ` (${g.passengerName})` : ''}.`,
          );
        }
        if (lines.length > 0) showAlert(`Merged into "${status.trip.name}"`, lines.join('\n'));
      } catch (err) {
        showAlert('Could not combine trips', err instanceof Error ? err.message : 'Try again.');
        await onChanged?.();
      } finally {
        setMergingId(null);
      }
    },
    [trips, onChanged, onMerged],
  );

  const handleTripDrop = useCallback(
    (fromId: string, intoId: string) => {
      const from = trips.find((tr) => tr.trip.id === fromId);
      const into = trips.find((tr) => tr.trip.id === intoId);
      if (!from || !into) return;
      // Different-looking destinations are usually a mis-drop, not intent —
      // ask before combining (metro-matched, so "Vail" and "Vail, CO" or
      // "New York (LGA)" vs "New York (JFK)" never trigger this).
      if (sameMetro(from.trip.destination, into.trip.destination) === false) {
        confirmDestructive(
          'Different destinations',
          `"${from.trip.name}" (${from.trip.destination}) and "${into.trip.name}" (${into.trip.destination}) ` +
            'look like different trips. Combine them anyway?',
          () => void performMerge(fromId, intoId),
          { confirmLabel: 'Combine' },
        );
        return;
      }
      void performMerge(fromId, intoId);
    },
    [trips, performMerge],
  );

  const performRowMove = useCallback(
    async (kind: 'leg' | 'accommodation', itemId: string, fromTripId: string, targetTripId: string) => {
      const from = trips.find((tr) => tr.trip.id === fromTripId);
      const into = trips.find((tr) => tr.trip.id === targetTripId);
      if (!from || !into) return;
      // Reuses the whole-card busy flag: a row move is the same kind of
      // in-flight mutation, and disabling every card's drag gesture while
      // one is running avoids a second drag racing this one's onChanged
      // refetch.
      setMergingId(fromTripId);
      try {
        if (kind === 'leg') await moveTravelLeg(from.trip.groupId, fromTripId, itemId, targetTripId);
        else await moveAccommodation(from.trip.groupId, fromTripId, itemId, targetTripId);
        await onChanged?.();
      } catch (err) {
        showAlert('Could not move', err instanceof Error ? err.message : 'Try again.');
        await onChanged?.();
      } finally {
        setMergingId(null);
      }
    },
    [trips, onChanged],
  );

  const handleRowDrop = useCallback(
    (kind: 'leg' | 'accommodation', itemId: string, fromTripId: string, targetTripId: string) => {
      void performRowMove(kind, itemId, fromTripId, targetTripId);
    },
    [performRowMove],
  );

  // Group pending proposals by bundle. A bundle with a create_trip is a
  // "new-trip bundle"; bundles of only children (legs/stays) extending an
  // existing trip or one-off proposals become standalone rows.
  const byBundle = new Map<string, Proposal[]>();
  const standalone: Proposal[] = [];
  for (const p of proposals) {
    if (p.bundleId) {
      const arr = byBundle.get(p.bundleId) ?? [];
      arr.push(p);
      byBundle.set(p.bundleId, arr);
    } else {
      standalone.push(p);
    }
  }

  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const resolveOne = async (
    p: Proposal,
    action: 'confirm' | 'reject',
    targetGroupIds?: string[],
    calendarId?: string,
    replaceEventId?: string,
    sendInvites?: boolean,
  ) => {
    setBusy((prev) => {
      const n = new Set(prev);
      n.add(p.id);
      return n;
    });
    try {
      await answerProposal({
        proposalId: p.id,
        memberIds: [p.id],
        action,
        ...(targetGroupIds ? { targetGroupIds } : {}),
        ...(calendarId ? { calendarId } : {}),
        ...(replaceEventId ? { replaceEventId } : {}),
        ...(sendInvites ? { sendInvites: true } : {}),
        label: describeProposal(p).label,
      });
    } catch (err) {
      console.warn('proposal resolve failed', err);
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(p.id);
        return n;
      });
    }
  };

  const totalPending = proposals.length;

  // ADR 0046 - archive trips whose last day has passed (a trip ending TODAY
  // is still live). Past trips collapse behind a disclosure rather than
  // rendering in full above the live ones: the auto-scroll that used to hide
  // them is best-effort - `measureLayout` can decline - and when it declined
  // the tab opened on somebody's history instead of their next trip.
  const today = isoDay(new Date());
  // A soft-deleted trip goes to its own "Deleted trips" bucket, recoverable —
  // never mixed into "Earlier trips" (which is about time/cancellation, not
  // about being gone).
  const activeTrips = trips.filter((t) => !t.trip.deletedAt);
  const deletedTrips = trips.filter((t) => !!t.trip.deletedAt);
  // ADR 0168 — a cancelled trip no longer needs attention as an upcoming
  // plan, so it folds into "Earlier trips" alongside past ones, whatever its
  // dates say — but stays visible (never deleted) with a "Cancelled" badge.
  const pastGroups = groupTripsByOverlap(
    activeTrips.filter((t) => isTripArchived(t.trip.endDate, today) || !!t.trip.cancelledAt),
  );
  const liveGroups = groupTripsByOverlap(
    activeTrips.filter((t) => !isTripArchived(t.trip.endDate, today) && !t.trip.cancelledAt),
  );
  const deletedGroups = groupTripsByOverlap(deletedTrips);
  const [pastOpen, setPastOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const pastCount = pastGroups.reduce((n, g) => n + g.items.length, 0);
  const deletedCount = deletedTrips.length;
  const boundaryRef = useRef<View>(null);
  useScrollPastArchived(
    scrollRef,
    boundaryRef,
    pastOpen && pastGroups.length > 0 && (liveGroups.length > 0 || totalPending > 0),
  );

  // Drag-to-combine only applies to live, upcoming trips — merging into
  // something past or already deleted isn't a case worth building for.
  const renderTripGroups = (groups: TripDateGroup[], draggable = false) =>
    groups.map((g, gi) => {
      const header = g.start === g.end ? fmtDate(g.start) : `${fmtDate(g.start)} – ${fmtDate(g.end)}`;
      return (
        <View key={g.start} style={[styles.tripGroup, gi > 0 && { marginTop: 8 }]}>
          <Text style={styles.tripGroupDate}>{header}</Text>
          {g.items.map((t) =>
            draggable ? (
              <DraggableTripCard
                key={t.trip.id}
                t={t}
                currentUserId={currentUserId}
                onChanged={onChanged}
                registerRef={registerCardRef}
                dragHoverId={dragHoverId}
                measureDropTargets={measureDropTargets}
                onDrop={handleTripDrop}
                onDragStart={startAutoScroll}
                onDragMove={updateDragPointerY}
                onDragEnd={stopAutoScroll}
                disabled={mergingId !== null}
                measureRowTargets={measureRowTargets}
                onRowDrop={handleRowDrop}
              />
            ) : (
              <TripCard key={t.trip.id} t={t} currentUserId={currentUserId} onChanged={onChanged} />
            ),
          )}
        </View>
      );
    });

  return (
    <Section title="Trips" count={activeTrips.length + (totalPending > 0 ? byBundle.size + standalone.length : 0)}>
      <UploadAddRow label="Upload itinerary" groups={groups} onUpload={onUpload} />
      {pastGroups.length > 0 && (
        <>
          <Pressable onPress={() => setPastOpen((v) => !v)} style={styles.doneToggle} hitSlop={6}>
            <Text style={styles.doneToggleText}>
              {pastOpen ? '▾' : '▸'} Earlier trips · {pastCount}
            </Text>
          </Pressable>
          {pastOpen && (
            <>
              {renderTripGroups(pastGroups)}
              <View ref={boundaryRef} style={styles.archiveBoundary} />
            </>
          )}
        </>
      )}
      {deletedGroups.length > 0 && (
        <>
          <Pressable onPress={() => setDeletedOpen((v) => !v)} style={styles.doneToggle} hitSlop={6}>
            <Text style={styles.doneToggleText}>
              {deletedOpen ? '▾' : '▸'} Deleted trips · {deletedCount}
            </Text>
          </Pressable>
          {deletedOpen && renderTripGroups(deletedGroups)}
        </>
      )}
      {byBundle.size > 0 && (
        <Text style={[styles.subCardTitle, { marginTop: 0 }]}>
          Proposed - {byBundle.size}
        </Text>
      )}
      {[...byBundle.values()].map((members) => (
        <TripBundleCard
          key={members[0]!.bundleId!}
          members={members}
          busy={members.some((m) => busy.has(m.id))}
          groups={groups}
          onConfirm={(targetGroupIds) => {
            // Any member id confirms the whole bundle server-side.
            const anchor = members.find((m) => m.toolName === 'create_trip') ?? members[0]!;
            void resolveOne(anchor, 'confirm', targetGroupIds);
          }}
          onReject={() => {
            const anchor = members.find((m) => m.toolName === 'create_trip') ?? members[0]!;
            void resolveOne(anchor, 'reject');
          }}
        />
      ))}
      {standalone.length > 0 && (
        <>
          {byBundle.size > 0 && <View style={{ height: 6 }} />}
          {standalone.map((p) => (
            <ProposalRow
              key={p.id}
              proposal={p}
              busy={busy.has(p.id)}
              onConfirm={(_targets, calendarId, replaceEventId, sendInvites) =>
                void resolveOne(p, 'confirm', undefined, calendarId, replaceEventId, sendInvites)
              }
              onReject={() => void resolveOne(p, 'reject')}
            />
          ))}
        </>
      )}
      {liveGroups.length > 0 && totalPending > 0 && (
        <Text style={[styles.subCardTitle, { marginTop: 10 }]}>Confirmed</Text>
      )}
      {trips.length === 0 && totalPending === 0 && (
        <Text style={styles.empty}>
          No trips yet. Tap + to upload an itinerary screenshot or file and we'll add it to
          Chord's memory — or forward a flight or hotel confirmation in chat.
        </Text>
      )}
      {renderTripGroups(liveGroups, true)}
      <AuditBlock proposals={auditProposals} />
    </Section>
  );
}

function TripBundleCard({
  members,
  busy,
  groups,
  onConfirm,
  onReject,
}: {
  members: Proposal[];
  busy: boolean;
  /** Groups this trip can be shared with. Only offered for a NEW trip (one with
   *  a create_trip) - a bundle that just extends an existing trip lives where
   *  that trip already is. */
  groups?: { id: string; name: string }[];
  onConfirm: (targetGroupIds?: string[]) => void;
  onReject: () => void;
}) {
  const head = members.find((m) => m.toolName === 'create_trip');
  const children = members.filter((m) => m.toolName !== 'create_trip');
  const headDesc = head ? describeProposal(head) : null;
  // ADR 0233 - a trip is personal until the user says otherwise. Sharing it is a
  // visible choice on the card (the same one a single suggestion gets, ADR
  // 0097), never a default: the people in the group will see who is travelling
  // when, and the booking may carry details that are the traveller's own.
  const shareable = head ? (groups ?? []).filter((g) => g.id !== head.groupId) : [];
  // ADR 0247 — one trip per picked group, each in front of that group.
  const [shareWith, setShareWith] = useState<string[]>([]);
  return (
    <View style={[styles.subCard, styles.memoryPendingRow]}>
      <View style={styles.tripTitleRow}>
        <Text style={[styles.tag, styles.memoryPendingTag]}>trip bundle</Text>
        <Text style={[styles.tripTitle, { flex: 1, marginLeft: 6 }]}>
          {headDesc?.label ?? 'Trip changes'}
        </Text>
      </View>
      {headDesc?.subtitle ? (
        <Text style={styles.tripDates}>{headDesc.subtitle}</Text>
      ) : null}
      {children.length > 0 && (
        <View style={styles.tripTimeline}>
          {children.map((c, i) => {
            const d = describeProposal(c);
            return (
              <View
                key={c.id}
                style={[styles.tripTimelineRow, i > 0 && styles.tripTimelineRowBorder]}
              >
                <Text style={styles.tripTimelineTag}>
                  {c.toolName === 'add_travel_leg'
                    ? 'leg'
                    : c.toolName === 'add_accommodation'
                    ? 'stay'
                    : 'res'}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tripTimelineMain}>{d.label}</Text>
                  {d.subtitle ? (
                    <Text style={styles.tripTimelineSub}>{d.subtitle}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
      {shareable.length > 0 ? (
        <View>
          <Text style={styles.tripDates}>
            Share this trip so the family can see who is travelling when?
          </Text>
          <GroupChips groups={shareable} selected={shareWith} onChange={setShareWith} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 }}>
        <Pressable
          onPress={() => onConfirm(shareWith.length > 0 ? shareWith : undefined)}
          disabled={busy}
          style={({ pressed }) => [
            styles.memoryActionBtn,
            styles.memoryConfirmBtn,
            { minWidth: 64 },
            pressed && !busy && { opacity: 0.6 },
            busy && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.memoryConfirmTxt}>✓ Approve all</Text>
        </Pressable>
        <Pressable
          onPress={onReject}
          disabled={busy}
          style={({ pressed }) => [
            styles.memoryActionBtn,
            styles.memoryRejectBtn,
            { minWidth: 64 },
            pressed && !busy && { opacity: 0.6 },
            busy && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.memoryRejectTxt}>✗ Reject all</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Memories (Chord proposes; user confirms - ADR 0009) ────────────

function MemoriesSection({ memories, currentGroupId }: { memories: Memory[]; currentGroupId: string }) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  // Optimistic resolution overrides. The catchup screen is a polling cache with
  // no SSE subscription, so after confirm/reject we update the row locally -
  // otherwise the pending item never changes and the buttons look dead.
  const [overrides, setOverrides] = useState<Map<string, 'confirmed' | 'rejected'>>(
    () => new Map(),
  );
  const statusOf = (m: Memory): Memory['status'] | 'rejected' => overrides.get(m.id) ?? m.status;

  const pending = memories.filter((m) => statusOf(m) === 'proposed');
  const confirmedHere = memories.filter(
    (m) => statusOf(m) === 'confirmed' && m.groupId === currentGroupId,
  );
  const confirmedOthers = memories.filter(
    (m) => statusOf(m) === 'confirmed' && m.groupId !== currentGroupId,
  );

  const resolve = async (m: Memory, action: 'confirm' | 'reject') => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.add(m.id);
      return next;
    });
    try {
      if (action === 'confirm') await confirmMemory(m.id);
      else await rejectMemory(m.id);
      setOverrides((prev) =>
        new Map(prev).set(m.id, action === 'confirm' ? 'confirmed' : 'rejected'),
      );
    } catch (err) {
      console.warn('memory resolve failed', err);
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(m.id);
        return next;
      });
    }
  };

  const renderConfirmed = (m: Memory) => (
    <View key={m.id} style={styles.row}>
      <Text style={styles.tag}>{m.source}</Text>
      <Text style={styles.rowText}>
        <Text style={{ fontWeight: '600' }}>{m.about ? `${m.about} · ` : ''}{m.key.replace(/_/g, ' ')}</Text>
        {': '}
        {m.value}
        {m.scope === 'persona' ? '  · private' : ''}
      </Text>
    </View>
  );

  const renderPending = (m: Memory) => {
    const busy = pendingIds.has(m.id);
    return (
      <View key={m.id} style={[styles.row, styles.memoryPendingRow]}>
        <Text style={[styles.tag, styles.memoryPendingTag]}>proposed</Text>
        <Text style={[styles.rowText, { flex: 1 }]}>
          <Text style={{ fontWeight: '600' }}>{m.about ? `${m.about} · ` : ''}{m.key.replace(/_/g, ' ')}</Text>
          {': '}
          {m.value}
          {m.scope === 'persona' ? '  · private' : ''}
        </Text>
        <Pressable
          onPress={() => void resolve(m, 'confirm')}
          disabled={busy}
          style={({ pressed }) => [
            styles.memoryActionBtn,
            styles.memoryConfirmBtn,
            pressed && !busy && { opacity: 0.6 },
            busy && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.memoryConfirmTxt}>✓</Text>
        </Pressable>
        <Pressable
          onPress={() => void resolve(m, 'reject')}
          disabled={busy}
          style={({ pressed }) => [
            styles.memoryActionBtn,
            styles.memoryRejectBtn,
            pressed && !busy && { opacity: 0.6 },
            busy && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.memoryRejectTxt}>✗</Text>
        </Pressable>
      </View>
    );
  };

  const total = pending.length + confirmedHere.length + confirmedOthers.length;
  return (
    <Section title="Memory" count={total}>
      {memories.length === 0 && (
        <Text style={styles.empty}>
          Nothing yet. Chord will note durable facts from chat (allergies, home airport, etc.) and ask you to confirm before saving.
        </Text>
      )}
      {pending.length > 0 && (
        <>
          <Text style={[styles.subCardTitle, { marginTop: 0 }]}>
            Pending facts - {pending.length}
          </Text>
          {pending.map(renderPending)}
        </>
      )}
      {confirmedHere.length > 0 && (
        <>
          <Text
            style={[styles.subCardTitle, { marginTop: pending.length > 0 ? 10 : 0 }]}
          >
            Confirmed
          </Text>
          {confirmedHere.map(renderConfirmed)}
        </>
      )}
      {confirmedOthers.length > 0 && (
        <>
          <Text
            style={[
              styles.subCardTitle,
              { marginTop: pending.length > 0 || confirmedHere.length > 0 ? 10 : 0 },
            ]}
          >
            Your Other Memories
          </Text>
          {confirmedOthers.map(renderConfirmed)}
        </>
      )}
    </Section>
  );
}

// ── shared primitives ──────────────────────────────────────────────

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilesSection({
  files,
  groupNames,
  archivedIds,
  scrollRef,
  onDelete,
  groups,
  onUpload,
}: {
  files: Attachment[];
  groupNames: Record<string, string>;
  /** Attachment ids that are source docs of a past trip (ADR 0046). */
  archivedIds: Set<string>;
  scrollRef: RefObject<ScrollView | null>;
  onDelete: (attachmentId: string) => Promise<void>;
  groups: { id: string; name: string }[];
  onUpload: (groupId: string, kind: 'file' | 'photo' | 'camera') => Promise<number>;
}) {
  const confirmDelete = useCallback(
    (att: Attachment) => {
      confirmDestructive(
        'Delete file',
        `Delete "${att.filename}"? Chord will stop using it.`,
        () => void onDelete(att.id).catch(() => {}),
      );
    },
    [onDelete],
  );

  // A past trip's source documents archive with the trip: render them above
  // the live files and auto-scroll past them on open (ADR 0046).
  const archived = files.filter((f) => archivedIds.has(f.id));
  const active = files.filter((f) => !archivedIds.has(f.id));
  const boundaryRef = useRef<View>(null);
  useScrollPastArchived(scrollRef, boundaryRef, archived.length > 0 && active.length > 0);

  const renderFile = (att: Attachment) => (
    <FileRow key={att.id} att={att} groupNames={groupNames} onDelete={() => confirmDelete(att)} />
  );

  return (
    <Section title="Attachments" count={files.length}>
      <UploadAddRow label="Upload file" groups={groups} onUpload={onUpload} />
      {files.length === 0 && (
        <Text style={styles.empty}>
          No attachments yet. Tap + to upload a file or photo (or take one) and we'll index it
          into Chord's memory — or send one in a chat / let Chord pull them from your email.
        </Text>
      )}
      {archived.length > 0 && (
        <>
          <Text style={styles.archiveLabel}>↑ Archived - from past trips · {archived.length}</Text>
          {archived.map(renderFile)}
          <View ref={boundaryRef} style={styles.archiveBoundary} />
        </>
      )}
      {active.map(renderFile)}
    </Section>
  );
}

function isBlobMissingError(msg: string): boolean {
  // 410 from our route, or 404 / ENOENT for older servers / odd casings.
  return /\b(410|404)\b/.test(msg) || /BLOB_MISSING|ENOENT/i.test(msg);
}

function FileRow({
  att,
  groupNames,
  onDelete,
}: {
  att: Attachment;
  groupNames: Record<string, string>;
  onDelete: () => void;
}) {
  const isImage = att.mimeType.startsWith('image/');
  const [missing, setMissing] = useState(false);

  const reportMissing = useCallback(() => {
    setMissing(true);
    const msg = `"${att.filename}" is no longer available - the file was removed from disk. Delete this entry?`;
    confirmDestructive('File missing', msg, onDelete, { cancelLabel: 'Keep' });
  }, [att.filename, onDelete]);

  const groupName =
    att.scope.kind === 'group' ? groupNames[att.scope.groupId] ?? 'Group' : 'Personal';
  const meta = [groupName, fmtFileSize(att.size), new Date(att.createdAt).toLocaleDateString()]
    .filter(Boolean)
    .join('  ·  ');

  // Image source for the lightbox is lazy-loaded the first time the row
  // is opened - avoids fetching thumbnails for every file just to list them.
  const [opening, setOpening] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imgSource, setImgSource] = useState<
    { uri: string; headers?: Record<string, string> } | null
  >(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    cleanupRef.current?.();
  }, []);

  // Eager-load a thumbnail for image rows so the Files tab visualizes images
  // the same way chat does (chat's AttachmentCard renders an inline thumbnail).
  // Degrades silently to the icon on failure - only an explicit tap surfaces a
  // "file missing" prompt, so listing never spams that dialog.
  useEffect(() => {
    if (!isImage) return;
    let active = true;
    (async () => {
      try {
        const src = await attachmentImageSource(att.id);
        if (!active) {
          src.cleanup?.();
          return;
        }
        cleanupRef.current = src.cleanup ?? null;
        setImgSource({ uri: src.uri, headers: src.headers });
      } catch {
        // ignore - row degrades to the mime icon
      }
    })();
    return () => {
      active = false;
    };
  }, [att.id, isImage]);

  const openFile = useCallback(async () => {
    if (opening) return;
    if (isImage) {
      setLightboxOpen(true);
      if (!imgSource) {
        try {
          const src = await attachmentImageSource(att.id);
          cleanupRef.current = src.cleanup ?? null;
          setImgSource({ uri: src.uri, headers: src.headers });
        } catch (err) {
          if (isBlobMissingError((err as Error).message)) {
            setLightboxOpen(false);
            reportMissing();
          }
          // else: lightbox stays on the spinner; user can dismiss
        }
      }
      return;
    }
    // Non-image: web opens an authed blob in a new tab; native downloads with
    // auth and hands the file to the OS viewer (Quick Look / app chooser).
    if (Platform.OS !== 'web') {
      setOpening(true);
      try {
        await openAttachmentNative(att);
      } catch (err) {
        if (isBlobMissingError((err as Error).message)) reportMissing();
        else Alert.alert('Couldn’t open file', `${att.filename}: ${(err as Error).message}`);
      } finally {
        setOpening(false);
      }
      return;
    }
    if (typeof window === 'undefined') return;
    setOpening(true);
    try {
      if (opensInFileViewer(att.mimeType, att.filename, 'web')) {
        await openAttachmentFileOnWeb(att.id, att.filename, att.mimeType);
        return;
      }
      const blobUrl = await fetchAttachmentBlobUrl(att.id);
      window.open(blobUrl, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      if (isBlobMissingError((err as Error).message)) {
        reportMissing();
      } else {
        window.alert(`Couldn't open ${att.filename}: ${(err as Error).message}`);
      }
    } finally {
      setOpening(false);
    }
  }, [opening, isImage, imgSource, att, reportMissing]);

  return (
    <>
      <Pressable
        onPress={openFile}
        style={({ pressed }) => [styles.fileRow, pressed && { opacity: 0.6 }]}
      >
        {isImage && imgSource ? (
          <Image source={imgSource} style={styles.fileThumb} resizeMode="cover" />
        ) : (
          <Text style={styles.fileRowIcon}>{opening ? '…' : isImage ? '🖼' : '📄'}</Text>
        )}
        <View style={styles.fileInfo}>
          <Text style={styles.fileNameTxt} numberOfLines={1}>
            {att.filename}
          </Text>
          <Text style={styles.fileMetaTxt} numberOfLines={2}>
            {missing ? '⚠ file missing  ·  ' : ''}
            {meta}
            {att.summary ? `\n${att.summary}` : ''}
          </Text>
          {att.originEmailThreadId ? (
            <Pressable
              onPress={() => router.push(`/email/${att.originEmailThreadId}`)}
              hitSlop={6}
            >
              <Text style={styles.fileEmailLink}>✉ View original email</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={onDelete}
          style={({ pressed }) => [styles.tripDeleteBtn, pressed && { opacity: 0.5 }]}
          hitSlop={8}
        >
          <Text style={styles.tripDeleteTxt}>✕</Text>
        </Pressable>
      </Pressable>

      {isImage && (
        <Modal
          visible={lightboxOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setLightboxOpen(false)}
        >
          <Pressable style={lightboxStyles.backdrop} onPress={() => setLightboxOpen(false)}>
            {imgSource ? (
              <Image
                source={imgSource}
                style={lightboxStyles.image}
                resizeMode="contain"
                onError={() => {
                  setLightboxOpen(false);
                  reportMissing();
                }}
              />
            ) : (
              <ActivityIndicator color="#fff" />
            )}
            <View style={lightboxStyles.caption} pointerEvents="none">
              <Text style={lightboxStyles.filename} numberOfLines={1}>
                {att.filename}
              </Text>
              {att.summary ? (
                <Text style={lightboxStyles.summary} numberOfLines={6}>
                  {att.summary}
                </Text>
              ) : null}
            </View>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const lightboxStyles = themed(() => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '85%' },
  caption: { position: 'absolute', left: 16, right: 16, bottom: 24 },
  filename: { color: '#fff', fontSize: 14, fontWeight: '600' },
  summary: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 4 },
}));

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {typeof count === 'number' && <Text style={styles.sectionCount}>{count}</Text>}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  err: { color: colors.red, marginBottom: 8 },
  undoBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 64,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  undoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    maxWidth: 460,
  },
  undoText: { color: colors.bg, flexShrink: 1, fontSize: 13 },
  undoBtn: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  tripUndoBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 130,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  doneToggle: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  doneToggleText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  headerBack: { paddingLeft: 12, paddingRight: 4, paddingVertical: 6 },
  headerBackTxt: { color: colors.accent, fontSize: 15, fontWeight: '600' },

  section: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14,
    overflow: 'hidden',
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  crossGroupHeader: { fontSize: 11, fontWeight: '600', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 10, marginBottom: 4 },
  sectionCount: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'] },
  sectionBody: { padding: 8 },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  rowText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  check: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginTop: 2,
  },
  tag: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginTop: 1,
  },

  subCard: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  subCardTitle: { fontSize: 12, fontWeight: '600', color: colors.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
  // ADR 0046 - header above the archived (past-trip) block; the boundary is the
  // auto-scroll target so archived rows sit just above the fold.
  archiveLabel: { fontSize: 11, fontWeight: '600', color: colors.muted, marginBottom: 6, opacity: 0.8 },
  archiveBoundary: { height: 8 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  listKindChip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  listKindChipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  // Which group(s) an item lives in, on a card that spans more than one.
  // RSVP (ADR 0104) — worded buttons, not a tick and a cross: "yes" to a
  // person is a different act from "confirm" on a suggestion, and Maybe has no
  // glyph anyone would read the same way twice.
  proposalError: { fontSize: 11, color: colors.red, marginTop: 3 },
  rsvpBtns: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  rsvpBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  rsvpBtnTxt: { fontSize: 12, fontWeight: '700', color: '#fff' },
  rsvpYes: { backgroundColor: '#15803D' },
  rsvpMaybe: { backgroundColor: '#8a6100' },
  rsvpNo: { backgroundColor: '#8a2f2f' },
  rsvpPick: { borderWidth: 2, borderColor: colors.text },
  rowGroupChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  rowGroupChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: colors.bg2,
  },
  rowGroupChipText: { fontSize: 10, color: colors.muted },
  tripTitle: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 2 },
  tripCancelledBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.red,
    marginBottom: 2,
  },
  tripDeletedBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.muted,
    marginBottom: 2,
  },
  tripPassengers: { fontSize: 11, color: colors.muted, marginBottom: 6 },
  tripDeleteBtn: { paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 },
  tripDeleteTxt: { fontSize: 12, color: colors.muted },
  tripRestoreBtn: { paddingHorizontal: 8, paddingVertical: 3, marginLeft: 4, borderRadius: 6, backgroundColor: colors.accentLight },
  tripRestoreTxt: { fontSize: 11, fontWeight: '700', color: colors.accent },
  tripTimelineRemoveBtn: { marginTop: 2 },
  tripTimelineRemoveTxt: { fontSize: 10, fontWeight: '600', color: colors.red },
  tripDates: { fontSize: 11, color: colors.muted, marginBottom: 6 },
  tripTimeline: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden', marginBottom: 4 },
  tripTimelineRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 8, gap: 8, backgroundColor: colors.bg2 },
  tripTimelineRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  tripTimelineTag: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, color: colors.accent, backgroundColor: colors.accentLight, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, marginTop: 1, minWidth: 36, textAlign: 'center' },
  tripTimelineTagStay: { color: colors.green, backgroundColor: colors.greenBg },
  tripTimelineTagReservation: { color: colors.warn, backgroundColor: colors.amberBg },
  // ADR 0168/0169 — a cancellation notice matched THIS leg/stay specifically;
  // the trip itself often stays live (other bookings still stand), so the
  // indicator has to live on the row, not just on the trip-level badge.
  tripTimelineRowCancelled: { opacity: 0.55 },
  tripTimelineTagCancelled: { color: colors.red, backgroundColor: colors.redBg },
  tripTimelineMain: { fontSize: 12, fontWeight: '600', color: colors.text },
  tripTimelineMainCancelled: { textDecorationLine: 'line-through' },
  tripTimelineSub: { fontSize: 11, color: colors.muted, marginTop: 1 },
  memberShield: { fontSize: 14, fontWeight: '700', width: 18, textAlign: 'center' },
  taskMoreBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 4,
    borderRadius: 6,
  },
  taskMoreTxt: { fontSize: 18, color: colors.muted, fontWeight: '700' },
  provSmallBtn: { paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 },
  provSmallTxt: { fontSize: 14, color: colors.muted },
  tripTitleRow: { flexDirection: 'row', alignItems: 'flex-start' },

  memoryPendingRow: {
    backgroundColor: byScheme('#FFF9E6', colors.amberBg),
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
    paddingLeft: 8,
    borderRadius: 6,
    marginBottom: 4,
  },
  memoryPendingTag: { backgroundColor: colors.amberBg, color: colors.warn },
  proposalSourceHint: { color: colors.accent, fontSize: 11.5, fontWeight: '600', marginTop: 3 },
  proposalCluster: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
  },
  proposalClusterHead: { fontSize: 13, fontWeight: '700', color: colors.text },
  proposalClusterSub: { fontSize: 11, color: colors.muted, marginBottom: 6 },
  routeOfferRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  routeOfferText: { flex: 1, fontSize: 12, color: colors.text },
  routeOfferSaved: { flex: 1, fontSize: 12, color: colors.muted },
  routeOfferBtns: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  routeOfferYes: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  routeOfferYesTxt: { fontSize: 12, fontWeight: '700', color: colors.onAccent },
  routeOfferDismiss: { fontSize: 13, color: colors.muted, paddingHorizontal: 4 },
  memoryActionBtn: {
    minWidth: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  memoryConfirmBtn: { backgroundColor: colors.greenBg },
  memoryConfirmTxt: { color: colors.green, fontWeight: '700', fontSize: 14 },
  memoryRejectBtn: { backgroundColor: colors.redBg },
  memoryRejectTxt: { color: colors.red, fontWeight: '700', fontSize: 14 },
  replyEditBtn: { backgroundColor: colors.accentLight, paddingHorizontal: 8 },
  removeEmailBtn: { marginLeft: 4 },
  replyEditTxt: { color: colors.accent, fontWeight: '700', fontSize: 12 },

  auditToggle: {
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
    gap: 6,
    opacity: 0.72,
  },
  auditIcon: { fontSize: 11, color: colors.muted, marginTop: 2 },
  auditLabel: {
    fontSize: 12,
    color: colors.text,
    textDecorationLine: 'line-through',
    textDecorationStyle: 'solid',
  },
  auditSubtitle: { fontSize: 10, color: colors.muted, marginTop: 1 },
  auditMeta: {
    fontSize: 10,
    color: colors.muted,
    fontStyle: 'italic',
    marginLeft: 8,
    alignSelf: 'center',
  },

  provBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  provSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
    maxHeight: '75%',
  },
  provHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  provTitle: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1, paddingRight: 12 },
  provClose: { fontSize: 18, color: colors.muted, paddingHorizontal: 4 },
  provSub: { fontSize: 11, color: colors.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 },
  provScroll: { maxHeight: 400 },
  provBody: { fontSize: 12, color: colors.text, lineHeight: 18, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },

  empty: { color: colors.muted, fontStyle: 'italic', padding: 8, fontSize: 12 },

  financeNote: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingBottom: 8 },
  financeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 8 },
  financeRowMain: { flex: 1, minWidth: 0 },
  financeMerchant: { fontSize: 14, color: colors.text, fontWeight: '600' },
  financeSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  financeAmount: { fontSize: 14, color: colors.text, fontVariant: ['tabular-nums'] },

  addForm: { flexDirection: 'row', gap: 6, paddingHorizontal: 4, paddingTop: 4 },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: colors.bg,
  },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 18 },

  eventRow: {
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 4,
  },
  rsvpHeader: { fontSize: 11, color: colors.muted, marginTop: 2 },
  rsvpList: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  rsvpPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  rsvpPillText: { fontSize: 11, fontWeight: '600' },
  rsvpForm: { gap: 6, paddingTop: 6 },

  eventForm: { gap: 6, paddingHorizontal: 4, paddingTop: 6 },
  eventSubmit: {
    width: 'auto',
    height: 'auto',
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'flex-start',
  },
  eventSubmitText: { color: colors.onAccent, fontWeight: '600', fontSize: 13 },

  tripGroup: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 6,
    paddingLeft: 10,
    paddingTop: 2,
    paddingBottom: 2,
    backgroundColor: colors.bg2,
    marginBottom: 4,
  },
  tripGroupDate: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.accent,
    marginBottom: 6,
    marginTop: 4,
  },
  tripCard: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tripCardOther: {
    backgroundColor: byScheme('#f5f4f0', colors.bg2),
    borderColor: byScheme('#dddbd4', colors.border),
    opacity: 0.85,
  },
  tripLegPassenger: { fontSize: 10, color: colors.accent, fontWeight: '600', marginTop: 2 },
  tripSourceGone: { fontSize: 10, color: colors.muted, fontStyle: 'italic', marginTop: 2 },
  kindRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingHorizontal: 4, paddingVertical: 6 },
  kindChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kindChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  kindChipText: { fontSize: 11, color: colors.muted },
  kindChipTextActive: { color: colors.accent, fontWeight: '600' },

  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 8,
  },
  fileInfo: { flex: 1, gap: 2 },
  fileThumb: { width: 40, height: 40, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.06)' },
  fileRowIcon: { fontSize: 20, width: 40, textAlign: 'center' },
  fileNameTxt: { fontSize: 14, color: colors.text },
  fileMetaTxt: { fontSize: 11, color: colors.muted },
  fileEmailLink: { fontSize: 12, color: colors.accent, fontWeight: '600', marginTop: 4 },
  pinBtn: {
    padding: 4,
    borderRadius: 6,
    opacity: 0.35,
  },
  pinBtnActive: { opacity: 1 },
  pinTxt: { fontSize: 16 },
  pinTxtActive: { fontSize: 16 },
  uploadBtn: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  addBtnTxt: { color: colors.onAccent, fontWeight: '600', fontSize: 14 },
}));
