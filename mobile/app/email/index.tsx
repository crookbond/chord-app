/**
 * Email - Tab 1 (ADR 0060 / 0083). AI is the decision-queue shell;
 * Traditional (opened on every launch) is the complete mailbox (ADR 0086
 * action chips). Long-press the Email tab for folders.
 */
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack, router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { TextInput } from '@/text-input';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  EmailAction,
  EmailDecisionsResponse,
  EmailFolder,
  EmailStatus,
  EmailSwipeAction,
  EmailThreadFile,
  EmailThreadSummary,
} from '@chord/kernel';
import {
  createLatestGuard,
  fetchPredatesRemoval,
  inboxListStorage,
  REFETCH_COALESCE_MS,
  splitFits,
  withoutRemoved,
} from '@chord/kernel';
import { useCoalesced } from '@/use-coalesced';

import {
  GmailReconnectError,
  getEmailStatus,
  getSettingsCached,
  listEmailDecisions,
  listEmailThreads,
  threadPageCursor,
  modifyEmailThreads,
  snoozeEmailThread,
  openUserStream,
  readSavedCopy,
  readSavedEmailDecisions,
  syncEmail,
  type StreamHandle,
} from '@/api';
import {
  hasAnyMailbox,
  mailboxDisplayName,
  mailboxFilterIds,
  primaryMailboxDisplayName,
} from '@chord/kernel';
import { loadNotNow, urgentDecisions } from '@/email-decisions';
import { EmailFolderSheet } from '@/email-folder-sheet';
import { EmailFeed } from '@/email-feed';
import { EmailCards } from '@/email-cards';
import { EmailTiles } from '@/email-tiles';
import { AiKeyBanner } from '@/ai-key-banner';
import { EmailUrgentStrip } from '@/email-urgent-strip';
import { ReadingPanePlaceholder, SplitFrame } from '@/email-split-pane';
// The reader, drawn in this screen's right-hand pane on a wide window (ADR
// 0320). Its own route keeps the default export; this is the same component.
import { EmailThreadReader } from './[threadId]';
import { ACTION_COLOR, ActionBadge } from '@/email-action-badge';
import { ActionSheet, Icon, SelectionBar } from '@/email-reader-bar';
import { confirmDestructive } from '@/confirm';
import { useEmailThreadNav } from '@/email-thread-nav';
import { openEmailAttachment } from '@/open-email-attachment';
import {
  applyThreadUpdate,
  deviceMailReady,
  readStoredInbox,
  scheduleDeviceMailPass,
  storeInboxList,
} from '@/email-device-store';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SWIPE_THRESHOLD, SwipePanel } from '@/swipe-panel';

import { MainBottomNav } from '@/group-nav';
import { useScrollTopOnReselect } from '@/tab-reselect';
import { useScreenRefresh } from '@/refresh';
import { loadErrorText } from '@/network';
import { byScheme, colors, themed } from '@/theme';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

type ViewMode = 'traditional' | 'ai';
/** Every app launch opens on Traditional; a switch holds until the next
 *  launch. Module scope, so it outlives this screen unmounting. */
let sessionViewMode: ViewMode = 'traditional';

/** ADR 0147 — the four AI-view layouts, kept side by side so people can pick. */
type AiViewStyle = 'feed' | 'cards' | 'map';
const AI_VIEW_STYLE_KEY = 'email.aiViewStyle';
const AI_VIEW_STYLE_LABELS: Record<AiViewStyle, string> = {
  feed: 'Feed',
  cards: 'Cards',
  map: 'Map',
};
const AI_VIEW_STYLES: AiViewStyle[] = ['feed', 'cards', 'map'];
const THREADS_CACHE_KEY = 'email.threads.cache.v1';
/** Per-device, like the view mode: a refresh reopens the folder and mailbox
 *  you were in. The label is deliberately not kept - an old label on reopen
 *  reads as missing mail. */
const FOLDER_KEY = 'email.folder';
const ACCOUNT_KEY = 'email.account';
/**
 * Coming back to the list from an email re-focuses it. That used to run a full
 * mailbox sync every time - seconds per mailbox - so reading five emails in a
 * row meant five syncs. On focus the mirror is re-read at once and the sync
 * only runs when the last one is older than this; pull-to-refresh and a
 * return from the background always sync.
 */
const FOCUS_SYNC_MIN_GAP_MS = 60_000;
let lastSyncAt = 0;
/** Matches the server's default page size; a shorter page means the end. */
const PAGE_SIZE = 50;
const IS_WEB = Platform.OS === 'web';
const FOLDER_LABELS: Record<EmailFolder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  archive: 'Archive',
  snoozed: 'Snoozed',
};

/**
 * ADR 0129 - the choices a snooze offers. Deliberately coarse: a picker that
 * asks for a date and time is a bigger UI than "not now" deserves.
 */
const SNOOZE_CHOICES: { label: string; hours: number }[] = [
  { label: 'Later today', hours: 4 },
  { label: 'Tomorrow', hours: 24 },
  { label: 'Next week', hours: 24 * 7 },
];

function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(name: string | null, email: string | null): string {
  const base = (name ?? email ?? '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

// The action axis, orthogonal to the category tiles: what a thread wants from
// you, rather than what it is about. `null` = no filter. 'unread' shares the
// row but filters on read state, not the action axis.
type ListFilter = EmailAction | 'unread' | null;
const ACTION_FILTERS: { key: ListFilter; label: string }[] = [
  { key: null, label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'to_do', label: 'To do' },
  { key: 'reply_needed', label: 'Reply' },
  { key: 'informational', label: 'FYI' },
];

function listFilterOpts(f: ListFilter): { actions?: EmailAction[]; unreadOnly?: boolean } {
  if (f === 'unread') return { unreadOnly: true };
  return f ? { actions: [f] } : {};
}

/** ADR 0145 — a user-chosen nickname wins; the ADR 0119 local part is the
 *  fallback. The rule lives in kernel so the chip row, the per-row account
 *  badge and Settings cannot drift apart about what a mailbox is called. */
function mailboxLabel(address: string, nickname?: string | null): string {
  return mailboxDisplayName(nickname, address);
}

const FILE_CHIPS_SHOWN = 3;

/**
 * The thread's files under its preview line: tapping one opens that file,
 * tapping the rest of the row opens the thread. While selecting, a tap on a
 * chip selects the row like anywhere else on it.
 */
function FileChips({ files, disabled }: { files: EmailThreadFile[]; disabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = async (f: EmailThreadFile) => {
    setBusy(f.id);
    setErr(null);
    try {
      await openEmailAttachment(f.messageId, f);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const extra = files.length - FILE_CHIPS_SHOWN;
  return (
    <View pointerEvents={disabled ? 'none' : 'auto'}>
      <View style={styles.fileChips}>
        {files.slice(0, FILE_CHIPS_SHOWN).map((f) => (
          <Pressable
            key={`${f.messageId}:${f.id}`}
            onPress={() => void open(f)}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={`Open ${f.filename}`}
            style={({ pressed }) => [styles.fileChip, pressed && { opacity: 0.6 }]}
          >
            <MaterialCommunityIcons name="paperclip" size={12} color={colors.muted} />
            <Text style={styles.fileChipTxt} numberOfLines={1}>
              {busy === f.id ? 'Opening…' : f.filename}
            </Text>
          </Pressable>
        ))}
        {extra > 0 ? <Text style={styles.fileMore}>+{extra} more</Text> : null}
      </View>
      {err ? <Text style={styles.fileErr}>{err}</Text> : null}
    </View>
  );
}

function ThreadRowImpl({
  item,
  showAccount,
  accountName,
  accountColor,
  selecting,
  selected,
  onToggleSelect,
  onOpen,
  swipeAction = 'archive',
  onArchive,
  onTrash,
  onToggleRead,
}: {
  item: EmailThreadSummary;
  /** Only with more than one mailbox attached: otherwise every row would carry
   *  the same chip, which says nothing. */
  showAccount?: boolean;
  /** ADR 0145 — resolved by the parent, which is what holds the nicknames. */
  accountName?: string;
  /** ADR 0278 — the mailbox's color, for its tag and the row's edge. */
  accountColor?: string;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Reading pane: opening an email is a selection here, not a navigation. */
  onOpen?: (id: string) => void;
  /** ADR 0215 — the user's Settings choice for the swipe. */
  swipeAction?: EmailSwipeAction;
  onArchive?: (id: string) => void;
  onTrash?: (id: string) => void;
  /** `markRead` is the state the row moves to. */
  onToggleRead?: (id: string, markRead: boolean) => void;
}) {
  const trash = swipeAction === 'trash';
  const swipeRef = useRef<SwipeableMethods>(null);
  // With a mouse, long-press is not a gesture anyone reaches for, so web shows
  // the checkbox on hover and a click on it starts (or extends) a selection.
  const [hovered, setHovered] = useState(false);
  const showCheck = selecting || (IS_WEB && hovered);
  const row = (
    <Pressable
      style={[
        styles.row,
        showAccount && accountColor ? { borderLeftWidth: 4, borderLeftColor: accountColor } : null,
        selected && styles.rowSelected,
      ]}
      onLongPress={() => onToggleSelect?.(item.id)}
      onPress={() =>
        selecting
          ? onToggleSelect?.(item.id)
          : onOpen
            ? onOpen(item.id)
            : router.push(`/email/${item.id}`)
      }
      onHoverIn={IS_WEB ? () => setHovered(true) : undefined}
      onHoverOut={IS_WEB ? () => setHovered(false) : undefined}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarTxt}>{initials(item.fromName, item.fromEmail)}</Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.from, item.isUnread && styles.unread]} numberOfLines={1}>
            {item.fromName ?? item.fromEmail ?? 'Unknown'}
          </Text>
          <Text style={styles.time}>{relTime(item.lastMessageAt)}</Text>
        </View>
        <View style={styles.subjectRow}>
          {item.hasAttachments ? (
            <MaterialCommunityIcons name="paperclip" size={14} color={colors.muted} accessibilityLabel="Has attachment" />
          ) : null}
          <Text
            style={[styles.subject, item.isUnread && styles.unread, { flex: 1 }]}
            numberOfLines={1}
          >
            {item.subject || '(no subject)'}
            {item.messageCount > 1 ? `  ·  ${item.messageCount}` : ''}
          </Text>
          <ActionBadge action={item.action} />
        </View>
        <Text style={styles.snippet} numberOfLines={1}>
          {item.hasDraft ? <Text style={styles.draftTag}>Draft  </Text> : null}
          {item.snippet}
        </Text>
        {item.files?.length ? <FileChips files={item.files} disabled={!!selecting} /> : null}
        {showAccount ? (
          <View style={styles.acctRow}>
            {accountColor ? <View style={[styles.acctDot, { backgroundColor: accountColor }]} /> : null}
            <Text style={[styles.acct, accountColor ? { color: accountColor } : null]} numberOfLines={1}>
              {accountName}
            </Text>
          </View>
        ) : null}
      </View>
      {IS_WEB || selecting ? (
        // Always mounted on web: pressing the mouse hands it to the swipe
        // gesture, which fires a hover-out, and a checkbox that unmounted on
        // hover-out would be gone before the click landed.
        <Pressable
          onPress={() => onToggleSelect?.(item.id)}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!selected }}
          accessibilityLabel="Select email"
          style={[
            styles.check,
            !showCheck && styles.checkHidden,
            selected && styles.checkOn,
          ]}
        >
          {selected ? (
            <Text style={styles.checkTxt}>{'\u2713'}</Text>
          ) : !showCheck && item.isUnread ? (
            <View style={styles.dot} />
          ) : null}
        </Pressable>
      ) : (
        // The column is kept on read rows too, so every row's pill lines up.
        <View style={[styles.dot, !item.isUnread && styles.dotOff]} />
      )}
    </Pressable>
  );

  // While selecting, a swipe would fight the checkbox for the same gesture.
  if (selecting) return row;

  return (
    <Swipeable
      ref={swipeRef}
      // ADR 0274 - finger right: read state; finger left: archive or Trash,
      // as chosen in Settings (ADR 0215). The library names a swipe by where
      // the ROW went, so "right" is the finger moving right.
      renderLeftActions={(progress) => (
        <SwipePanel
          progress={progress}
          color={colors.accent}
          icon={item.isUnread ? 'email-open-outline' : 'email-outline'}
          label={item.isUnread ? 'Read' : 'Unread'}
        />
      )}
      renderRightActions={(progress) => (
        <SwipePanel
          progress={progress}
          color={trash ? colors.red : colors.green}
          icon={trash ? 'trash-can-outline' : 'archive-arrow-down-outline'}
          label={trash ? 'Trash' : 'Archive'}
        />
      )}
      onSwipeableWillOpen={(dir) => {
        if (dir === 'left') (trash ? onTrash : onArchive)?.(item.id);
      }}
      onSwipeableOpen={(dir) => {
        if (dir !== 'right') return;
        onToggleRead?.(item.id, item.isUnread);
        // Read state keeps the row, so it springs back rather than staying open.
        swipeRef.current?.close();
      }}
      friction={1}
      leftThreshold={SWIPE_THRESHOLD}
      rightThreshold={SWIPE_THRESHOLD}
      dragOffsetFromLeftEdge={12}
      dragOffsetFromRightEdge={12}
      overshootLeft={false}
      overshootRight={false}
      animationOptions={{ damping: 26, stiffness: 260, mass: 0.6 }}
      containerStyle={styles.swipeContainer}
    >
      {row}
    </Swipeable>
  );
}

const ThreadRow = memo(ThreadRowImpl);

/**
 * A row of filter chips that is allowed to outgrow the screen.
 *
 * One chip per connected mailbox (ADR 0119, named by the user since ADR 0145)
 * is an unbounded row, and in a plain View every chip past the right edge was
 * simply clipped - unreachable, with nothing to say it was there. It scrolls
 * sideways now; a half-shown chip at the edge is the hint that it does.
 */
function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.filterScroll}
      contentContainerStyle={styles.filterRow}
    >
      {children}
    </ScrollView>
  );
}

function RowSeparator() {
  return <View style={styles.sep} />;
}

export default function EmailScreen() {
  const [mode, setMode] = useState<ViewMode>(sessionViewMode);
  const [aiViewStyle, setAiViewStyle] = useState<AiViewStyle>('feed');
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [threads, setThreads] = useState<EmailThreadSummary[]>([]);
  /** Set once the server answered; the stored list only paints before that. */
  const listFromServer = useRef(false);
  /**
   * When the request behind `threads` was ISSUED (0 = a stored copy of unknown
   * age), and when the newest one was. An email put away from the reader is
   * confirmed after it has left this screen's `removing` set, so a list read
   * issued before that write landed still carries it: the rows are filtered
   * against removals stamped since (ADR 0286), and one such removal asks for
   * a fresh read.
   */
  const threadsFetchedAt = useRef(0);
  const lastAskedAt = useRef(0);
  const focusedRef = useRef(false);
  const [actionFilter, setActionFilter] = useState<ListFilter>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [decisionsPayload, setDecisionsPayload] = useState<EmailDecisionsResponse | null>(null);
  const [notNow, setNotNow] = useState<Set<string>>(new Set());
  const [folderOpen, setFolderOpen] = useState(false);
  /** ADR 0215 — re-read on focus, so a change in Settings applies on return. */
  const [swipeAction, setSwipeAction] = useState<EmailSwipeAction>('archive');
  const [folder, setFolder] = useState<EmailFolder>('inbox');
  /** Browsing one label (ADR 0125). Null = every label, which is the default. */
  const [label, setLabel] = useState<{ id: string; name: string } | null>(null);
  /** Which mailbox to show; undefined = all of them (ADR 0119). */
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  /** Null once the server returns a short page: there is nothing after it, so
   *  scrolling must stop asking. */
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /** ADR 0128 - selection mode. Empty set = not selecting. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selMoreOpen, setSelMoreOpen] = useState(false);
  const [triageMsg, setTriageMsg] = useState<string | null>(null);
  /** Ids awaiting a "how long" answer, or null when nothing is being snoozed. */
  const [snoozeFor, setSnoozeFor] = useState<string[] | null>(null);
  /** ADR 0141 — typing a Chord label onto the selection. */
  const [labelFor, setLabelFor] = useState<string[] | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [showUnclassifiedOnly, setShowUnclassifiedOnly] = useState(false);
  /** ADR 0134 — which coverage count the user tapped through to, and the
   *  threads behind it. Fetched by id rather than filtered out of `threads`:
   *  an expired-but-owed thread is days old and routinely past the newest
   *  page, and a handled one may since have been archived. */
  const [coverageView, setCoverageView] = useState<'handled' | 'owed' | null>(null);
  const [coverageThreads, setCoverageThreads] = useState<EmailThreadSummary[]>([]);
  /** Archived/trashed here or in the reader: pending, and when each was stamped. */
  const removing = useEmailThreadNav((s) => s.removing);
  const removedAt = useEmailThreadNav((s) => s.removedAt);
  // Read from the store at call time, not a render-old copy: a refetch that
  // lands right after a release must already see it released.
  const withoutRemoving = useCallback((list: EmailThreadSummary[], fetchedAt: number) => {
    const { removing, removedAt } = useEmailThreadNav.getState();
    if (removing.size === 0 && removedAt.size === 0) return list;
    return withoutRemoved(list, (t) => t.id, { removing, removedAt }, fetchedAt);
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem(AI_VIEW_STYLE_KEY).then((s) => {
      if (s && (AI_VIEW_STYLES as string[]).includes(s)) setAiViewStyle(s as AiViewStyle);
    });
    // The mailbox status and the AI view's decisions this phone saved last
    // paint at once; the server's answers replace them, never the other way.
    void readSavedCopy<EmailStatus>('email-status').then((s) => {
      if (s) setStatus((prev) => prev ?? s);
    });
    void readSavedEmailDecisions().then((d) => {
      if (d) setDecisionsPayload((prev) => prev ?? d);
    });
    // Phones paint from the two-week store (ADR 0302); web keeps the short
    // AsyncStorage list. Only until the first real answer: a stored list
    // must never replace a fresher one.
    void deviceMailReady().then(async (ready) => {
      if (ready) {
        const list = await readStoredInbox();
        const f = filtersRef.current;
        const unfiltered = !f.actionFilter && f.folder === 'inbox' && !f.account && !f.label;
        if (list && unfiltered && !listFromServer.current) setThreads(withoutRemoving(list, 0));
        return;
      }
      if (inboxListStorage({ web: Platform.OS === 'web', sealedReady: false }) !== 'plain') {
        // A browser never keeps mail in its storage; drop what an older build left.
        void AsyncStorage.removeItem(THREADS_CACHE_KEY).catch(() => {});
        return;
      }
      const raw = await AsyncStorage.getItem(THREADS_CACHE_KEY).catch(() => null);
      if (!raw || listFromServer.current) return;
      try {
        setThreads(withoutRemoving(JSON.parse(raw) as EmailThreadSummary[], 0));
      } catch {
        /* ignore stale cache */
      }
    });
    void loadNotNow().then(setNotNow);
    void Promise.all([AsyncStorage.getItem(FOLDER_KEY), AsyncStorage.getItem(ACCOUNT_KEY)])
      .then(([f, a]) => {
        if (f && f in FOLDER_LABELS) setFolder(f as EmailFolder);
        if (a) setAccount(a);
      })
      .catch(() => {
        /* storage unavailable: start where the defaults put us */
      })
      .finally(() => setFiltersLoaded(true));
  }, [withoutRemoving]);

  // Written only after the saved values were read back, or the defaults would
  // overwrite them on the first render.
  useEffect(() => {
    if (!filtersLoaded) return;
    void AsyncStorage.setItem(FOLDER_KEY, folder).catch(() => {});
    if (account) void AsyncStorage.setItem(ACCOUNT_KEY, account).catch(() => {});
    else void AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
  }, [filtersLoaded, folder, account]);

  // A saved mailbox that has since been disconnected would filter to nothing
  // and read as an empty inbox.
  useEffect(() => {
    if (!account || !status) return;
    if (!mailboxFilterIds(status).includes(account)) setAccount(undefined);
  }, [account, status]);

  const pickMode = useCallback((m: ViewMode) => {
    setMode(m);
    sessionViewMode = m;
    if (m === 'ai') {
      setShowUnclassifiedOnly(false);
      setCoverageView(null);
      setCoverageThreads([]);
    }
  }, []);

  const pickAiViewStyle = useCallback((s: AiViewStyle) => {
    setAiViewStyle(s);
    void AsyncStorage.setItem(AI_VIEW_STYLE_KEY, s);
  }, []);

  // The filters are read from a ref at call time, and only the newest request
  // may write the list. Tapping mailbox chips in quick succession otherwise
  // left older requests in flight, and whichever answered last won — so the
  // list showed another mailbox's mail before settling. Keeping
  // `refreshThreads` stable also stops a chip tap from re-running the whole
  // focus `load` (status + a multi-second sync + a second refetch that
  // still closed over the previous mailbox).
  const filterKey = `${actionFilter ?? ''}|${folder}|${account ?? ''}|${label?.id ?? ''}`;
  const filtersRef = useRef({ actionFilter, folder, account, label, key: filterKey });
  filtersRef.current = { actionFilter, folder, account, label, key: filterKey };
  const refreshSeq = useRef(0);

  const refreshThreads = useCallback(async () => {
    const { actionFilter, folder, account, label, key } = filtersRef.current;
    const seq = ++refreshSeq.current;
    const askedAt = Date.now();
    lastAskedAt.current = askedAt;
    try {
      const list = await listEmailThreads({
        mode: 'traditional',
        ...listFilterOpts(actionFilter),
        folder,
        account,
        label: label?.id,
      });
      if (seq !== refreshSeq.current || key !== filtersRef.current.key) return;
      const shown = withoutRemoving(list, askedAt);
      threadsFetchedAt.current = askedAt;
      listFromServer.current = true;
      setThreads(shown);
      // A full page means there may be more; a short one is the end. Reset on
      // every refresh, since the filters above it may have changed.
      setMore(list.length >= PAGE_SIZE);
      // Only the unfiltered inbox is cached: priming the next cold start with a
      // filtered subset — or with Sent — would look like missing mail.
      if (!actionFilter && folder === 'inbox' && !account && !label) {
        // A phone with a key keeps it encrypted in its store and drops the
        // plain AsyncStorage copy; a build without the key store keeps the
        // short plain list it always had (ADR 0302). A browser keeps it in
        // this page's memory only (ADR 0304): never in localStorage.
        void deviceMailReady().then((ready) => {
          const where = inboxListStorage({ web: Platform.OS === 'web', sealedReady: ready });
          if (where === 'plain') {
            void AsyncStorage.setItem(THREADS_CACHE_KEY, JSON.stringify(shown)).catch(() => {});
            return;
          }
          void storeInboxList(shown, list.length < PAGE_SIZE);
          void AsyncStorage.removeItem(THREADS_CACHE_KEY).catch(() => {});
        });
      }
    } catch {
      /* keep cached list */
    }
  }, [withoutRemoving]);

  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void refreshThreads();
    }, REFETCH_COALESCE_MS);
  }, [refreshThreads]);
  useEffect(
    () => () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    },
    [],
  );

  // A filter change refetches just the list; the focus effect's `load` (and
  // its sync) runs on focus only.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    void refreshThreads();
  }, [filterKey, refreshThreads]);

  /**
   * Next page, keyed off the last row's timestamp rather than an offset: new
   * mail landing mid-scroll shifts an OFFSET and would duplicate or skip a row.
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || !more || threads.length === 0) return;
    setLoadingMore(true);
    const key = filtersRef.current.key;
    const askedAt = Date.now();
    try {
      const page = await listEmailThreads({
        mode: 'traditional',
        ...listFilterOpts(actionFilter),
        folder,
        account,
        label: label?.id,
        cursor: threadPageCursor(threads[threads.length - 1]),
      });
      // A page for filters the user has since left must not be appended.
      if (key !== filtersRef.current.key) return;
      setMore(page.length >= PAGE_SIZE);
      // Dedup on id: a thread whose last message arrived between the two
      // requests can legitimately appear in both pages.
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...withoutRemoving(page, askedAt).filter((t) => !seen.has(t.id))];
      });
    } catch {
      /* keep what is already shown */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, more, threads, actionFilter, folder, account, label, withoutRemoving]);

  // Publish the Traditional list's order + pagination so the thread reader
  // (opened by id alone) can offer prev/next without its own fetch logic.
  // Only in Traditional mode: an AI-view open is either a category walk,
  // which sets its own order (email-category-open.ts), or has no siblings.
  // With Unread on, the reader walks through what is waiting: a row the list
  // now shows as read is done, and next skips it (kernel/src/email-walk.ts).
  useEffect(() => {
    if (mode !== 'traditional') return;
    const shown = withoutRemoved(threads, (t) => t.id, { removing, removedAt }, threadsFetchedAt.current);
    useEmailThreadNav.getState().setNav(
      shown.map((t) => t.id),
      more,
      loadMore,
      actionFilter === 'unread' ? 'unread' : 'list',
      shown.filter((t) => !t.isUnread).map((t) => t.id),
      // The rows too, for the reader's list pane on a wide screen (ADR 0320):
      // the same list, with nothing refetched to draw it again.
      shown,
    );
  }, [mode, threads, more, loadMore, removing, removedAt, actionFilter]);
  // Back on the AI view (from a finished category walk, or after leaving
  // Traditional), no earlier order may leak into the next email opened here.
  useFocusEffect(
    useCallback(() => {
      if (mode !== 'traditional') useEmailThreadNav.getState().clearNav();
    }, [mode]),
  );

  /**
   * One triage action over a set of threads. Optimistic on archive, with the
   * refetch as the correction: a row the provider refused comes back rather
   * than silently vanishing.
   */
  const triage = useCallback(
    async (
      ids: string[],
      patch: {
        markRead?: boolean;
        archive?: boolean;
        trash?: true;
        addChordLabels?: string[];
        removeChordLabels?: string[];
      },
    ) => {
      if (ids.length === 0) return;
      setTriageMsg(null);
      const removes = !!(patch.archive || patch.trash);
      if (removes) {
        // Hidden until the server has answered AND the list has been re-read:
        // a refetch already in flight (or one per SSE event) would otherwise
        // put the rows back - the "it refreshes everything, then deletes" flicker.
        useEmailThreadNav.getState().startRemoving(ids);
        refreshSeq.current += 1;
        setThreads((prev) => prev.filter((t) => !ids.includes(t.id)));
      }
      setSelected(new Set());
      setLabelFor(null);
      setLabelDraft('');
      let failed: string[] = [];
      try {
        const out = await modifyEmailThreads({ ids, ...patch });
        failed = out.failed;
        // A batch that half-worked says so (ADR 0128); silence would read as
        // success for threads that never changed.
        if (out.failed.length > 0) {
          setTriageMsg(
            out.failed.length === ids.length
              ? 'Nothing changed - your mailbox refused it.'
              : `${out.updated.length} done, ${out.failed.length} could not be changed.`,
          );
        }
      } catch (e) {
        setTriageMsg((e as Error).message);
        failed = ids;
      } finally {
        // Released before the re-read, so a row the provider refused comes
        // back rather than silently vanishing.
        if (removes) useEmailThreadNav.getState().doneRemoving(ids, failed);
        await refreshThreads();
      }
    },
    [refreshThreads],
  );

  // A Trash/Archive from the reader leaves before the mailbox answers; if it
  // refused, say so here, where the row has just reappeared.
  const removeError = useEmailThreadNav((s) => s.removeError);
  useEffect(() => {
    if (!removeError) return;
    setTriageMsg(removeError);
    useEmailThreadNav.getState().setRemoveError(null);
  }, [removeError]);

  const snooze = useCallback(
    async (ids: string[], hours: number) => {
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      // Optimistic like archive (ADR 0128): the refetch is the correction.
      useEmailThreadNav.getState().startRemoving(ids);
      refreshSeq.current += 1;
      setThreads((prev) => prev.filter((t) => !ids.includes(t.id)));
      setSelected(new Set());
      setSnoozeFor(null);
      let failed: string[] = [];
      try {
        await Promise.all(ids.map((id) => snoozeEmailThread(id, until)));
      } catch (e) {
        setTriageMsg((e as Error).message);
        failed = ids;
      } finally {
        useEmailThreadNav.getState().doneRemoving(ids, failed);
        await refreshThreads();
      }
    },
    [refreshThreads],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The newest request wins, so a slow answer cannot replace a fresher list.
  const decisionsGuard = useRef(createLatestGuard());
  const refreshDecisions = useCallback(async () => {
    const current = decisionsGuard.current.begin();
    try {
      const [payload, deferred] = await Promise.all([listEmailDecisions(), loadNotNow()]);
      if (!current()) return;
      setDecisionsPayload(payload);
      setNotNow(deferred);
    } catch {
      /* keep prior */
    }
  }, []);
  // One sync tick sends `email.synced` plus an `email.tiles.updated` per
  // touched thread; refetching on each re-read the list all night for a web
  // tab left open (1,582 requests on 2026-10-23 for 91 opens). Background
  // events go through here; a user's own action still refetches at once.
  const decisionsSoon = useCoalesced(() => void refreshDecisions());

  const load = useCallback(
    async (forceSync: boolean) => {
      setErr(null);
      try {
        // Paint the mirror BEFORE the sync, and don't wait on the status call
        // to do it: the server copy is fresher than the AsyncStorage cache and
        // is one local read away, while a full mailbox sync takes seconds.
        const [s] = await Promise.all([
          getEmailStatus(),
          refreshThreads(),
          refreshDecisions(),
        ]);
        setStatus(s);
        setLoading(false);
        if (!hasAnyMailbox(s)) return;
        // Fill the phone's store from what the server already has; after a
        // sync below it runs again, forced, for whatever the sync brought.
        scheduleDeviceMailPass();
        if (!forceSync && Date.now() - lastSyncAt < FOCUS_SYNC_MIN_GAP_MS) return;
        lastSyncAt = Date.now();
        try {
          await syncEmail();
        } catch (e) {
          if (e instanceof GmailReconnectError) {
            setStatus({ ...s, connected: false });
            return;
          }
        }
        await Promise.all([refreshThreads(), refreshDecisions()]);
        scheduleDeviceMailPass({ force: true });
      } catch (e) {
        setErr(loadErrorText(e));
      } finally {
        setLoading(false);
      }
    },
    [refreshThreads, refreshDecisions],
  );
  const loadAndSync = useCallback(() => load(true), [load]);

  // Pull-to-refresh runs the full `load` - status, an actual mailbox sync, then
  // the local mirror - so the gesture fetches new mail rather than just
  // re-reading what we already had.
  const { refreshControl } = useScreenRefresh(loadAndSync);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void load(false);
      getSettingsCached()
        .then((s) => setSwipeAction(s.emailSwipeAction ?? 'archive'))
        .catch(() => {});
      let handle: StreamHandle | null = null;
      let cancelled = false;
      void openUserStream({
        onEmailSynced: () => {
          scheduleRefresh();
          decisionsSoon.trigger();
          scheduleDeviceMailPass();
        },
        // One event per thread a bulk action touched: patch that row rather
        // than re-reading the whole list for each of them.
        onEmailThreadUpdated: (e) => {
          void applyThreadUpdate(e);
          const { folder } = filtersRef.current;
          if (folder !== 'inbox') {
            scheduleRefresh();
            return;
          }
          const gone = e.isArchived || e.labelIds.includes('TRASH');
          setThreads((prev) => {
            if (!prev.some((t) => t.id === e.threadId)) return prev;
            if (gone) return prev.filter((t) => t.id !== e.threadId);
            return prev.map((t) =>
              t.id === e.threadId ? { ...t, isUnread: e.isUnread, labelIds: e.labelIds } : t,
            );
          });
        },
        onEmailTilesUpdated: () => decisionsSoon.trigger(),
      })
        .then((h) => {
          if (cancelled) h.close();
          else handle = h;
        })
        // The screen works without live updates; a failed open must not be an
        // unhandled rejection.
        .catch((e) => console.warn('[email] live updates unavailable', e));
      return () => {
        focusedRef.current = false;
        cancelled = true;
        handle?.close();
        // Nothing heard while focused is fetched after leaving; the next
        // focus re-reads both lists anyway.
        decisionsSoon.cancel();
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      };
    }, [load, scheduleRefresh, decisionsSoon]),
  );

  const decisions = decisionsPayload?.decisions ?? null;
  const coverage = decisionsPayload?.coverage ?? {
    handledToday: 0,
    unreadable: 0,
    stillOwed: 0,
    handledThreadIds: [],
    owedThreadIds: [],
  };
  const stripItems = useMemo(
    () => urgentDecisions(decisions ?? [], notNow),
    [decisions, notNow],
  );

  /** Confirm removed it server-side - drop locally, then refresh coverage. */
  const onStripConfirmed = useCallback(
    (proposalId: string) => {
      setDecisionsPayload((prev) =>
        prev
          ? {
              ...prev,
              decisions: prev.decisions.filter((d) => d.proposalId !== proposalId),
            }
          : prev,
      );
      void refreshDecisions();
    },
    [refreshDecisions],
  );

  /** Not now is local-only - keep the decision on tiles/Unsorted, just hide the strip card. */
  // The chip and the filter are both pointless with one mailbox.
  const mailboxes = mailboxFilterIds(status).map((id) => {
    if (id === 'primary') return { id, label: primaryMailboxDisplayName(status?.gmailNickname) };
    const a = status!.accounts!.find((x) => x.id === id)!;
    return { id, label: mailboxLabel(a.emailAddress, a.nickname) };
  });
  const multiMailbox = mailboxes.length > 1;

  /**
   * A thread row carries only its `accountId`, so the nickname has to be
   * resolved here — the account list is what holds it. A null id is the
   * primary Gmail (ADR 0080).
   */
  const mailboxNameFor = useCallback(
    (accountId: string | null | undefined): string => {
      if (!accountId) return primaryMailboxDisplayName(status?.gmailNickname);
      const a = status?.accounts?.find((x) => x.id === accountId);
      return a ? mailboxDisplayName(a.nickname, a.emailAddress) : '';
    },
    [status],
  );

  const visibleThreads = useMemo(
    () =>
      removing.size > 0 || removedAt.size > 0
        ? withoutRemoved(threads, (t) => t.id, { removing, removedAt }, threadsFetchedAt.current)
        : threads,
    [threads, removing, removedAt],
  );
  // A removal confirmed after the list was last asked for: that answer may
  // still carry the email (or lack the next page's first row), so read it
  // once more. Nothing else does after a Trash from the reader.
  useEffect(() => {
    if (!focusedRef.current || mode !== 'traditional') return;
    if (fetchPredatesRemoval({ removing, removedAt }, lastAskedAt.current)) scheduleRefresh();
  }, [removing, removedAt, mode, scheduleRefresh]);
  const traditionalData = coverageView
    ? coverageThreads.filter((t) => !removing.has(t.id))
    : showUnclassifiedOnly
      ? visibleThreads.filter((t) => !t.categoryId)
      : visibleThreads;

  // Stable row callbacks, so a memoised row re-renders only when its own data
  // or the selection changes.
  const archiveOne = useCallback((id: string) => void triage([id], { archive: true }), [triage]);
  const trashOne = useCallback((id: string) => void triage([id], { trash: true }), [triage]);
  const toggleReadOne = useCallback(
    (id: string, markRead: boolean) => void triage([id], { markRead }),
    [triage],
  );
  const selecting = selected.size > 0;
  /**
   * ADR 0320 — on a wide window the list keeps its place on the left and the
   * email opens in a reading pane on the right, so the rest of the mail stays
   * in view. Narrow (every phone) still pushes the reader's own screen.
   */
  const { width: windowWidth } = useWindowDimensions();
  const readingPane = splitFits(windowWidth) && mode === 'traditional';
  const [readingId, setReadingId] = useState<string | null>(null);
  const openInPane = useCallback((id: string) => setReadingId(id), []);
  const closePane = useCallback(() => setReadingId(null), []);
  // A thread put away (or filtered out) is no longer there to read.
  useEffect(() => {
    if (readingId && removing.has(readingId)) setReadingId(null);
  }, [readingId, removing]);

  const renderThreadRow = useCallback(
    ({ item }: { item: EmailThreadSummary }) => (
      <ThreadRow
        item={item}
        showAccount={multiMailbox}
        accountName={mailboxNameFor(item.accountId)}
        accountColor={status?.mailboxColors?.[item.accountId ?? 'primary']}
        selecting={selecting}
        selected={selected.has(item.id) || item.id === readingId}
        onToggleSelect={toggleSelect}
        onOpen={readingPane ? openInPane : undefined}
        swipeAction={swipeAction}
        onArchive={archiveOne}
        onTrash={trashOne}
        onToggleRead={toggleReadOne}
      />
    ),
    [
      multiMailbox,
      mailboxNameFor,
      status?.mailboxColors,
      selecting,
      selected,
      toggleSelect,
      readingPane,
      openInPane,
      readingId,
      swipeAction,
      archiveOne,
      trashOne,
      toggleReadOne,
    ],
  );
  const listRef = useRef<FlatList<(typeof traditionalData)[number]>>(null);
  useScrollTopOnReselect('email', listRef);

  const coverageSeq = useRef(0);
  /** Open one of the coverage counts as a list. */
  const openCoverage = useCallback(
    async (which: 'handled' | 'owed', ids: string[]) => {
      setShowUnclassifiedOnly(false);
      setActionFilter(null);
      setCoverageView(which);
      setCoverageThreads([]);
      pickMode('traditional');
      const seq = ++coverageSeq.current;
      if (ids.length === 0) return;
      try {
        const list = await listEmailThreads({ ids });
        if (seq === coverageSeq.current) setCoverageThreads(list);
      } catch {
        // Leave the list empty rather than falling back to the full mailbox,
        // which would silently answer a different question than the one asked.
        if (seq === coverageSeq.current) setCoverageThreads([]);
      }
    },
    [pickMode],
  );

  const clearCoverage = useCallback(() => {
    setCoverageView(null);
    setCoverageThreads([]);
  }, []);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Email', headerBackVisible: false }} />

      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.segment}>
            {(['ai', 'traditional'] as ViewMode[]).map((m) => {
              const active = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => pickMode(m)}
                  style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                >
                  <Text style={[styles.segmentTxt, active && styles.segmentTxtActive]}>
                    {m === 'ai' ? 'AI' : 'Traditional'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      <SplitFrame
        enabled={readingPane}
        // Too narrow to split (every phone): the list IS the screen, exactly
        // as it was, and an email opens its own.
        narrow="left"
        left={(width) => (
          <View style={[styles.body, width !== null && { width }]}>
        {status && !hasAnyMailbox(status) ? (
          <ConnectCta />
        ) : loading && threads.length === 0 && !decisionsPayload ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : mode === 'ai' ? (
          <View style={styles.aiCol}>
            <AiKeyBanner issue={status?.aiKeyIssue} />
            <EmailUrgentStrip
              decisions={stripItems}
              onResolved={onStripConfirmed}
            />
            <View style={styles.styleRow}>
              {AI_VIEW_STYLES.map((s) => {
                const active = aiViewStyle === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => pickAiViewStyle(s)}
                    style={[styles.styleChip, active && styles.styleChipActive]}
                  >
                    <Text style={[styles.styleChipTxt, active && styles.styleChipTxtActive]}>
                      {AI_VIEW_STYLE_LABELS[s]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.map}>
              {aiViewStyle === 'cards' ? (
                <EmailCards decisions={decisions} onDecisionsChanged={() => void refreshDecisions()} />
              ) : aiViewStyle === 'map' ? (
                <EmailTiles decisions={decisions} onDecisionsChanged={() => void refreshDecisions()} />
              ) : (
                <EmailFeed
                  decisions={decisions}
                  onDecisionsChanged={() => void refreshDecisions()}
                />
              )}
            </View>
            {/* ADR 0134 — each count is its own target. One Pressable over the
                whole line meant two of the three counts went nowhere, and the
                third opened the unclassified list whichever one you tapped. */}
            <View style={styles.foot}>
              <Pressable
                onPress={() => void openCoverage('handled', coverage.handledThreadIds)}
                hitSlop={6}
                disabled={coverage.handledToday === 0}
              >
                <Text style={[styles.footTxt, coverage.handledToday > 0 && styles.footLink]}>
                  {coverage.handledToday} handled today
                </Text>
              </Pressable>
              {coverage.unreadable > 0 ? (
                <Pressable
                  onPress={() => {
                    clearCoverage();
                    setActionFilter(null);
                    setShowUnclassifiedOnly(true);
                    pickMode('traditional');
                  }}
                  hitSlop={6}
                >
                  <Text style={[styles.footTxt, styles.footLink]}>
                    {` · ${coverage.unreadable} I couldn't read`}
                  </Text>
                </Pressable>
              ) : null}
              {/* The badge drops when a suggestion times out; saying so is
                  what keeps the tile from going quiet on something still
                  owed (bug 9). */}
              {coverage.stillOwed > 0 ? (
                <Pressable
                  onPress={() => void openCoverage('owed', coverage.owedThreadIds)}
                  hitSlop={6}
                >
                  <Text style={[styles.footTxt, styles.footLink]}>
                    {` · ${coverage.stillOwed} expired, still owed`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : (
          <>
            {/* Folders (ADR 0083/0108) were built behind a long-press on the
                Email tab with no visible hint that it does anything — this
                pill is the discoverable entry point to that same sheet, and
                it also names the current folder so "why is my inbox empty"
                has an obvious answer when it's really "Archive · tap for
                Inbox" below it that got missed. */}
            <View style={styles.folderRow}>
              <Pressable style={styles.folderPill} onPress={() => setFolderOpen(true)}>
                <Text style={styles.folderPillTxt}>{FOLDER_LABELS[folder]}</Text>
                <Text style={styles.folderPillChevron}>▾</Text>
              </Pressable>
            </View>
            {multiMailbox ? (
              <ChipRow>
                <Pressable
                  onPress={() => setAccount(undefined)}
                  style={[styles.filterChip, !account && styles.filterChipActive]}
                >
                  <Text
                    style={[styles.filterChipTxt, !account && styles.filterChipTxtActive]}
                  >
                    All mail
                  </Text>
                </Pressable>
                {mailboxes.map((m) => {
                  const active = account === m.id;
                  const c = status?.mailboxColors?.[m.id];
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => setAccount(m.id)}
                      style={[
                        styles.filterChip,
                        styles.colorChip,
                        c ? { borderColor: c } : null,
                        active && (c ? { backgroundColor: c, borderColor: c } : styles.filterChipActive),
                      ]}
                    >
                      {c ? (
                        <View style={[styles.chipDot, { backgroundColor: active ? '#FFFFFF' : c }]} />
                      ) : null}
                      <Text
                        style={[
                          styles.filterChipTxt,
                          c ? { color: c } : null,
                          active && (c ? styles.filterChipTxtOnColor : styles.filterChipTxtActive),
                        ]}
                      >
                        {m.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ChipRow>
            ) : null}
            {folder === 'inbox' ? (
              <ChipRow>
                {ACTION_FILTERS.map((f) => {
                  const active = actionFilter === f.key;
                  // ADR 0278 — each action keeps its own color, the same as its row badge.
                  const c = f.key && f.key !== 'unread' ? ACTION_COLOR[f.key] : null;
                  return (
                    <Pressable
                      key={f.label}
                      onPress={() => {
                        setShowUnclassifiedOnly(false);
                        setActionFilter(f.key);
                      }}
                      style={[
                        styles.filterChip,
                        c ? { borderColor: c } : null,
                        active && (c ? { backgroundColor: c, borderColor: c } : styles.filterChipActive),
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterChipTxt,
                          c ? { color: c } : null,
                          active && (c ? styles.filterChipTxtOnColor : styles.filterChipTxtActive),
                        ]}
                      >
                        {f.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ChipRow>
            ) : null}
            <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
              ref={listRef}
              data={traditionalData}
              keyExtractor={(t) => t.id}
              refreshControl={refreshControl}
              renderItem={renderThreadRow}
              extraData={selected}
              ItemSeparatorComponent={RowSeparator}
              onEndReachedThreshold={0.6}
              onEndReached={() => void loadMore()}
              ListFooterComponent={
                loadingMore ? (
                  <View style={styles.moreRow}>
                    <ActivityIndicator color={colors.accent} />
                  </View>
                ) : null
              }
              ListHeaderComponent={
                <>
                {/* Same card as AI mode (ADR 0083) - what needs a decision doesn't
                    stop needing one because you're reading chronologically.
                    It scrolls with the list, so a long pile of pending
                    suggestions never hides the mail itself. */}
                <EmailUrgentStrip
                  decisions={stripItems}
                  onResolved={onStripConfirmed}
                  capped={false}
                />
                {coverageView ? (
                  <Pressable style={styles.filterBanner} onPress={clearCoverage}>
                    <Text style={styles.filterBannerTxt}>
                      {coverageView === 'handled'
                        ? 'What you handled today · tap to clear'
                        : 'Expired, still owed · tap to clear'}
                    </Text>
                  </Pressable>
                ) : label ? (
                  <Pressable style={styles.filterBanner} onPress={() => setLabel(null)}>
                    <Text style={styles.filterBannerTxt}>
                      {label.name}
                      {' \u00b7 tap to clear'}
                    </Text>
                  </Pressable>
                ) : folder !== 'inbox' ? (
                  <Pressable style={styles.filterBanner} onPress={() => setFolder('inbox')}>
                    <Text style={styles.filterBannerTxt}>
                      {FOLDER_LABELS[folder]}
                      {' · tap for Inbox'}
                    </Text>
                  </Pressable>
                ) : showUnclassifiedOnly ? (
                  <Pressable
                    style={styles.filterBanner}
                    onPress={() => setShowUnclassifiedOnly(false)}
                  >
                    <Text style={styles.filterBannerTxt}>Showing unclassified · tap to clear</Text>
                  </Pressable>
                ) : null}
                </>
              }
              ListEmptyComponent={
                <View style={styles.center}>
                  <Text style={styles.muted}>
                    {err ??
                      (coverageView === 'handled'
                        ? 'Nothing handled yet today.'
                        : coverageView === 'owed'
                          ? 'Nothing expired and unanswered.'
                          : label
                            ? `Nothing under ${label.name}.`
                            : showUnclassifiedOnly || actionFilter
                              ? 'Nothing in this filter.'
                              : folder !== 'inbox'
                                ? `Nothing in ${FOLDER_LABELS[folder]}.`
                                : 'No mail yet.')}
                  </Text>
                </View>
              }
              contentContainerStyle={traditionalData.length === 0 ? styles.emptyList : undefined}
            />
          </>
        )}
        {/* Floats over the list, above the Settings tab, where a thumb is.
            Gone while selecting: the selection bar owns that corner then. */}
        {hasAnyMailbox(status) && selected.size === 0 ? (
          <Pressable
            style={styles.composeFab}
            onPress={() =>
              // A new message leaves from the mailbox being looked at (ADR 0341).
              router.push(
                mode === 'traditional' && account
                  ? { pathname: '/email/compose', params: { mailbox: account } }
                  : '/email/compose',
              )
            }
            hitSlop={8}
            accessibilityLabel="Write a new message"
          >
            <Icon name="square-edit-outline" size={24} />
          </Pressable>
        ) : null}
        {selected.size > 0 && !snoozeFor && !labelFor ? (
          <SelectionBar
            count={selected.size}
            onArchive={() => void triage([...selected], { archive: true })}
            onTrash={() => {
              const ids = [...selected];
              // One email is recoverable from Trash in a tap of the mail app;
              // a batch is worth a second look before it goes.
              if (ids.length === 1) {
                void triage(ids, { trash: true });
                return;
              }
              confirmDestructive(
                `Move ${ids.length} emails to Trash?`,
                'Your mail app can still restore them from its Trash.',
                () => void triage(ids, { trash: true }),
                { confirmLabel: 'Move to Trash' },
              );
            }}
            onMore={() => setSelMoreOpen(true)}
            onCancel={() => setSelected(new Set())}
          />
        ) : null}
          </View>
        )}
      >
        {readingId ? (
          <EmailThreadReader
            // Keyed on the email: the reader loads it, marks it read and runs
            // its read-time pass on mount, exactly as opening its own screen.
            key={readingId}
            threadId={readingId}
            embedded
            onSelect={openInPane}
            onClose={closePane}
          />
        ) : (
          <ReadingPanePlaceholder />
        )}
      </SplitFrame>

      <ActionSheet
        open={selMoreOpen}
        onClose={() => setSelMoreOpen(false)}
        rows={[
          {
            key: 'read',
            icon: 'email-open-outline',
            label: 'Mark read',
            // The set can hold both read and unread rows, so the verb has to
            // pick one meaning: mark them all read, which is what a pile of
            // triaged mail wants.
            onPress: () => void triage([...selected], { markRead: true }),
          },
          {
            key: 'snooze',
            icon: 'clock-outline',
            label: 'Snooze',
            onPress: () => setSnoozeFor([...selected]),
          },
          {
            key: 'label',
            icon: 'label-outline',
            label: 'Label',
            onPress: () => {
              setLabelFor([...selected]);
              setLabelDraft('');
            },
          },
        ]}
      />
      {labelFor ? (
        <View style={styles.selBar}>
          <TextInput
            style={styles.selInput}
            value={labelDraft}
            onChangeText={setLabelDraft}
            placeholder="Chord label"
            placeholderTextColor={colors.muted}
            autoFocus
            onSubmitEditing={() => {
              const name = labelDraft.trim();
              if (!name || !labelFor) return;
              void triage(labelFor, { addChordLabels: [name] });
            }}
            returnKeyType="done"
          />
          <Pressable
            onPress={() => {
              const name = labelDraft.trim();
              if (!name || !labelFor) return;
              void triage(labelFor, { addChordLabels: [name] });
            }}
            hitSlop={6}
          >
            <Text style={styles.selBtn}>Apply</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setLabelFor(null);
              setLabelDraft('');
            }}
            hitSlop={6}
          >
            <Text style={styles.selCancel}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {snoozeFor ? (
        <View style={styles.selBar}>
          <Text style={styles.selCount}>Snooze until</Text>
          {SNOOZE_CHOICES.map((c) => (
            <Pressable key={c.label} onPress={() => void snooze(snoozeFor, c.hours)} hitSlop={6}>
              <Text style={styles.selBtn}>{c.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setSnoozeFor(null)} hitSlop={6}>
            <Text style={styles.selCancel}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {folder === 'snoozed' ? (
        <Text style={styles.triageMsg}>
          Snoozed in Chord only — your mail app still shows these.
        </Text>
      ) : null}
      {triageMsg ? <Text style={styles.triageMsg}>{triageMsg}</Text> : null}

      <MainBottomNav current="email" onEmailLongPress={() => setFolderOpen(true)} />
      <EmailFolderSheet
        open={folderOpen}
        onAction={(a) => {
          setFolderOpen(false);
          if (a === 'junk') {
            router.push('/email/junk');
            return;
          }
          if (a === 'lists') {
            router.push('/email/lists');
            return;
          }
          if (a === 'filters') {
            router.push('/email/filters');
            return;
          }
          if (a === 'outbox') {
            router.push('/email/outbox');
            return;
          }
          if (a === 'drafts') {
            router.push('/email/drafts');
            return;
          }
          if (a === 'close') return;
          if (typeof a === 'object') {
            // Browsing a label reads across folders server-side, so the folder
            // goes back to its default rather than narrowing the label.
            setLabel({ id: a.label.id, name: a.label.name });
            setFolder('inbox');
            setActionFilter(null);
            setShowUnclassifiedOnly(false);
            pickMode('traditional');
            return;
          }
          setLabel(null);
          // A folder is a Traditional-view idea; the action axis is about mail
          // that wants something from you, which is meaningless once you leave
          // the inbox, so picking a folder clears it.
          setFolder(a);
          if (a !== 'inbox') setActionFilter(null);
          setShowUnclassifiedOnly(false);
          pickMode('traditional');
        }}
      />
    </View>
  );
}

function ConnectCta() {
  return (
    <View style={styles.cta}>
      <Text style={styles.ctaTitle}>Read your email in Chord</Text>
      <Text style={styles.ctaBody}>
        Connect Gmail to read and reply here, and let Chord surface events, lists, and insights
        from your inbox.
      </Text>
      <Pressable
        style={styles.ctaBtn}
        // ?reconnect=gmail (ADR 0042 deep link): Settings scrolls to the Gmail
        // card and starts the connect flow - no hunting from the page top.
        onPress={() => router.push({ pathname: '/settings', params: { reconnect: 'gmail' } })}
      >
        <Text style={styles.ctaBtnTxt}>Connect Gmail</Text>
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  aiCol: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyList: { flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 14 },

  header: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // See-through so the row under it stays readable.
  composeFab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: byScheme('rgba(91,79,207,0.35)', 'rgba(165,160,240,0.4)'),
    backgroundColor: byScheme('rgba(237,233,250,0.7)', 'rgba(46,40,92,0.8)'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
  },
  segmentBtn: { flex: 1, paddingVertical: 6, borderRadius: 999, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: colors.accent },
  segmentTxt: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  segmentTxtActive: { color: colors.onAccent },
  styleRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 11, paddingTop: 8 },
  styleChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  styleChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  styleChipTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  styleChipTxtActive: { color: colors.accent },

  foot: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  footTxt: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  /** A count you can open reads as one; a zero count stays plain. */
  footLink: { color: colors.accent, textDecorationLine: 'underline' },
  filterBanner: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.accentLight,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterBannerTxt: { color: colors.accent, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  // Opaque, so a swiped row slides over its action panel instead of showing
  // through it.
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: colors.bg,
  },
  // ADR 0128 - bulk triage.
  rowSelected: { backgroundColor: colors.accentLight },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkHidden: { borderColor: 'transparent' },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkTxt: { color: colors.onAccent, fontSize: 12, fontWeight: '700' },
  swipeContainer: { backgroundColor: colors.bg },
  selBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  selCount: { flex: 1, color: colors.text, fontWeight: '600' },
  selBtn: { color: colors.accent, fontWeight: '600' },
  selInput: {
    flex: 1,
    minWidth: 120,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 14,
    backgroundColor: colors.bg,
  },
  selCancel: { color: colors.muted },
  triageMsg: { color: colors.muted, fontSize: 13, paddingHorizontal: 14, paddingBottom: 6 },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 60 },
  acct: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  acctDot: { width: 7, height: 7, borderRadius: 4 },
  moreRow: { paddingVertical: 16, alignItems: 'center' },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  from: { color: colors.text, fontSize: 14, fontWeight: '500', flex: 1 },
  subject: { color: colors.text, fontSize: 14, marginTop: 1 },
  subjectRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  fileChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 180,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  fileChipTxt: { color: colors.text, fontSize: 12, flexShrink: 1 },
  fileMore: { color: colors.muted, fontSize: 12 },
  fileErr: { color: colors.red, fontSize: 12, marginTop: 4 },
  filterScroll: { flexGrow: 0, flexShrink: 0 },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  filterChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  filterChipTxt: { fontSize: 12, fontWeight: '600', color: colors.muted },
  filterChipTxtActive: { color: colors.accent },
  filterChipTxtOnColor: { color: '#FFFFFF' },
  colorChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  folderRow: { paddingHorizontal: 12, paddingTop: 8 },
  folderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  folderPillTxt: { fontSize: 13, fontWeight: '700', color: colors.text },
  folderPillChevron: { fontSize: 11, color: colors.muted },
  snippet: { color: colors.muted, fontSize: 13, marginTop: 1 },
  draftTag: { color: colors.red, fontWeight: '700' },
  unread: { fontWeight: '700' },
  time: { color: colors.muted, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, alignSelf: 'center' },
  dotOff: { backgroundColor: 'transparent' },

  cta: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  ctaTitle: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  ctaBody: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  ctaBtn: {
    marginTop: 8,
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  ctaBtnTxt: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
}));
