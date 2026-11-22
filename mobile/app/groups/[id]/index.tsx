import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHeaderHeight } from '@react-navigation/elements';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Contacts from 'expo-contacts';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import type {
  Attachment,
  BotCard,
  BotSaveOffer,
  BotSourcesEvent,
  BotToolEvent,
  EmailAction,
  Group,
  Message,
  Proposal,
} from '@chord/kernel';
import {
  DELETE_MESSAGES_MAX_IDS,
  QUEUED_CHAT_ID_PREFIX,
  chatColumnNeedsFixedWidth,
  describeRecipients,
  emptyMarkReadState,
  markReadFailed,
  markReadStarted,
  markReadSucceeded,
  opensInFileViewer,
  runExclusive,
  shouldMarkRead,
  type MarkReadState,
} from '@chord/kernel';

import {
  attachmentImageSource,
  blockUser,
  confirmProposal,
  createSave,
  deleteMessages,
  fetchAttachmentBlobUrl,
  openAttachmentFileOnWeb,
  getGroup,
  inviteUrl,
  listGroupFiles,
  listGroupMembers,
  listBlockedUsers,
  listMessages,
  listProposalsForGroup,
  markGroupRead,
  openAttachmentNative,
  openGroupStream,
  postMessage,
  readSavedCopy,
  rejectProposal,
  reportMessage,
  updateGroup,
  uploadFile,
  withSavedCopy,
  type StreamHandle,
} from '@/api';
import { fileOpenErrorMessage, showAlert } from '@/alert';
import { confirmDestructive } from '@/confirm';
import { useAndroidBottomInset } from '@/system-bars';
import { KeyboardScreen, useKeyboardShown, DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';
import { ensureContactsAccess } from '@/contacts-access';
import { MainBottomNav } from '@/group-nav';
import { ActionBadge } from '@/email-action-badge';
import { ActionSheet } from '@/email-reader-bar';
import { shareInviteLink } from '@/join-code';
import { groupTitle } from '@/names';
import { editReplyDraft, replyDraftOf } from '@/reply-draft';
import { isStreamingPlaceholder, useApp } from '@/store';
import { MemoryCard } from '@/memory-card';
import { loadErrorText } from '@/network';
import { sendChatText, useQueuedChat } from '@/chat-outbox';
import { QueuedMessage, queuedAsMessage } from '@/queued-message';
import { avatarFor, byScheme, colors, themed } from '@/theme';

const EMPTY_MESSAGES: Message[] = [];
const COMPOSER_MIN_H = 40;
const COMPOSER_MAX_H = 120;

// Action cards may carry a native-app deep link (`appUrl`, e.g.
// `findmy://`) alongside the canonical web URL. Try the native scheme
// first so iOS routes to the app instead of an in-app browser; fall
// back to the web URL when the scheme isn't installed or `canOpenURL`
// is denied. On web, `canOpenURL` returns false for unknown schemes and we
// degrade cleanly. Android 11+ answers `canOpenURL` false for any app the
// manifest does not declare (Messages for `sms:` included), so there the link
// is tried directly; Android rejects it when nothing can open it.
async function openCardLink(appUrl: string | undefined, webUrl: string): Promise<void> {
  if (appUrl && Platform.OS === 'android') {
    try {
      await Linking.openURL(appUrl);
      return;
    } catch {
      // no app takes this scheme; the web URL below
    }
  } else if (appUrl) {
    try {
      if (await Linking.canOpenURL(appUrl)) {
        await Linking.openURL(appUrl);
        return;
      }
    } catch {
      // canOpenURL can throw on web; fall through to webUrl.
    }
  }
  Linking.openURL(webUrl).catch(() => {});
}

// ADR 0059 - open a `search`-result file card's actual attachment. Native
// downloads with auth and hands the file to the OS viewer (Quick Look /
// share sheet - PDFs, docs); web fetches an authed blob and opens it in a
// new tab (images render inline). Mirrors AttachmentCard.openFile minus the
// in-app image lightbox (no per-card component state here).
async function openAttachmentCard(
  id: string,
  filename: string,
  mimeType: string | undefined,
): Promise<void> {
  if (Platform.OS !== 'web') {
    try {
      await openAttachmentNative({ id, filename, mimeType });
    } catch (err) {
      showAlert('Couldn’t open file', fileOpenErrorMessage(filename, err as Error));
    }
    return;
  }
  if (typeof window === 'undefined') return;
  if (opensInFileViewer(mimeType, filename, 'web')) {
    try {
      await openAttachmentFileOnWeb(id, filename, mimeType);
    } catch (err) {
      showAlert('Couldn’t open file', fileOpenErrorMessage(filename, err as Error));
    }
    return;
  }
  const win = window.open('', '_blank');
  try {
    const blobUrl = await fetchAttachmentBlobUrl(id);
    if (win) win.location.href = blobUrl;
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (err) {
    win?.close();
    showAlert('Couldn’t open file', fileOpenErrorMessage(filename, err as Error));
  }
}

function dayChangeLabel(currentIso: string, prevIso: string | undefined): string | null {
  const cur = new Date(currentIso);
  if (Number.isNaN(cur.getTime())) return null;
  if (prevIso) {
    const prev = new Date(prevIso);
    if (
      !Number.isNaN(prev.getTime()) &&
      prev.getFullYear() === cur.getFullYear() &&
      prev.getMonth() === cur.getMonth() &&
      prev.getDate() === cur.getDate()
    ) {
      return null;
    }
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfCur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()).getTime();
  const daysDelta = Math.round((startOfToday - startOfCur) / 86_400_000);
  if (daysDelta === 0) return 'Today';
  if (daysDelta === 1) return 'Yesterday';
  const sameYear = cur.getFullYear() === now.getFullYear();
  return cur.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// react-native-web draws an inverted list by flipping it with scaleY(-1), so
// the DOM runs newest-first while the screen reads oldest-first. A browser
// text selection follows DOM order: dragging down across two bubbles
// highlights the wrong halves and copies them in reverse. On web the list is
// therefore rendered chronologically and pinned to the bottom by hand; native
// keeps the inverted list, where offset 0 is always the newest message.
const INVERTED_LIST = Platform.OS !== 'web';

// ADR 0301 — what a report says was wrong; the choice is sent as the reason.
const REPORT_REASONS = ['Harassment or bullying', 'Hate or violence', 'Sexual content', 'Spam or scam', 'Something else'];

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const headerHeight = useHeaderHeight();
  const keyboardShown = useKeyboardShown();
  const user = useApp((s) => s.user);
  const groups = useApp((s) => s.groups);
  const upsertGroup = useApp((s) => s.upsertGroup);
  const removeGroupLocal = useApp((s) => s.removeGroupLocal);
  const renameGroupLocal = useApp((s) => s.renameGroupLocal);
  const msgs = useApp((s) => (id ? s.messagesByGroup[id] : undefined)) ?? EMPTY_MESSAGES;
  const setMessages = useApp((s) => s.setMessages);
  const upsertMessage = useApp((s) => s.upsertMessage);
  const appendBotDelta = useApp((s) => s.appendBotDelta);
  const removeMessages = useApp((s) => s.removeMessages);
  const clearMessagesLocal = useApp((s) => s.clearMessagesLocal);
  const dropMissingFromLatest = useApp((s) => s.dropMissingFromLatest);
  const markGroupReadLocal = useApp((s) => s.markGroupReadLocal);

  const group = groups.find((g) => g.id === id);
  const [body, setBody] = useState('');
  // Select-to-delete mode. `allSelected` means the whole chat, including
  // history this screen never loaded, so it is sent as `all` rather than ids.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [allSelected, setAllSelected] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setAllSelected(false);
    setSelectedIds(new Set());
  }, []);
  // Any message can be chosen: in the personal chat it is really deleted, in
  // a shared chat it only leaves this person's view (ADR 0242).
  const isPersonalChat = group?.kind === 'personal';
  const canDelete = useCallback((m: Message) => !isStreamingPlaceholder(m), []);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // Save-offers are inline cards attached to the message that contained
  // the URL. Map keyed by triggering messageId. After 30s with no
  // explicit dismiss the offer auto-saves and clears.
  const [saveOffersByMessage, setSaveOffersByMessage] = useState<
    Record<string, BotSaveOffer>
  >({});
  const saveOffersRef = useRef(saveOffersByMessage);
  const saveOfferTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [cardsByMessage, setCardsByMessage] = useState<Record<string, BotCard[]>>({});
  const [toolsByMessage, setToolsByMessage] = useState<Record<string, BotToolEvent[]>>({});
  // ADR 0022: directive turns are silent - no bot bubble - and surface as
  // a tiny receipt strip under the user's trigger message. The map is
  // keyed by triggerMessageId; the value points to the bot's (invisible)
  // messageId so cards/tools (still keyed on botMessageId) can attach.
  // status lifecycle: 'received' (bot.start) → 'done' (bot.receipt ok)
  // OR 'failed' (bot.receipt error). Q&A turns clear the entry on
  // bot.done so the bubble takes over.
  const [receiptByTriggerMsg, setReceiptByTriggerMsg] = useState<
    Record<
      string,
      {
        botMessageId: string;
        toolNames: string[];
        status: 'received' | 'done' | 'failed';
      }
    >
  >({});
  const [sourcesByMessage, setSourcesByMessage] = useState<
    Record<string, BotSourcesEvent['sources']>
  >({});
  const [pendingProposals, setPendingProposals] = useState<Record<string, Proposal[]>>({});
  const [busyProposalIds, setBusyProposalIds] = useState<Set<string>>(() => new Set());
  const [attachmentsById, setAttachmentsById] = useState<Record<string, Attachment>>({});
  const [ingest, setIngest] = useState<
    | { kind: 'extracting'; window: number; totalWindows: number; entitiesSoFar: number }
    | { kind: 'done'; entitiesExtracted: number; error?: string }
    | null
  >(null);
  const [membersById, setMembersById] = useState<Record<string, { displayName: string; shadow: boolean }>>({});
  const [composerH, setComposerH] = useState(COMPOSER_MIN_H);
  const listRef = useRef<FlatList<Message>>(null);
  const streamRef = useRef<StreamHandle | null>(null);
  const membersByIdRef = useRef(membersById);
  const membersRefreshRef = useRef<Promise<void> | null>(null);
  // Coalesces the /files refetch when several attachments arrive together (e.g.
  // a multi-photo share) so we do one list fetch + merge, not one per message.
  // `queued` catches a file that lands mid-fetch so the burst always converges.
  const filesInFlightRef = useRef(false);
  const filesQueuedRef = useRef(false);

  // Where the "Unread" divider goes and where we anchor the initial scroll.
  // Frozen once when the chat loads (see the load effect): we read the cursor
  // from the group at load time - not at first render, when a cold open has
  // the group missing from the store, its cursor reading as null, and the
  // whole history looking unread. Freezing the result also stops a live
  // message that lands while you're reading from spawning a fresh divider.
  // Null = nothing unread → open at the bottom, no divider.
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);

  // ADR 0298: people this user blocked. The server already leaves their
  // messages out of history; this also drops the ones arriving live over SSE.
  const [blockedIds, setBlockedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    listBlockedUsers()
      .then((rows) => {
        if (!cancelled) setBlockedIds(new Set(rows.map((r) => r.userId)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  const [personSheet, setPersonSheet] = useState<
    { userId: string; name: string; text: string; messageId: string } | null
  >(null);
  const [reportSheet, setReportSheet] = useState<
    { userId: string; name: string; messageId: string } | null
  >(null);
  const onPersonMenu = useCallback((userId: string, name: string, text: string, messageId: string) => {
    setPersonSheet({ userId, name, text, messageId });
  }, []);
  const confirmBlock = useCallback((userId: string, name: string) => {
    confirmDestructive(
      `Block ${name}?`,
      `You will no longer see ${name}'s messages in any chat or get notifications for them, ` +
        `and neither of you can start a direct chat with the other. ${name} is not told. ` +
        'You can unblock them in Settings → Blocked people.',
      () => {
        blockUser(userId)
          .then(() => setBlockedIds((prev) => new Set(prev).add(userId)))
          .catch((e) => showAlert('Could not block', (e as Error).message));
      },
      { confirmLabel: 'Block' },
    );
  }, []);
  const sendReport = useCallback(
    (target: { userId: string; name: string; messageId: string }, reason: string) => {
      reportMessage(target.messageId, reason)
        .then((r) => {
          const title = r.alreadyReported ? 'Already reported' : 'Reported';
          const body = r.alreadyReported
            ? "You reported this message before; Chord's team has it."
            : `Thanks. Chord's team will review it. ${target.name} is not told.`;
          if (blockedIds.has(target.userId)) {
            showAlert(title, body);
            return;
          }
          confirmDestructive(
            title,
            `${body}\n\nBlock ${target.name} too?`,
            () => confirmBlock(target.userId, target.name),
            { confirmLabel: 'Block', cancelLabel: 'Not now' },
          );
        })
        .catch((e) => showAlert('Could not report', (e as Error).message));
    },
    [blockedIds, confirmBlock],
  );

  // Inverted FlatList renders newest-first: index 0 sits at the visual
  // bottom. The store keeps messages chronological, so reverse for display
  // (native only - see INVERTED_LIST).
  // ADR 0311 addendum - messages written offline show after the real ones,
  // in the order they will be sent, until the server has them.
  const queued = useQueuedChat(id);
  const listData = useMemo(() => {
    const real =
      blockedIds.size === 0 ? msgs : msgs.filter((m) => !m.senderId || !blockedIds.has(m.senderId));
    const shown = queued.length === 0 ? real : [...real, ...queued.map(queuedAsMessage)];
    return INVERTED_LIST ? shown.slice().reverse() : shown;
  }, [msgs, blockedIds, queued]);

  const msgsRef = useRef(msgs);
  const firstUnreadIdRef = useRef<string | null>(firstUnreadId);
  const didInitialScrollRef = useRef(false);
  // Whether the list is parked at the bottom. Default true (normal chat
  // behavior - stick to newest); flipped false once we anchor on an unread
  // divider so growing content (image loads, late SSE messages) doesn't
  // yank the reader to the end. onScroll keeps it current thereafter.
  const pinnedToBottomRef = useRef(true);
  // The message id we've already advanced the read cursor through, so we
  // fire markGroupRead once per new "latest message" rather than on every
  // scroll tick. A failed call is retried after a back-off (chat-mark-read.ts).
  const markReadRef = useRef<MarkReadState>(emptyMarkReadState());
  // Latest scroll geometry, updated from onScroll / onLayout. On an inverted
  // list offsetY is the distance scrolled up from the newest message, and it
  // stays at 0 at the bottom regardless of content growth above.
  // contentH is only read on web, where the bottom is contentH - layoutH.
  const scrollMetricsRef = useRef({ offsetY: 0, layoutH: 0, contentH: 0 });
  // Web only: set just before older history is merged in, so the content
  // growth above the viewport can be added back to the scroll offset and the
  // reader stays on the message they were looking at.
  const olderAnchorRef = useRef<{ contentH: number; offsetY: number } | null>(null);
  // Gates mark-read until the initial positioning has settled, so opening an
  // unread chat doesn't clear unread before the reader reaches the bottom.
  const initialReadyRef = useRef(false);
  // Cursor pagination for scroll-up history. The store starts with the last
  // 50; scrolling toward the top pages older messages from the server via the
  // `before` cursor. Refs gate concurrent fetches and stop once exhausted.
  const loadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    msgsRef.current = msgs;
  }, [msgs]);
  useEffect(() => {
    firstUnreadIdRef.current = firstUnreadId;
  }, [firstUnreadId]);

  const scrollToLatest = useCallback((animated: boolean) => {
    if (INVERTED_LIST) listRef.current?.scrollToOffset({ offset: 0, animated });
    // Not scrollToEnd: on web it offsets from the last cell's measured frame,
    // which is still 0 when the content first grows, and lands at the top.
    // The browser clamps an oversized offset to the real bottom.
    else listRef.current?.scrollToOffset({ offset: 1e9, animated });
  }, []);

  const scrollToFirstUnread = useCallback(() => {
    const ci = msgsRef.current.findIndex((m) => m.id === firstUnreadIdRef.current);
    if (ci < 0) return; // not in the loaded window → list already rests at newest
    // Pin the divider to the top of the viewport so the unread run reads
    // downward to the bottom. On the inverted (newest-first) list the index
    // is mirrored and viewPosition 1 is the visual top.
    if (INVERTED_LIST) {
      const invIdx = msgsRef.current.length - 1 - ci;
      listRef.current?.scrollToIndex({ index: invIdx, viewPosition: 1, animated: false });
    } else {
      listRef.current?.scrollToIndex({ index: ci, viewPosition: 0, animated: false });
    }
  }, []);

  // Pull the group's files once and merge into the attachment map. Coalesced:
  // concurrent triggers collapse into one fetch, and anything that lands while a
  // fetch is in flight queues a single follow-up so the burst always converges.
  const refreshFiles = useCallback(() => {
    if (filesInFlightRef.current) {
      filesQueuedRef.current = true;
      return;
    }
    const run = () => {
      filesInFlightRef.current = true;
      void listGroupFiles(id)
        .then((files) =>
          setAttachmentsById((p) => ({
            ...p,
            ...Object.fromEntries(files.map((f) => [f.id, f])),
          })),
        )
        .catch(() => {})
        .finally(() => {
          filesInFlightRef.current = false;
          if (filesQueuedRef.current) {
            filesQueuedRef.current = false;
            run();
          }
        });
    };
    run();
  }, [id]);

  // Seed cards + quiet-mode receipts from a freshly-fetched batch (initial
  // load, reconnect backfill, or scroll-up history) - merges, never replaces.
  const mergeAuxFromMessages = useCallback((ms: Message[]) => {
    const cardsSeed: Record<string, BotCard[]> = {};
    const receiptSeed: Record<
      string,
      { botMessageId: string; toolNames: string[]; status: 'received' | 'done' | 'failed' }
    > = {};
    for (const m of ms) {
      if (m.kind === 'bot' && m.cards && m.cards.length > 0) cardsSeed[m.id] = m.cards;
      if (m.receipt) {
        receiptSeed[m.id] = {
          botMessageId: m.receipt.botMessageId,
          toolNames: m.receipt.toolNames,
          status: m.receipt.status === 'ok' ? 'done' : 'failed',
        };
        if (m.receipt.cards.length > 0) cardsSeed[m.receipt.botMessageId] = m.receipt.cards;
      }
    }
    if (Object.keys(cardsSeed).length > 0) {
      setCardsByMessage((prev) => ({ ...prev, ...cardsSeed }));
    }
    if (Object.keys(receiptSeed).length > 0) {
      setReceiptByTriggerMsg((prev) => ({ ...prev, ...receiptSeed }));
    }
  }, []);

  // Page older history when the reader scrolls toward the top (onEndReached on
  // an inverted list). Uses the oldest loaded message's timestamp as the
  // `before` cursor; `setMessages` merges by id so overlap is harmless.
  const loadOlder = useCallback(async () => {
    if (!id || loadingOlderRef.current || !hasMoreOlderRef.current) return;
    const oldest = msgsRef.current.find((m) => !isStreamingPlaceholder(m))?.createdAt;
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await listMessages(id, { before: oldest, limit: 50 });
      if (older.length > 0) {
        if (!INVERTED_LIST) {
          const { contentH, offsetY } = scrollMetricsRef.current;
          olderAnchorRef.current = { contentH, offsetY };
        }
        setMessages(id, older);
        mergeAuxFromMessages(older);
      }
      if (older.length < 50) hasMoreOlderRef.current = false;
    } catch {
      // Leave hasMoreOlder true - a later scroll retries.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [id, setMessages, mergeAuxFromMessages]);

  // Mark the whole chat read once the user is parked at the bottom - i.e.
  // they've actually seen everything. Fires on reaching the bottom and
  // again whenever a newer message lands while still there, so messages
  // received mid-session don't linger as unread after leaving. Reaching the
  // bottom, not merely opening the chat, is what clears unread.
  const markReadIfCaughtUp = useCallback(() => {
    if (!id || !pinnedToBottomRef.current) return;
    let latest: Message | undefined;
    for (let i = msgsRef.current.length - 1; i >= 0; i--) {
      if (!isStreamingPlaceholder(msgsRef.current[i])) {
        latest = msgsRef.current[i];
        break;
      }
    }
    if (!latest || !shouldMarkRead(markReadRef.current, latest.id, Date.now())) return;
    const latestId = latest.id;
    markReadRef.current = markReadStarted(markReadRef.current, latestId);
    void markGroupRead(id)
      .then((r) => {
        markReadRef.current = markReadSucceeded(markReadRef.current, latestId);
        if (r?.lastReadAt) markGroupReadLocal(id, r.lastReadAt);
      })
      .catch(() => {
        // Not asked again on every scroll event: after a back-off, or at once
        // for a newer message.
        markReadRef.current = markReadFailed(markReadRef.current, latestId, Date.now());
      });
  }, [id, markGroupReadLocal]);

  const recomputeAtBottom = useCallback(() => {
    if (!initialReadyRef.current) return;
    const { offsetY, layoutH, contentH } = scrollMetricsRef.current;
    if (layoutH === 0) return;
    // Inverted list: within 80px of offset 0 means parked on the newest
    // message. offset 0 is fixed regardless of content growth above it, so
    // this can't be knocked loose by image loads or late messages. On web the
    // list runs top-down, so measure the distance from the end instead.
    pinnedToBottomRef.current = INVERTED_LIST
      ? offsetY < 80
      : contentH - layoutH - offsetY < 80;
    if (pinnedToBottomRef.current) markReadIfCaughtUp();
  }, [markReadIfCaughtUp]);

  // Position the list once messages first load. An inverted list already
  // rests on the newest message (offset 0) with no scroll, so the all-read
  // case needs nothing - we only actively scroll to reveal an unread divider.
  useEffect(() => {
    if (didInitialScrollRef.current || msgs.length === 0) return;
    didInitialScrollRef.current = true;
    if (firstUnreadIdRef.current) {
      pinnedToBottomRef.current = false;
      requestAnimationFrame(() => scrollToFirstUnread());
      // Let the programmatic scroll apply before mark-read arms, so we don't
      // clear unread from the transient offset-0 starting position.
      setTimeout(() => {
        initialReadyRef.current = true;
      }, 250);
    } else {
      pinnedToBottomRef.current = true;
      initialReadyRef.current = true;
      markReadIfCaughtUp();
    }
  }, [msgs, scrollToFirstUnread, markReadIfCaughtUp]);

  useEffect(() => {
    membersByIdRef.current = membersById;
  }, [membersById]);

  useEffect(() => {
    saveOffersRef.current = saveOffersByMessage;
  }, [saveOffersByMessage]);

  // A newer message arrived (live or on load). If the reader is at the
  // bottom, advance the read cursor through it. Guarded until the initial
  // scroll has positioned the list, so opening an unread chat doesn't mark
  // it read before we've anchored on the divider.
  useEffect(() => {
    if (!initialReadyRef.current) return;
    markReadIfCaughtUp();
  }, [msgs, markReadIfCaughtUp]);

  // Clear any pending save-offer timers on unmount so we don't fire
  // saves after the user navigates away from the group.
  useEffect(() => {
    return () => {
      for (const timer of Object.values(saveOfferTimers.current)) {
        clearTimeout(timer);
      }
      saveOfferTimers.current = {};
    };
  }, []);

  const commitSaveOffer = useCallback(
    async (messageId: string, source: 'tap' | 'auto') => {
      const timer = saveOfferTimers.current[messageId];
      if (timer) {
        clearTimeout(timer);
        delete saveOfferTimers.current[messageId];
      }
      const offer = saveOffersRef.current[messageId];
      if (!offer || !id) return;
      // Optimistically clear the offer first so the user sees instant
      // feedback (no double-click, no flicker).
      setSaveOffersByMessage((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      try {
        await createSave(id, {
          kind: 'link',
          title: offer.title,
          url: offer.url,
          tags: [],
        });
      } catch (e) {
        if (source === 'tap') setErr((e as Error).message);
      }
    },
    [id],
  );

  const dismissSaveOffer = useCallback((messageId: string) => {
    const timer = saveOfferTimers.current[messageId];
    if (timer) {
      clearTimeout(timer);
      delete saveOfferTimers.current[messageId];
    }
    setSaveOffersByMessage((prev) => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
  }, []);

  const handleSaveOfferArrival = useCallback(
    (offer: BotSaveOffer) => {
      setSaveOffersByMessage((prev) => ({ ...prev, [offer.messageId]: offer }));
      // Don't double-arm if a timer already exists (re-broadcast safety).
      if (saveOfferTimers.current[offer.messageId]) return;
      saveOfferTimers.current[offer.messageId] = setTimeout(() => {
        void commitSaveOffer(offer.messageId, 'auto');
      }, 30_000);
    },
    [commitSaveOffer],
  );

  const onResolveProposal = useCallback(
    async (proposalId: string, action: 'confirm' | 'reject') => {
      setBusyProposalIds((prev) => {
        const n = new Set(prev);
        n.add(proposalId);
        return n;
      });
      try {
        if (action === 'confirm') await confirmProposal(proposalId);
        else await rejectProposal(proposalId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyProposalIds((prev) => {
          const n = new Set(prev);
          n.delete(proposalId);
          return n;
        });
      }
    },
    [],
  );

  const onAcceptSaveOffer = useCallback(
    (messageId: string) => {
      void commitSaveOffer(messageId, 'tap');
    },
    [commitSaveOffer],
  );

  const refreshMembers = useCallback(async () => {
    if (!id || membersRefreshRef.current) return;
    membersRefreshRef.current = listGroupMembers(id)
      .then((members) => {
        setMembersById(
          Object.fromEntries(
            members.map((m) => [
              m.userId,
              {
                displayName: m.displayName ?? m.username ?? m.userId,
                shadow: m.shadow === true,
              },
            ]),
          ),
        );
      })
      .finally(() => {
        membersRefreshRef.current = null;
      });
    await membersRefreshRef.current;
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // Nothing in memory for this chat (a launch): paint the newest messages
    // this phone saved while the server is asked. The answer below replaces
    // them (dropMissingFromLatest + setMessages); a saved copy that arrives
    // after anything is already showing is not used.
    if ((useApp.getState().messagesByGroup[id] ?? []).length === 0) {
      void readSavedCopy<Message[]>(`messages-${id}`).then((saved) => {
        if (cancelled || !saved || saved.length === 0) return;
        if ((useApp.getState().messagesByGroup[id] ?? []).length > 0) return;
        setMessages(id, saved);
      });
    }
    (async () => {
      try {
        const existing = useApp.getState().groups.find((g) => g.id === id);
        const grp = existing ?? (await getGroup(id));
        if (!existing) upsertGroup(grp);
        const [messages, files, members, proposals] = await Promise.all([
          withSavedCopy(`messages-${id}`, () => listMessages(id, { limit: 50 })),
          listGroupFiles(id).catch(() => [] as Attachment[]),
          listGroupMembers(id).catch(() => []),
          listProposalsForGroup(id).catch(() => [] as Proposal[]),
        ]);
        if (cancelled) return;
        dropMissingFromLatest(id, messages);
        setMessages(id, messages);
        // A short initial page means we're already at the start of history.
        hasMoreOlderRef.current = messages.length >= 50;
        loadingOlderRef.current = false;
        // Freeze the unread boundary from the freshest cursor we have. Null
        // cursor (never read) → everything counts as unread, matching the
        // server's badge. A recent cursor with no newer message → null →
        // no divider, open at the bottom.
        const cursor = grp.lastReadAt ?? null;
        setFirstUnreadId(
          messages.find(
            (m) =>
              !isStreamingPlaceholder(m) &&
              m.senderId !== user?.id &&
              (cursor === null || m.createdAt > cursor),
          )?.id ?? null,
        );
        // Reconstruct quiet-mode receipts (ADR 0022) from persisted bot
        // replies the server attached as `m.receipt` on each trigger msg.
        const receiptSeed: Record<
          string,
          { botMessageId: string; toolNames: string[]; status: 'received' | 'done' | 'failed' }
        > = {};
        const cardsSeed: Record<string, BotCard[]> = {};
        for (const m of messages) {
          if (m.receipt) {
            receiptSeed[m.id] = {
              botMessageId: m.receipt.botMessageId,
              toolNames: m.receipt.toolNames,
              status: m.receipt.status === 'ok' ? 'done' : 'failed',
            };
            if (m.receipt.cards.length > 0) {
              cardsSeed[m.receipt.botMessageId] = m.receipt.cards;
            }
          }
          if (m.kind === 'bot' && m.cards && m.cards.length > 0) {
            cardsSeed[m.id] = m.cards;
          }
        }
        setReceiptByTriggerMsg(receiptSeed);
        setCardsByMessage((prev) => ({ ...prev, ...cardsSeed }));
        setAttachmentsById(Object.fromEntries(files.map((f) => [f.id, f])));
        setMembersById(
          Object.fromEntries(
            members.map((m) => [
              m.userId,
              {
                displayName: m.displayName ?? m.username ?? m.userId,
                shadow: m.shadow === true,
              },
            ]),
          ),
        );
        const byTrigger: Record<string, Proposal[]> = {};
        for (const p of proposals) {
          if (p.status !== 'pending' || !p.proposedByMessageId) continue;
          (byTrigger[p.proposedByMessageId] ??= []).push(p);
        }
        setPendingProposals(byTrigger);
      } catch (e) {
        if (!cancelled) setErr(loadErrorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, setMessages, upsertGroup]);

  const subscribeToGroupStream = useCallback(() => {
    if (!id) return;
    let handle: StreamHandle | null = null;
    let cancelled = false;
    (async () => {
      try {
        const h = await openGroupStream(id, {
          onOpen: () => {
            setConnected(true);
            // The SSE hub has no replay (ADR 0002): events broadcast while we
            // were disconnected - including Telegram-origin turns - are dropped,
            // so the live view silently misses them until remount. Backfill on
            // every (re)connect; `setMessages` merges by id, so this is a safe
            // no-op when nothing was missed.
            void listMessages(id, { limit: 50 })
              .then((ms) => {
                // Anything deleted while this device was not listening.
                dropMissingFromLatest(id, ms);
                setMessages(id, ms);
                mergeAuxFromMessages(ms);
              })
              .catch(() => {});
          },
          onMessage: (m) => {
            upsertMessage(id, m);
            if (m.senderId && !membersByIdRef.current[m.senderId]) {
              void refreshMembers().catch(() => {});
            }
            if (m.attachmentId) {
              setAttachmentsById((prev) => {
                if (!prev[m.attachmentId!]) refreshFiles();
                return prev;
              });
            }
            // My own send always re-pins to the bottom; otherwise only
            // follow new messages when already parked there, so a reader
            // sitting on the unread divider stays put.
            if (m.senderId === user?.id) pinnedToBottomRef.current = true;
            if (pinnedToBottomRef.current) {
              requestAnimationFrame(() =>
                scrollToLatest(true),
              );
            }
          },
          onMessagesDeleted: (e) => {
            removeMessages(id, e.ids);
            const gone = new Set(e.ids);
            setSelectedIds((prev) => {
              if (![...prev].some((x) => gone.has(x))) return prev;
              return new Set([...prev].filter((x) => !gone.has(x)));
            });
          },
          // ADR 0022 (quiet mode): server no longer streams tokens. The
          // listener stays registered so older servers that still emit
          // bot.token don't blow up; we ignore the deltas.
          onBotToken: () => {},
          // bot.start: render an "👀 received" strip immediately so the
          // user sees Chord acknowledged the message before the LLM
          // finishes thinking.
          onBotStart: (e) => {
            setReceiptByTriggerMsg((prev) => ({
              ...prev,
              [e.triggerMessageId]: {
                botMessageId: e.messageId,
                toolNames: [],
                status: 'received',
              },
            }));
            if (pinnedToBottomRef.current) {
              requestAnimationFrame(() =>
                scrollToLatest(true),
              );
            }
          },
          onBotReceipt: (e) => {
            setReceiptByTriggerMsg((prev) => ({
              ...prev,
              [e.triggerMessageId]: {
                botMessageId: e.messageId,
                toolNames: e.toolNames,
                status: e.status === 'ok' ? 'done' : 'failed',
              },
            }));
            if (pinnedToBottomRef.current) {
              requestAnimationFrame(() =>
                scrollToLatest(true),
              );
            }
          },
          // Q&A turn - server emits a `message` for the bot reply (and
          // `bot.done`). Clear the receipt strip so the bubble below
          // it owns the visual real estate; otherwise we'd see both a
          // "👀 Chord" strip AND the bubble for the same turn.
          onBotDone: (botMessageId) => {
            setReceiptByTriggerMsg((prev) => {
              const next = { ...prev };
              for (const [trig, val] of Object.entries(prev)) {
                if (val.botMessageId === botMessageId && val.status === 'received') {
                  delete next[trig];
                }
              }
              return next;
            });
          },
          onBotSaveOffer: (o) => handleSaveOfferArrival(o),
          onBotCard: (p) =>
            setCardsByMessage((prev) => ({ ...prev, [p.messageId]: p.cards })),
          onBotTool: (e) =>
            setToolsByMessage((prev) => ({
              ...prev,
              [e.messageId]: [...(prev[e.messageId] ?? []), e],
            })),
          onBotSources: (e) =>
            setSourcesByMessage((prev) => ({ ...prev, [e.messageId]: e.sources })),
          onProposalCreated: (p) => {
            if (!p.proposedByMessageId) return;
            setPendingProposals((prev) => {
              const key = p.proposedByMessageId!;
              const existing = prev[key] ?? [];
              return {
                ...prev,
                [key]: [...existing.filter((x) => x.id !== p.id), p],
              };
            });
          },
          onProposalResolved: (e) => {
            setPendingProposals((prev) => {
              const next: Record<string, Proposal[]> = {};
              for (const [k, list] of Object.entries(prev)) {
                const filtered = list.filter((p) => p.id !== e.id);
                if (filtered.length > 0) next[k] = filtered;
              }
              return next;
            });
          },
          onIngestProgress: (e) =>
            setIngest({
              kind: 'extracting',
              window: e.window,
              totalWindows: e.totalWindows,
              entitiesSoFar: e.entitiesSoFar,
            }),
          onIngestDone: (e) => {
            setIngest({
              kind: 'done',
              entitiesExtracted: e.entitiesExtracted,
              error: e.error,
            });
            setTimeout(() => setIngest(null), 4000);
          },
          onGroupRenamed: (e) => renameGroupLocal(e.groupId, e.name),
          // Read on another device → clear this device's unread badge for
          // the group. Only our own reads advance the cursor.
          onGroupRead: (e) => {
            if (user?.id && e.userId === user.id) {
              markGroupReadLocal(e.groupId, e.lastReadAt);
            }
          },
          onError: () => setConnected(false),
          onEnd: (reason) => {
            setConnected(false);
            // Another member deleted the group out from under us - drop it and
            // bounce back to the list instead of trying to reconnect.
            if (reason === 'group_deleted') {
              removeGroupLocal(id);
              router.replace('/groups');
            }
          },
        }, user?.id);
        // Blurred/unmounted while the open was in flight - don't leak it.
        if (cancelled) {
          h.close();
          return;
        }
        handle = h;
        streamRef.current = h;
      } catch (e) {
        if (!cancelled) setErr(loadErrorText(e));
      }
    })();
    return () => {
      cancelled = true;
      handle?.close();
      streamRef.current = null;
      setConnected(false);
    };
  }, [id, user?.id, appendBotDelta, refreshMembers, upsertMessage, handleSaveOfferArrival, renameGroupLocal, removeGroupLocal, markGroupReadLocal]);

  // Focus-scoped, not mount-scoped: expo-router's Stack keeps a pushed-away
  // screen mounted, so a mount-scoped stream would hold its socket open from
  // three screens deep. Backgrounding is handled inside `openGroupStream`.
  useFocusEffect(subscribeToGroupStream);

  // A ref, not the busy state: a second tap in the same frame does not see
  // that state yet, and would send the message twice.
  const sendGate = useRef(false);
  const send = useCallback(
    () =>
      runExclusive(sendGate, async () => {
        if (!id || !body.trim()) return;
        setBusy(true);
        setErr(null);
        const txt = body.trim();
        setBody('');
        try {
          await sendChatText(id, txt, Intl.DateTimeFormat().resolvedOptions().timeZone);
        } catch (e) {
          setErr((e as Error).message);
          setBody(txt);
        } finally {
          setBusy(false);
        }
      }),
    [id, body],
  );

  // ADR 0157 — a "pick from Contacts" card handed us an email; drop it into the
  // chat as a plain message so the bot's next turn can call update_event with
  // the address. The original "invite <name>" request is still in its context
  // window (ADR 0035).
  const onContactEmail = useCallback(
    async (name: string, email: string) => {
      if (!id) return;
      try {
        await sendChatText(
          id,
          `${name}'s email is ${email}`,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );

  // ADR 0299 — a tapped answer chip is the user's reply, sent as typed text.
  const onQuickReply = useCallback(
    async (text: string) => {
      if (!id) return;
      try {
        await sendChatText(id, text, Intl.DateTimeFormat().resolvedOptions().timeZone);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );

  type PendingAsset = { uri: string; name: string; mimeType?: string; file?: Blob };
  const [pendingAssets, setPendingAssets] = useState<PendingAsset[]>([]);

  const attach = useCallback(async () => {
    if (!id) return;
    try {
      const r = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (r.canceled || !r.assets?.length) return;
      setPendingAssets(
        r.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          file: asset.file,
        })),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  // Pick screenshots / photos from the device library. DocumentPicker opens the
  // Files app on native, which can't reach the camera roll - images live in
  // Photos, so this uses the system photo picker instead.
  const pickImages = useCallback(async () => {
    if (!id) return;
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (r.canceled || !r.assets?.length) return;
      setPendingAssets(
        r.assets.map((asset, i) => {
          const ext = (asset.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
          return {
            uri: asset.uri,
            name: asset.fileName ?? `image-${i + 1}.${ext}`,
            mimeType: asset.mimeType ?? 'image/jpeg',
            file: asset.file,
          };
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  // Shoot a photo straight into the chat (ADR 0054). Native-only - the attach
  // sheet that surfaces this tile never renders on web. Maps the captured asset
  // to a PendingAsset exactly like pickImages, so it inherits UploadConfirm.
  const fromCamera = useCallback(async () => {
    if (!id) return;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setErr('Camera permission is needed to take a photo.');
        return;
      }
      const r = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      if (r.canceled || !r.assets?.length) return;
      setPendingAssets(
        r.assets.map((asset, i) => {
          const ext = (asset.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
          return {
            uri: asset.uri,
            name: asset.fileName ?? `photo-${i + 1}.${ext}`,
            mimeType: asset.mimeType ?? 'image/jpeg',
            file: asset.file,
          };
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  // Paste an image off the clipboard (ADR 0054). Native-only: there is no
  // paste-into-TextInput event for images, so the attach sheet exposes a tile
  // that reads on tap (iOS shows a "pasted from…" banner on every read, so we
  // never poll hasImageAsync to gate the tile - we check it here, on tap).
  // getImageAsync hands back a base64 data URI; native uploadFile wants a file
  // URI, not a Blob, so materialize the bytes into the cache dir first.
  const pasteImage = useCallback(async () => {
    if (!id) return;
    try {
      if (!(await Clipboard.hasImageAsync())) {
        setErr('No image found on the clipboard.');
        return;
      }
      const img = await Clipboard.getImageAsync({ format: 'png' });
      if (!img?.data) return;
      const base64 = img.data.replace(/^data:[^;]+;base64,/, '');
      const name = `pasted-${Date.now()}.png`;
      const uri = `${FileSystem.cacheDirectory}${name}`;
      await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
      setPendingAssets([{ uri, name, mimeType: 'image/png' }]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  // One attachment button. On native, Files and Photos live in separate system
  // pickers, so offer a choice. On web a single file dialog already lists every
  // file type (documents and image formats), so skip the chooser entirely.
  const [attachSheet, setAttachSheet] = useState(false);
  const pickAttachment = useCallback(() => {
    if (!id) return;
    // Web's single file dialog already lists documents and image formats, so the
    // sheet adds nothing there - open it directly. On native, Files and Photos
    // are separate system pickers, so the bottom sheet offers the choice (and is
    // where Camera / Paste image will live - ADR 0054).
    if (Platform.OS === 'web') {
      void attach();
      return;
    }
    setAttachSheet(true);
  }, [id, attach]);

  const finalizeUpload = useCallback(
    async () => {
      if (!id || pendingAssets.length === 0) return;
      const assets = pendingAssets;
      setPendingAssets([]);
      setBusy(true);
      try {
        for (const asset of assets) {
          const att: Attachment = await uploadFile(id, asset);
          await postMessage(id, {
            body: `📎 ${asset.name}`,
            attachmentId: att.id,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [id, pendingAssets],
  );

  // Web-only: paste an image straight into the chat. There is no paste event for
  // images into a native TextInput (that path is a tap-driven affordance, ADR
  // 0054), so this is gated to web. The pasted File is exactly the web-shaped
  // PendingAsset; routing it through setPendingAssets gives it the UploadConfirm
  // step for free - a stray ⌘V previews instead of silently posting.
  const composerFocused = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onPaste = (e: ClipboardEvent) => {
      if (!composerFocused.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          setPendingAssets([
            { uri: '', name: file.name || `pasted-${Date.now()}.${ext}`, mimeType: it.type, file },
          ]);
          break;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const headerTitle = group ? groupTitle(group, user) : 'Chat';
  const screenOptions = useMemo(
    () => ({
      title: headerTitle,
      headerBackVisible: false,
      // Tap the group name to open the per-group config page (Connectors + Members).
      headerTitle: () => (
        <Pressable
          onPress={() => router.push(`/groups/${id}/settings`)}
          hitSlop={6}
          accessibilityLabel="Open group settings"
        >
          <Text style={styles.headerTitleTxt}>{headerTitle}</Text>
          <Text style={styles.headerTitleHint}>Tap to mirror on external platforms</Text>
        </Pressable>
      ),
      headerLeft: () => (
        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/groups');
          }}
          hitSlop={8}
          style={styles.headerBack}
          accessibilityLabel="Back to chats"
        >
          <Text style={styles.headerBackTxt}>‹ Messages</Text>
        </Pressable>
      ),
      headerRight: () => (
        <View style={styles.headerRight}>
          <View
            style={[
              styles.dot,
              { backgroundColor: connected ? colors.green : colors.muted },
            ]}
          />
          <Pressable
            onPress={() => (selecting ? exitSelecting() : setSelecting(true))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={selecting ? 'Stop selecting messages' : 'Select messages'}
          >
            <Text style={styles.headerSelectTxt}>{selecting ? 'Cancel' : 'Select'}</Text>
          </Pressable>
        </View>
      ),
    }),
    [headerTitle, connected, id, selecting, exitSelecting],
  );

  const toggleSelected = useCallback(
    (messageId: string) => {
      if (allSelected) {
        // Unticking one row turns "the whole chat" into "these loaded rows".
        setAllSelected(false);
        setSelectedIds(
          new Set(msgsRef.current.filter((m) => canDelete(m) && m.id !== messageId).map((m) => m.id)),
        );
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(messageId)) next.delete(messageId);
        else next.add(messageId);
        return next;
      });
    },
    [allSelected, canDelete],
  );

  const deleteSelected = useCallback(() => {
    if (!id || deleting) return;
    const ids = [...selectedIds];
    if (!allSelected && ids.length === 0) return;
    const what = allSelected
      ? 'every message in this chat'
      : ids.length === 1
        ? 'this message'
        : `these ${ids.length} messages`;
    confirmDestructive(
      allSelected ? 'Clear chat?' : ids.length === 1 ? 'Delete message?' : 'Delete messages?',
      (isPersonalChat
        ? `This deletes ${what}. `
        : `This removes ${what} for you only. Everyone else still sees ${ids.length === 1 && !allSelected ? 'it' : 'them'}. `) +
        'It cannot be undone. Files stay in Attachments.',
      () => {
        void (async () => {
          setDeleting(true);
          setErr(null);
          try {
            let skipped = 0;
            if (allSelected) {
              skipped = (await deleteMessages(id, { all: true })).skipped;
              clearMessagesLocal(id);
            } else {
              for (let i = 0; i < ids.length; i += DELETE_MESSAGES_MAX_IDS) {
                const part = ids.slice(i, i + DELETE_MESSAGES_MAX_IDS);
                skipped += (await deleteMessages(id, { ids: part })).skipped;
                removeMessages(id, part);
              }
            }
            exitSelecting();
            if (skipped > 0) {
              setErr(`${skipped} message${skipped === 1 ? ' was' : 's were'} not deleted.`);
            }
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setDeleting(false);
          }
        })();
      },
    );
  }, [id, deleting, selectedIds, allSelected, isPersonalChat, removeMessages, clearMessagesLocal, exitSelecting]);

  const handleComposerKeyPress = useCallback(
    (e: unknown) => {
      if (Platform.OS !== 'web') return;
      const ev = e as {
        nativeEvent?: { key?: string; shiftKey?: boolean };
        preventDefault?: () => void;
      };
      if (ev.nativeEvent?.key === 'Enter' && !ev.nativeEvent?.shiftKey) {
        ev.preventDefault?.();
        void send();
      }
    },
    [send],
  );

  const renderChatItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      if (item.id.startsWith(QUEUED_CHAT_ID_PREFIX)) {
        const q = queued.find((m) => `${QUEUED_CHAT_ID_PREFIX}${m.localId}` === item.id);
        return q ? <QueuedMessage item={q} /> : null;
      }
      // Inverted data is newest-first, so the chronologically previous
      // (older) message sits at the next-higher index.
      const prev = INVERTED_LIST ? listData[index + 1] : listData[index - 1];
      // Answer chips only on the newest message: an older question is settled.
      const isNewest = INVERTED_LIST ? index === 0 : index === listData.length - 1;
      const dayLabel = dayChangeLabel(item.createdAt, prev?.createdAt);
      const receipt = receiptByTriggerMsg[item.id];
      // ADR 0022: when a directive turn fired against this user
      // message, the bot's reply is invisible - surface its cards
      // and tool pills as a receipt strip under the user's bubble
      // instead. Cards/tools are keyed by the (invisible) bot
      // messageId.
      const receiptCards = receipt
        ? cardsByMessage[receipt.botMessageId]
        : undefined;
      const receiptTools = receipt
        ? toolsByMessage[receipt.botMessageId]
        : undefined;
      const proposals =
        pendingProposals[item.id] ??
        (item.replyToId ? pendingProposals[item.replyToId] ?? [] : []);
      const deletable = canDelete(item);
      const checked = deletable && (allSelected || selectedIds.has(item.id));
      const bubble = (
        <Bubble
          msg={item}
          mine={item.senderId === user?.id}
          cards={cardsByMessage[item.id] ?? item.cards}
          tools={toolsByMessage[item.id]}
          sources={sourcesByMessage[item.id]}
          receipt={
            receipt
              ? {
                  status: receipt.status,
                  tools: receiptTools ?? [],
                  cards: receiptCards ?? [],
                }
              : undefined
          }
          proposals={proposals}
          busyProposalIds={busyProposalIds}
          onResolveProposal={onResolveProposal}
          attachment={item.attachmentId ? attachmentsById[item.attachmentId] : undefined}
          sender={item.senderId ? membersById[item.senderId] : undefined}
          saveOffer={saveOffersByMessage[item.id]}
          onAcceptSaveOffer={onAcceptSaveOffer}
          onDismissSaveOffer={dismissSaveOffer}
          onContactEmail={onContactEmail}
          onQuickReply={isNewest ? onQuickReply : undefined}
          onPersonMenu={isPersonalChat ? undefined : onPersonMenu}
        />
      );
      return (
        <>
          {item.id === firstUnreadId && (
            <View style={styles.unreadDivider}>
              <View style={styles.unreadLine} />
              <Text style={styles.unreadLabel}>Unread</Text>
              <View style={styles.unreadLine} />
            </View>
          )}
          {dayLabel && (
            <View style={styles.daySeparator}>
              <Text style={styles.daySeparatorText}>{dayLabel}</Text>
            </View>
          )}
          {selecting ? (
            <Pressable
              style={styles.selectRow}
              onPress={() => toggleSelected(item.id)}
              disabled={!deletable}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: !deletable }}
            >
              <Text style={[styles.selectBox, !deletable && styles.selectBoxOff]}>
                {!deletable ? '–' : checked ? '☑' : '☐'}
              </Text>
              {/* Taps go to the row, not to links or cards inside the bubble. */}
              <View style={styles.selectBubble} pointerEvents="none">
                {bubble}
              </View>
            </Pressable>
          ) : (
            bubble
          )}
        </>
      );
    },
    [
      selecting,
      selectedIds,
      allSelected,
      toggleSelected,
      canDelete,
      listData,
      queued,
      receiptByTriggerMsg,
      cardsByMessage,
      toolsByMessage,
      sourcesByMessage,
      pendingProposals,
      firstUnreadId,
      user?.id,
      busyProposalIds,
      onResolveProposal,
      attachmentsById,
      membersById,
      saveOffersByMessage,
      onAcceptSaveOffer,
      dismissSaveOffer,
      onQuickReply,
      isPersonalChat,
      onPersonMenu,
    ],
  );

  if (!id) return null;

  return (
    <KeyboardScreen style={{ flex: 1, backgroundColor: colors.bg }} headerHeight={headerHeight}>
      <Stack.Screen options={screenOptions} />
      {group?.kind === 'group' && (
        <View style={styles.inviteBanner}>
          <Text style={styles.inviteLabel}>Invite</Text>
          <Pressable
            onPress={() =>
              void shareInviteLink(inviteUrl(group.inviteCode), () => {
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 1500);
              })
            }
            hitSlop={6}
            accessibilityRole="link"
            accessibilityLabel={`Share invite link for code ${group.inviteCode}`}
          >
            <Text style={[styles.inviteCode, styles.inviteCodeLink]}>
              {inviteCopied ? '✓ Link copied' : `${group.inviteCode} · share`}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={async () => {
              try {
                const updated = await updateGroup(group.id, {
                  mirrorInbound: !group.mirrorInbound,
                });
                upsertGroup(updated);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            }}
            hitSlop={6}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: group.mirrorInbound }}
            style={styles.mirrorRow}
          >
            <Text
              style={[
                styles.mirrorBox,
                group.mirrorInbound && styles.mirrorBoxChecked,
              ]}
            >
              {group.mirrorInbound ? '☑' : '☐'}
            </Text>
            <Text style={styles.mirrorLabel}>Mirror bridges</Text>
          </Pressable>
        </View>
      )}
      {ingest && (
        <View style={styles.ingestBanner}>
          {ingest.kind === 'extracting' ? (
            <>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.ingestText}>
                Chord is reading the chat… {ingest.window}/{ingest.totalWindows} - {ingest.entitiesSoFar} found
              </Text>
            </>
          ) : (
            <Text style={styles.ingestText}>
              {ingest.error
                ? `Import failed: ${ingest.error}`
                : `✓ Chord found ${ingest.entitiesExtracted} action${ingest.entitiesExtracted === 1 ? '' : 's'} from your chat.`}
            </Text>
          )}
        </View>
      )}
      <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.list}
        data={listData}
        inverted={INVERTED_LIST}
        keyExtractor={(m) => m.id}
        // Older history sits at the visual top: the list's end when inverted,
        // its start on web.
        onEndReached={INVERTED_LIST ? () => void loadOlder() : undefined}
        onEndReachedThreshold={INVERTED_LIST ? 0.4 : undefined}
        onStartReached={INVERTED_LIST ? undefined : () => void loadOlder()}
        onStartReachedThreshold={INVERTED_LIST ? undefined : 0.4}
        // Web: render every loaded message so each cell is really measured -
        // the manual bottom-pinning and the older-history offset correction
        // both need true heights, not virtualized estimates.
        initialNumToRender={INVERTED_LIST ? undefined : Math.max(listData.length, 10)}
        windowSize={INVERTED_LIST ? undefined : 1000}
        {...(INVERTED_LIST
          ? {
              ListFooterComponent: loadingOlder ? (
                <View style={styles.loadingOlder}>
                  <ActivityIndicator />
                </View>
              ) : null,
            }
          : {
              ListHeaderComponent: loadingOlder ? (
                <View style={styles.loadingOlder}>
                  <ActivityIndicator />
                </View>
              ) : null,
            })}
        onLayout={(e) => {
          scrollMetricsRef.current.layoutH = e.nativeEvent.layout.height;
          recomputeAtBottom();
        }}
        onContentSizeChange={(_w, h) => {
          if (INVERTED_LIST) return;
          const m = scrollMetricsRef.current;
          const anchor = olderAnchorRef.current;
          m.contentH = h;
          olderAnchorRef.current = null;
          if (pinnedToBottomRef.current) {
            // Web has no offset-0 bottom to rest on: follow growth (new
            // messages, images loading, and the first render - which starts
            // at the top) while the reader is parked there.
            m.offsetY = Math.max(0, h - m.layoutH);
            scrollToLatest(false);
          } else if (anchor) {
            // Older history landed above the viewport: shift by what it added
            // so the message being read stays put.
            const offset = anchor.offsetY + (h - anchor.contentH);
            m.offsetY = offset;
            listRef.current?.scrollToOffset({ offset, animated: false });
          }
        }}
        onScroll={(e) => {
          // Inverted: contentOffset.y is the distance scrolled up from the
          // newest message. The bottom is a fixed offset 0 - content growing
          // above it never shifts it, so the reader can't be stranded mid-list.
          scrollMetricsRef.current.offsetY = e.nativeEvent.contentOffset.y;
          scrollMetricsRef.current.layoutH = e.nativeEvent.layoutMeasurement.height;
          scrollMetricsRef.current.contentH = e.nativeEvent.contentSize.height;
          recomputeAtBottom();
        }}
        scrollEventThrottle={16}
        onScrollToIndexFailed={(info) => {
          // Target cell isn't measured yet: jump to an estimate, then retry
          // once it's realized. Worst case we settle at the bottom, which is
          // acceptable - never "the middle of nowhere".
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(() => scrollToFirstUnread(), 120);
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {group?.kind === 'personal'
              ? 'Ask Chord anything - it listens here.'
              : 'No messages yet. Say hi, or @Chord for help.'}
          </Text>
        }
        renderItem={renderChatItem}
      />
      {err && <Text style={styles.err}>{err}</Text>}
      <ActionSheet
        open={personSheet !== null}
        rows={
          personSheet
            ? [
                ...(personSheet.text
                  ? [
                      {
                        key: 'copy',
                        icon: 'content-copy' as const,
                        label: 'Copy message',
                        onPress: () => void Clipboard.setStringAsync(personSheet.text),
                      },
                    ]
                  : []),
                {
                  key: 'report',
                  icon: 'flag-outline' as const,
                  label: 'Report message',
                  hint: "Send it to Chord's team for review",
                  onPress: () =>
                    setReportSheet({
                      userId: personSheet.userId,
                      name: personSheet.name,
                      messageId: personSheet.messageId,
                    }),
                },
                {
                  key: 'block',
                  icon: 'account-cancel' as const,
                  label: `Block ${personSheet.name}`,
                  hint: 'Hide their messages from you everywhere',
                  onPress: () => confirmBlock(personSheet.userId, personSheet.name),
                },
              ]
            : []
        }
        onClose={() => setPersonSheet(null)}
      />
      <ActionSheet
        open={reportSheet !== null}
        rows={
          reportSheet
            ? REPORT_REASONS.map((reason) => ({
                key: reason,
                icon: 'flag-outline' as const,
                label: reason,
                onPress: () => sendReport(reportSheet, reason),
              }))
            : []
        }
        onClose={() => setReportSheet(null)}
      />
      <AttachSheet
        visible={attachSheet}
        onClose={() => setAttachSheet(false)}
        onPhotos={() => void pickImages()}
        onCamera={() => void fromCamera()}
        onPasteImage={() => void pasteImage()}
        onFiles={() => void attach()}
      />
      <UploadConfirm
        visible={pendingAssets.length > 0}
        filename={
          pendingAssets.length === 1
            ? pendingAssets[0].name
            : `${pendingAssets.length} files`
        }
        onCancel={() => setPendingAssets([])}
        onConfirm={() => {
          void finalizeUpload();
        }}
      />
      {selecting && (
        <View style={styles.selectBar}>
          <Pressable
            onPress={() => {
              setAllSelected(!allSelected);
              setSelectedIds(new Set());
            }}
            hitSlop={8}
            disabled={deleting}
            accessibilityRole="button"
          >
            <Text style={styles.selectBarTxt}>{allSelected ? 'Select none' : 'Select all'}</Text>
          </Pressable>
          <Text style={styles.selectBarCount}>
            {allSelected ? 'All messages' : `${selectedIds.size} selected`}
          </Text>
          <Pressable
            onPress={deleteSelected}
            hitSlop={8}
            disabled={deleting || (!allSelected && selectedIds.size === 0)}
            accessibilityRole="button"
            accessibilityLabel="Delete selected messages"
          >
            {deleting ? (
              <ActivityIndicator color={colors.red} size="small" />
            ) : (
              <Text
                style={[
                  styles.selectBarDelete,
                  !allSelected && selectedIds.size === 0 && styles.selectBarDeleteOff,
                ]}
              >
                Delete
              </Text>
            )}
          </Pressable>
        </View>
      )}
      <View style={[styles.inputRow, selecting && styles.hidden]}>
        <Pressable
          style={styles.attachBtn}
          onPress={pickAttachment}
          disabled={busy}
          accessibilityLabel="Add a file or photo"
        >
          <Text style={styles.attachTxt}>+</Text>
        </Pressable>
        <View style={styles.composerWrap}>
          <TextInput
            style={[
              styles.textField,
              { height: Math.min(COMPOSER_MAX_H, Math.max(COMPOSER_MIN_H, composerH)) },
            ]}
            value={body}
            onChangeText={setBody}
            placeholder="Message or @Chord"
            placeholderTextColor={colors.muted}
            onFocus={() => {
              composerFocused.current = true;
            }}
            onBlur={() => {
              composerFocused.current = false;
            }}
            onSubmitEditing={send}
            onKeyPress={handleComposerKeyPress}
            onContentSizeChange={(e) => setComposerH(e.nativeEvent.contentSize.height)}
            multiline
          />
        </View>
        <Pressable
          style={[styles.sendBtn, (!body.trim() || busy) && styles.sendBtnDisabled]}
          onPress={send}
          disabled={!body.trim() || busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.sendIcon} accessibilityLabel="Send">
              ➤
            </Text>
          )}
        </Pressable>
      </View>
      {/* While typing the keyboard is the bottom of the screen; a tab bar
          riding on top of it only steals the messages' space. */}
      {!keyboardShown && <MainBottomNav current="chats" belowRoot />}
    </KeyboardScreen>
  );
}

function AttachSheet({
  visible,
  onClose,
  onPhotos,
  onCamera,
  onPasteImage,
  onFiles,
}: {
  visible: boolean;
  onClose: () => void;
  onPhotos: () => void;
  onCamera: () => void;
  onPasteImage: () => void;
  onFiles: () => void;
}) {
  // WhatsApp-style bottom sheet: one `+` on the row opens this, so new intake
  // types (Camera, Paste image - ADR 0054) are tiles here instead of buttons
  // crowding the composer. The Paste tile always shows and reads the clipboard
  // on tap (no hasImageAsync poll - that would trip iOS's paste banner).
  const tiles: Array<{ icon: string; label: string; run: () => void }> = [
    { icon: '🖼️', label: 'Photos', run: onPhotos },
    { icon: '📷', label: 'Camera', run: onCamera },
    { icon: '📋', label: 'Paste image', run: onPasteImage },
    { icon: '📄', label: 'Files', run: onFiles },
  ];
  const bottomInset = useAndroidBottomInset();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheetPanel, { paddingBottom: 28 + bottomInset }]} onPress={() => {}}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetGrid}>
            {tiles.map((t) => (
              <Pressable
                key={t.label}
                style={styles.sheetTile}
                accessibilityLabel={t.label}
                onPress={() => {
                  onClose();
                  t.run();
                }}
              >
                <Text style={styles.sheetTileIcon}>{t.icon}</Text>
                <Text style={styles.sheetTileLabel}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function UploadConfirm({
  visible,
  filename,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  filename: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.pickerBackdrop} onPress={onCancel}>
        <Pressable style={styles.pickerCard} onPress={() => {}}>
          <Text style={styles.pickerTitle}>Send this file?</Text>
          <Text style={styles.pickerFile} numberOfLines={1}>
            {filename}
          </Text>

          <View style={styles.pickerBtnRow}>
            <Pressable style={[styles.pickerBtn, styles.pickerBtnGhost]} onPress={onCancel}>
              <Text style={styles.pickerBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.pickerBtn} onPress={onConfirm}>
              <Text style={styles.pickerBtnText}>Upload</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function cardIcon(kind: BotCard['kind']): string {
  if (kind === 'task') return '✓';
  if (kind === 'save') return '🔖';
  if (kind === 'trip') return '✈';
  if (kind === 'event') return '📅';
  if (kind === 'action') return '↗';
  if (kind === 'email') return '✉';
  if (kind === 'contact') return '👤';
  if (kind === 'memory') return '🧠';
  return '•';
}

// An email card's `meta` is either an EmailAction (badge-worthy) or, when a
// thread has none, its received date - only the former renders as a badge.
const EMAIL_ACTIONS: readonly EmailAction[] = ['to_do', 'reply_needed', 'informational', 'other'];
function isEmailAction(meta: string): meta is EmailAction {
  return (EMAIL_ACTIONS as readonly string[]).includes(meta);
}

/**
 * ADR 0157 — a `kind: 'contact'` card: the bot needs this person's email to
 * finish inviting them. Open the OS contact picker, pull the first email, and
 * hand it back so the parent can post it into the chat for the next bot turn.
 */
async function pickContactEmail(
  name: string,
  onPicked?: (name: string, email: string) => void,
): Promise<void> {
  try {
    // presentContactPickerAsync is a self-contained OS picker that needs no
    // app-level grant on iOS - only Android requires READ_CONTACTS to use it.
    // Gating on requestPermissionsAsync for every platform dead-ends anyone
    // who hasn't already granted (or has declined) full Contacts access,
    // even though the picker itself never needed it.
    if (Platform.OS === 'android') {
      const allowed = await ensureContactsAccess(
        'Chord opens your contacts so you can pick one. Only the email address of the ' +
          'contact you pick is sent to Chord. Your address book is not uploaded.',
      );
      if (!allowed) {
        const perm = await Contacts.getPermissionsAsync();
        // Declined for good: only the system Settings can turn it back on.
        if (!perm.canAskAgain) {
          Alert.alert(
            'Contacts access needed',
            'Turn on Contacts for Chord in Settings to pick an email address.',
          );
        }
        return;
      }
    }
    const contact = await Contacts.presentContactPickerAsync();
    if (!contact) return; // user cancelled
    const email = contact.emails?.map((e) => e.email).find((e): e is string => !!e);
    if (!email) {
      Alert.alert('No email saved', `${contact.name ?? name} has no email address in Contacts.`);
      return;
    }
    onPicked?.(contact.name || name, email);
  } catch (e) {
    Alert.alert('Could not open Contacts', (e as Error).message);
  }
}

function SourceLink({
  source,
  showDot,
}: {
  source: BotSourcesEvent['sources'][number];
  showDot: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening) return;
    if (Platform.OS !== 'web') {
      setOpening(true);
      try {
        await openAttachmentNative({ id: source.attachmentId, filename: source.filename });
      } catch (err) {
        showAlert('Couldn’t open file', fileOpenErrorMessage(source.filename, err as Error));
      } finally {
        setOpening(false);
      }
      return;
    }
    if (typeof window === 'undefined') return;
    setOpening(true);
    try {
      if (opensInFileViewer(undefined, source.filename, 'web')) {
        await openAttachmentFileOnWeb(source.attachmentId, source.filename);
        return;
      }
      const blobUrl = await fetchAttachmentBlobUrl(source.attachmentId);
      window.open(blobUrl, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      showAlert('Couldn’t open file', fileOpenErrorMessage(source.filename, err as Error));
    } finally {
      setOpening(false);
    }
  };
  const label = source.pinned ? `★ ${source.filename}` : source.filename;
  return (
    <>
      {showDot && <Text style={styles.sourceFooter}> · </Text>}
      <Pressable onPress={open} disabled={opening}>
        <Text style={[styles.sourceFooter, styles.sourceFooterLink]}>
          {opening ? '…' : label}
        </Text>
      </Pressable>
    </>
  );
}

function AttachmentCard({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const isImage = attachment.mimeType.startsWith('image/');
  const [opening, setOpening] = useState(false);
  // Cross-platform Image source. On web this is a `blob:` URL (auth-fetched
  // and revoked on unmount); on iOS/Android it's `{ uri, headers }` so the
  // RN <Image> includes the session header on its own fetch.
  const [imgSource, setImgSource] = useState<
    { uri: string; headers?: Record<string, string> } | null
  >(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let active = true;
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const src = await attachmentImageSource(attachment.id);
        if (!active) {
          src.cleanup?.();
          return;
        }
        cleanup = src.cleanup;
        setImgSource({ uri: src.uri, headers: src.headers });
      } catch {
        // ignore - card degrades to icon-only
      }
    })();
    return () => {
      active = false;
      cleanup?.();
    };
  }, [attachment.id, isImage]);

  const openFile = async () => {
    if (opening) return;
    if (isImage) {
      // For images we always prefer the in-app lightbox over a new tab.
      setLightboxOpen(true);
      return;
    }
    if (Platform.OS !== 'web') {
      // Native has no tab/blob flow: download with auth, hand to the OS viewer.
      setOpening(true);
      try {
        await openAttachmentNative(attachment);
      } catch (err) {
        Alert.alert('Couldn’t open file', `${attachment.filename}: ${(err as Error).message}`);
      } finally {
        setOpening(false);
      }
      return;
    }
    if (typeof window === 'undefined') return;
    if (opensInFileViewer(attachment.mimeType, attachment.filename, 'web')) {
      setOpening(true);
      try {
        await openAttachmentFileOnWeb(attachment.id, attachment.filename, attachment.mimeType);
      } catch (err) {
        window.alert(`Couldn't open ${attachment.filename}: ${(err as Error).message}`);
      } finally {
        setOpening(false);
      }
      return;
    }
    // Open the tab synchronously inside the click gesture so the browser doesn't
    // pop-up-block it, THEN point it at the authed blob once fetched.
    const win = window.open('', '_blank');
    setOpening(true);
    try {
      const blobUrl = await fetchAttachmentBlobUrl(attachment.id);
      if (win) {
        win.location.href = blobUrl;
      } else if (typeof document !== 'undefined') {
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
      window.alert(`Couldn't open ${attachment.filename}: ${(err as Error).message}`);
    } finally {
      setOpening(false);
    }
  };

  const tags = attachment.imageMeta?.tags ?? [];

  return (
    <>
      <Pressable
        onPress={openFile}
        style={[styles.fileCard, mine && styles.fileCardMine]}
      >
        {isImage && imgSource ? (
          <Image source={imgSource} style={styles.imageThumb} resizeMode="cover" />
        ) : (
          <Text style={styles.fileIcon}>{mimeIcon(attachment.mimeType)}</Text>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.fileName} numberOfLines={1}>
            {attachment.filename}
          </Text>
          <Text style={styles.fileMeta} numberOfLines={1}>
            {attachment.mimeType} · {fmtBytes(attachment.size)}
            {attachment.pinned ? ' · pinned' : ''}
          </Text>
          {tags.length > 0 && (
            <Text style={styles.fileTags} numberOfLines={1}>
              {tags.map((t) => `#${t}`).join(' ')}
            </Text>
          )}
          {attachment.summary && (
            <Text style={styles.fileSummary} numberOfLines={2}>
              {attachment.summary}
            </Text>
          )}
        </View>
      </Pressable>

      {isImage && (
        <Modal
          visible={lightboxOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setLightboxOpen(false)}
        >
          <Pressable style={styles.lightboxBackdrop} onPress={() => setLightboxOpen(false)}>
            {imgSource ? (
              <Image source={imgSource} style={styles.lightboxImage} resizeMode="contain" />
            ) : (
              <ActivityIndicator color="#fff" />
            )}
            <View style={styles.lightboxCaption} pointerEvents="none">
              <Text style={styles.lightboxFilename} numberOfLines={1}>
                {attachment.filename}
              </Text>
              {attachment.summary && (
                <Text style={styles.lightboxSummary} numberOfLines={6}>
                  {attachment.summary}
                </Text>
              )}
            </View>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

function mimeIcon(mime: string): string {
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('audio/')) return '🎧';
  if (mime.startsWith('video/')) return '🎞';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
  if (mime.includes('word') || mime.includes('document')) return '📄';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📊';
  if (mime.startsWith('text/')) return '📝';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return '🗜';
  return '📎';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function stripAttachmentPrefix(body: string, filename: string): string {
  const trimmed = body.trim();
  if (trimmed === `📎 ${filename}` || trimmed === filename) return '';
  return body;
}

const TOOL_LABELS: Record<string, string> = {
  create_task: 'created task',
  add_list_item: 'updated list',
  save_link: 'saved link',
  save_place: 'saved place',
  save_media: 'saved media',
  save_contact: 'saved contact',
  create_event: 'created event',
  record_rsvp: 'recorded RSVP',
  create_trip: 'created trip',
  add_travel_leg: 'added travel leg',
  add_accommodation: 'added stay',
  get_trip_status: 'checked trip',
};

/**
 * `TOOL_LABELS` is phrased as a past-tense success claim ("created event") —
 * right for a call that actually ran, self-contradicting for one the pill's
 * own `summary` says refused ("created event · cannot repeat that way …").
 * A declined/errored call gets the plain tool name instead, which reads
 * neutrally next to whatever the summary says went wrong.
 */
function toolLabel(name: string, status: 'ok' | 'error' | 'declined' = 'ok'): string {
  if (status !== 'ok') return name.replace(/_/g, ' ');
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

/**
 * `summary` is written for the LLM to read back and paraphrase (the ADR
 * 0005 tool loop), so it freely mixes real facts with asides meant only
 * for the model — "(describe the repeat using exactly these words)",
 * "(state THIS calendar, not whatever the user said)". In receipt mode
 * (ADR 0022) there's no bot bubble to do that paraphrasing — this pill is
 * the only thing shown — so for a successful call it stays hidden: the
 * label plus any card already say enough. A declined or errored call has
 * no card and no bubble either, so its summary is the only diagnostic text
 * the user will ever see, and stays visible.
 */
/**
 * A call that failed inside Chord (a refused input, a server error) is not
 * shown: the model is told and tries again, and the line was internal text
 * ("invalid args for ...") the user cannot act on. A `declined` call stays -
 * that is a real answer ("that date has passed").
 */
function shownTools<T extends { status?: BotToolEvent['status'] }>(tools: T[]): T[] {
  return tools.filter((t) => t.status !== 'error');
}

function toolSummaryText(t: BotToolEvent): string {
  if (!t.summary) return '';
  if ((t.status ?? 'ok') === 'ok') return '';
  return ` · ${t.summary}`;
}

function proposalSummary(p: Proposal): string {
  try {
    const a = JSON.parse(p.argsJson) as Record<string, unknown>;
    const s = (k: string): string | undefined =>
      typeof a[k] === 'string' ? (a[k] as string) : undefined;
    switch (p.toolName) {
      case 'reply_to_email': {
        // Who it goes to leads: on a reply-all the audience IS the decision.
        const who = describeRecipients(
          { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
          { max: 2 },
        );
        const verb = a.replyAll === true ? 'Reply all' : 'Reply';
        return `${verb}${who ? ` ${who}` : ''} - ${s('body') ?? ''}`;
      }
      case 'compose_email': {
        const who = describeRecipients(
          { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
          { max: 2 },
        );
        return `New email${who ? ` ${who}` : ''} - ${s('subject') ?? ''}: ${s('body') ?? ''}`;
      }
      case 'forward_email': {
        const who = describeRecipients(
          { to: (a.to as string[]) ?? [], cc: (a.cc as string[]) ?? [] },
          { max: 2 },
        );
        // The email itself, so "is this the one?" is answered before ✓.
        const files = Array.isArray(a.previewFiles) ? (a.previewFiles as string[]) : [];
        return [
          `Forward "${s('threadSubject') ?? 'email'}"${who ? ` to ${who}` : ''}`,
          [s('previewFrom'), s('previewDate')].filter(Boolean).join(' · '),
          s('previewBody') ? `“${s('previewBody')}”` : '',
          files.length
            ? `📎 ${files.join(', ')}${a.includeAttachments === false ? ' (not included)' : ''}`
            : '',
          s('note') ? `Your note: ${s('note')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      case 'create_task':
        return s('title') ?? 'task';
      case 'add_list_item': {
        const items = Array.isArray(a.items) ? (a.items as string[]).join(', ') : '';
        return `${s('listName') ?? 'list'}${items ? ` - ${items}` : ''}`;
      }
      case 'create_event':
        return s('title') ?? 'event';
      case 'save_link':
        return s('title') ?? s('url') ?? 'link';
      case 'save_place':
        return s('name') ?? 'place';
      case 'save_contact':
        return s('name') ?? 'contact';
      case 'save_media':
        return s('title') ?? 'media';
      case 'create_trip':
        return `${s('name') ?? 'trip'} · ${s('destination') ?? ''}`;
      case 'add_travel_leg':
        return `${s('origin') ?? '?'} → ${s('destination') ?? '?'}`;
      case 'add_accommodation':
        return s('propertyName') ?? 'stay';
      case 'add_reservation':
        return s('name') ?? 'reservation';
      case 'record_rsvp':
        return `RSVP ${s('displayName') ?? ''} · ${s('status') ?? ''}`;
      case 'delete_messages': {
        if (s('scope') === 'all') return 'Clear this chat';
        const n = Array.isArray(a.messageIds) ? a.messageIds.length : 1;
        return `Delete the last ${n === 1 ? 'message' : `${n} messages`}`;
      }
      default:
        return p.toolName;
    }
  } catch {
    return p.toolName;
  }
}

type BubbleProps = {
  msg: Message;
  mine: boolean;
  cards?: BotCard[];
  tools?: BotToolEvent[];
  sources?: BotSourcesEvent['sources'];
  proposals?: Proposal[];
  busyProposalIds?: Set<string>;
  onResolveProposal?: (id: string, action: 'confirm' | 'reject') => void;
  attachment?: Attachment;
  sender?: { displayName: string; shadow: boolean };
  /** ADR 0022 silent-bot receipt strip under the user's bubble. */
  receipt?: {
    status: 'received' | 'done' | 'failed';
    tools: BotToolEvent[];
    cards: BotCard[];
  };
  saveOffer?: BotSaveOffer;
  onAcceptSaveOffer?: (messageId: string) => void;
  onDismissSaveOffer?: (messageId: string) => void;
  /** ADR 0157 — a `kind: 'contact'` card was tapped and the user picked an
   *  email; post it into the chat so the next bot turn can send the invite. */
  onContactEmail?: (name: string, email: string) => void;
  /** ADR 0299 — a `kind: 'choices'` chip was tapped; post its text. */
  onQuickReply?: (text: string) => void;
  /** ADR 0298 — long-press or a tap on the name of someone else's message
   *  opens Copy / Block. Absent in the personal chat. */
  onPersonMenu?: (userId: string, name: string, text: string, messageId: string) => void;
};

function sameToolList(a?: BotToolEvent[], b?: BotToolEvent[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].status !== b[i].status ||
      a[i].summary !== b[i].summary
    ) {
      return false;
    }
  }
  return true;
}

function sameCardList(a?: BotCard[], b?: BotCard[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.kind !== y.kind ||
      x.title !== y.title ||
      x.subtitle !== y.subtitle ||
      x.meta !== y.meta ||
      x.href !== y.href ||
      x.url !== y.url ||
      x.attachmentId !== y.attachmentId ||
      x.memoryStatus !== y.memoryStatus
    ) {
      return false;
    }
  }
  return true;
}

function sameProposals(a?: Proposal[], b?: Proposal[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].toolName !== b[i].toolName) {
      return false;
    }
  }
  return true;
}

function sameReceipt(a: BubbleProps['receipt'], b: BubbleProps['receipt']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.status === b.status &&
    sameToolList(a.tools, b.tools) &&
    sameCardList(a.cards, b.cards)
  );
}

function bubblePropsEqual(prev: BubbleProps, next: BubbleProps): boolean {
  const pm = prev.msg;
  const nm = next.msg;
  if (
    pm.id !== nm.id ||
    pm.body !== nm.body ||
    pm.createdAt !== nm.createdAt ||
    pm.kind !== nm.kind ||
    pm.senderId !== nm.senderId ||
    pm.attachmentId !== nm.attachmentId ||
    pm.replyToId !== nm.replyToId
  ) {
    return false;
  }
  if (prev.mine !== next.mine) return false;
  if (prev.attachment !== next.attachment) return false;
  if (
    prev.sender?.displayName !== next.sender?.displayName ||
    prev.sender?.shadow !== next.sender?.shadow
  ) {
    return false;
  }
  if (prev.onResolveProposal !== next.onResolveProposal) return false;
  if (prev.onAcceptSaveOffer !== next.onAcceptSaveOffer) return false;
  if (prev.onDismissSaveOffer !== next.onDismissSaveOffer) return false;
  if (prev.onContactEmail !== next.onContactEmail) return false;
  if (prev.onQuickReply !== next.onQuickReply) return false;
  if (prev.onPersonMenu !== next.onPersonMenu) return false;
  if (
    prev.saveOffer?.messageId !== next.saveOffer?.messageId ||
    prev.saveOffer?.url !== next.saveOffer?.url ||
    prev.saveOffer?.title !== next.saveOffer?.title
  ) {
    return false;
  }
  if (!sameCardList(prev.cards, next.cards)) return false;
  if (!sameToolList(prev.tools, next.tools)) return false;
  if (prev.sources !== next.sources) {
    if (!prev.sources || !next.sources || prev.sources.length !== next.sources.length) {
      return false;
    }
    for (let i = 0; i < prev.sources.length; i++) {
      if (prev.sources[i].attachmentId !== next.sources[i].attachmentId) return false;
    }
  }
  if (!sameReceipt(prev.receipt, next.receipt)) return false;
  if (!sameProposals(prev.proposals, next.proposals)) return false;
  const ids = next.proposals ?? prev.proposals ?? [];
  for (const p of ids) {
    if (!!prev.busyProposalIds?.has(p.id) !== !!next.busyProposalIds?.has(p.id)) {
      return false;
    }
  }
  return true;
}

const Bubble = memo(function Bubble({
  msg,
  mine,
  cards,
  tools,
  sources,
  proposals,
  busyProposalIds,
  onResolveProposal,
  attachment,
  sender,
  receipt,
  saveOffer,
  onAcceptSaveOffer,
  onDismissSaveOffer,
  onContactEmail,
  onQuickReply,
  onPersonMenu,
}: BubbleProps) {
  const isBot = msg.kind === 'bot' || msg.senderId === null;
  const [copied, setCopied] = useState(false);
  const streaming = isStreamingPlaceholder(msg);
  const senderLabel = isBot ? 'Chord' : sender?.displayName ?? msg.senderId ?? '';
  const isShadow = !isBot && sender?.shadow === true;
  const av = avatarFor(senderLabel || 'anon');
  const captionBody = attachment ? stripAttachmentPrefix(msg.body, attachment.filename) : msg.body;
  const personId = !mine && !isBot && msg.senderId ? msg.senderId : null;
  const openPersonMenu =
    personId && onPersonMenu
      ? () => onPersonMenu(personId, senderLabel || 'this person', captionBody || msg.body, msg.id)
      : null;
  const fixedWidth = chatColumnNeedsFixedWidth({
    cards: isBot ? cards : undefined,
    receiptCards: !isBot ? receipt?.cards : undefined,
    proposalCount: (isBot || receipt) && onResolveProposal ? proposals?.length ?? 0 : 0,
  });
  // The ✓/✗ for cards this turn left waiting: under a visible bot reply, or
  // in the receipt strip when the reply was hidden (ADR 0022).
  const proposalPills =
    proposals && proposals.length > 0 && onResolveProposal ? (
      <View style={styles.proposalStack}>
        {proposals.map((p) => {
          const busy = busyProposalIds?.has(p.id) ?? false;
          // Text opens the proposal's source (the email it came from) so
          // it can be checked before ✓ - unless the source IS this chat.
          const sourceHref =
            p.sourceHref && p.sourceHref !== `/groups/${msg.groupId}` ? p.sourceHref : null;
          // A reply draft is the decision itself, so it is shown whole,
          // and can be moved into the email's reply box to edit.
          const replyDraft = replyDraftOf(p);
          return (
            <View key={p.id} style={styles.proposalPill}>
              <Text style={styles.proposalTag}>proposed</Text>
              <Pressable
                style={{ flex: 1, minWidth: 0 }}
                disabled={!sourceHref}
                onPress={() =>
                  sourceHref && router.push(sourceHref as Parameters<typeof router.push>[0])
                }
              >
                <Text
                  style={[styles.proposalText, sourceHref && styles.proposalTextLink]}
                  numberOfLines={replyDraft || p.toolName === 'forward_email' ? undefined : 2}
                >
                  {proposalSummary(p)}
                </Text>
              </Pressable>
              {replyDraft ? (
                <Pressable
                  onPress={() => {
                    editReplyDraft(p).catch((e: Error) =>
                      showAlert("Couldn't open the draft", e.message),
                    );
                  }}
                  disabled={busy}
                  accessibilityLabel="Edit this reply in the email"
                  style={({ pressed }) => [
                    styles.proposalBtn,
                    styles.proposalBtnEdit,
                    pressed && !busy && { opacity: 0.6 },
                    busy && { opacity: 0.4 },
                  ]}
                >
                  <Text style={styles.proposalBtnEditTxt}>Edit</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => onResolveProposal(p.id, 'confirm')}
                disabled={busy}
                style={({ pressed }) => [
                  styles.proposalBtn,
                  styles.proposalBtnOk,
                  pressed && !busy && { opacity: 0.6 },
                  busy && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.proposalBtnOkTxt}>✓</Text>
              </Pressable>
              <Pressable
                onPress={() => onResolveProposal(p.id, 'reject')}
                disabled={busy}
                style={({ pressed }) => [
                  styles.proposalBtn,
                  styles.proposalBtnNo,
                  pressed && !busy && { opacity: 0.6 },
                  busy && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.proposalBtnNoTxt}>✗</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    ) : null;

  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      {!mine && (
        <View style={[styles.bubAv, { backgroundColor: av.bg }]}>
          <Text style={[styles.bubAvTxt, { color: av.fg }]}>
            {isBot ? 'C' : av.initials}
          </Text>
        </View>
      )}
      <View style={[styles.bubbleCol, fixedWidth && styles.bubbleColFixed]}>
        <Pressable
          style={[
            styles.bubble,
            fixedWidth && (mine ? styles.bubbleAlignEnd : styles.bubbleAlignStart),
            mine
              ? styles.bubbleMine
              : isBot
                ? styles.bubbleBot
                : styles.bubbleOther,
          ]}
          // Long-press to copy the message text (ADR 0054). Image-copy is
          // deferred; attachment taps still open via AttachmentCard's own
          // Pressable, which claims taps over this long-press. On someone
          // else's message it opens Copy / Block instead (ADR 0298).
          delayLongPress={350}
          onLongPress={() => {
            if (openPersonMenu) {
              openPersonMenu();
              return;
            }
            const text = captionBody || msg.body;
            if (!text) return;
            void Clipboard.setStringAsync(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {!mine && (
            <View style={styles.bubbleNameRow}>
              <Text
                style={[styles.bubbleName, isBot && styles.bubbleNameBot]}
                onPress={openPersonMenu ?? undefined}
                accessibilityRole={openPersonMenu ? 'button' : undefined}
                accessibilityHint={openPersonMenu ? 'Opens options, including Block' : undefined}
              >
                {isBot ? 'Chord' : senderLabel}
                {streaming ? (isBot ? ' · thinking…' : ' · typing…') : ''}
              </Text>
              {isShadow && (
                <Text style={styles.shadowChip}>📥 imported</Text>
              )}
            </View>
          )}
          {attachment && <AttachmentCard attachment={attachment} mine={mine} />}
          {captionBody ? (
            <Text style={styles.bubbleText}>{captionBody}</Text>
          ) : !attachment && streaming ? (
            <Text style={styles.bubbleText}>…</Text>
          ) : null}
        </Pressable>
        {copied && <Text style={styles.copiedToast}>Copied</Text>}
        {isBot && tools && shownTools(tools).length > 0 && (
          <View style={styles.toolStrip}>
            {shownTools(tools).map((t, i) => (
              <View
                key={i}
                // `declined` (ran, but its own result said nothing happened)
                // gets the same warning treatment as a thrown `error` —
                // both mean "don't read this pill as a success".
                style={[styles.toolPill, t.status !== 'ok' && styles.toolPillError]}
              >
                <Text style={styles.toolPillIcon}>
                  {t.status !== 'ok' ? '⚠' : '⚙'}
                </Text>
                <Text style={styles.toolPillText} numberOfLines={1}>
                  {toolLabel(t.name, t.status)}
                  {toolSummaryText(t)}
                </Text>
              </View>
            ))}
          </View>
        )}
        {isBot && cards && cards.length > 0 && (
          <View style={styles.cardStack}>
            {cards.map((c, i) => {
              // ADR 0029 - `kind: 'action' + callback` cards are IM-only
              // (Telegram inline buttons). The mobile app surfaces the
              // same actions through native proposal pills below.
              if (c.kind === 'action' && c.callback && !c.url) return null;
              if (c.kind === 'memory') return <MemoryCard key={i} card={c} />;
              // Compact save chip - but only when it isn't a tappable
              // (href-carrying) search-result card, which needs the full
              // body + Pressable below.
              if (c.kind === 'save' && !c.href) {
                return (
                  <View key={i} style={styles.cardSaveTiny}>
                    <Text style={styles.cardSaveTinyIcon}>{cardIcon(c.kind)}</Text>
                    <Text style={styles.cardSaveTinyText} numberOfLines={1}>
                      {c.title}
                      {c.subtitle ? ` · ${c.subtitle}` : ''}
                    </Text>
                  </View>
                );
              }
              const body = (
                <>
                  <Text style={styles.cardIcon}>{cardIcon(c.kind)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.cardTitle,
                        c.href || c.attachmentId || (c.kind === 'action' && c.url)
                          ? styles.cardTitleLink
                          : null,
                      ]}
                      numberOfLines={1}
                    >
                      {c.title}
                    </Text>
                    {c.subtitle && (
                      <Text style={styles.cardSub} numberOfLines={1}>
                        {c.subtitle}
                      </Text>
                    )}
                    {c.preview && (
                      <Text style={styles.cardPreview} numberOfLines={2}>
                        {c.preview}
                      </Text>
                    )}
                    {c.kind === 'email' && c.meta && isEmailAction(c.meta) ? (
                      <ActionBadge action={c.meta} />
                    ) : (
                      c.meta && <Text style={styles.cardMeta}>{c.meta}</Text>
                    )}
                  </View>
                </>
              );
              // ADR 0059 - file result cards open the actual attachment
              // (PDF/image/doc) on tap.
              if (c.attachmentId) {
                const attId = c.attachmentId;
                const fname = c.title;
                const mime = c.mimeType;
                return (
                  <Pressable
                    key={i}
                    style={[styles.card, styles.cardAction]}
                    onPress={() => {
                      void openAttachmentCard(attId, fname, mime);
                    }}
                  >
                    {body}
                  </Pressable>
                );
              }
              // ADR 0059 - search-result cards carry an in-app `href`; tapping
              // navigates inside the app (router.push) rather than opening a URL.
              if (c.href) {
                const href = c.href;
                return (
                  <Pressable
                    key={i}
                    style={[styles.card, styles.cardAction]}
                    onPress={() => {
                      router.push(href as Parameters<typeof router.push>[0]);
                    }}
                  >
                    {body}
                  </Pressable>
                );
              }
              if (c.kind === 'action' && c.url) {
                const url = c.url;
                const appUrl = c.appUrl;
                return (
                  <Pressable
                    key={i}
                    style={[styles.card, styles.cardAction]}
                    onPress={() => {
                      void openCardLink(appUrl, url);
                    }}
                  >
                    {body}
                  </Pressable>
                );
              }
              // ADR 0299 - answers to the question just asked. Settled once a
              // newer message arrives, so only the newest one is tappable.
              if (c.kind === 'choices') {
                if (!onQuickReply || !c.replies?.length) return null;
                return (
                  <View key={i} style={styles.choiceRow}>
                    {c.replies.map((r) => (
                      <Pressable
                        key={r}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.choiceChip, pressed && { opacity: 0.6 }]}
                        onPress={() => onQuickReply(r)}
                      >
                        <Text style={styles.choiceChipText}>{r}</Text>
                      </Pressable>
                    ))}
                  </View>
                );
              }
              // ADR 0157 - "Add <name> from Contacts": open the OS picker and
              // post the chosen email back so the bot can finish the invite.
              if (c.kind === 'contact') {
                const name = c.contactName ?? c.title;
                return (
                  <Pressable
                    key={i}
                    style={[styles.card, styles.cardAction]}
                    onPress={() => {
                      void pickContactEmail(name, onContactEmail);
                    }}
                  >
                    {body}
                  </Pressable>
                );
              }
              return (
                <View key={i} style={styles.card}>
                  {body}
                </View>
              );
            })}
          </View>
        )}
        {isBot && proposalPills}
        {isBot && sources && sources.length > 0 && (
          <View style={styles.sourceFooterRow}>
            <Text style={styles.sourceFooter}>based on: </Text>
            {sources.map((s, i) => (
              <SourceLink key={s.attachmentId} source={s} showDot={i > 0} />
            ))}
          </View>
        )}
        {!isBot && saveOffer && (
          <View style={styles.saveOfferCardWrap}>
            <Pressable
              style={[styles.card, styles.cardAction]}
              onPress={() => onAcceptSaveOffer?.(msg.id)}
            >
              <Text style={styles.cardIcon}>🔖</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, styles.cardTitleLink]} numberOfLines={1}>
                  Save {saveOffer.title}
                </Text>
                <Text style={styles.cardSub} numberOfLines={1}>
                  Tap to save · auto-saves in 30s
                </Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={(ev) => {
                  ev.stopPropagation();
                  onDismissSaveOffer?.(msg.id);
                }}
                style={styles.saveOfferDismiss}
              >
                <Text style={styles.saveOfferDismissText}>×</Text>
              </Pressable>
            </Pressable>
          </View>
        )}
        {!isBot && receipt && (
          <View style={styles.receiptStrip}>
            <Text
              style={[
                styles.receiptHeader,
                receipt.status === 'failed' && styles.receiptHeaderFailed,
              ]}
            >
              {receipt.status === 'received'
                ? '└ 👀 Chord'
                : receipt.status === 'done'
                  ? // The turn finishing is not the request succeeding: a tick
                    // over "group did not resolve" reads as done when nothing
                    // was saved.
                    receipt.tools.length > 0 && receipt.tools.every((t) => t.status !== 'ok')
                    ? shownTools(receipt.tools).length > 0
                      ? '└ ⚠️ Chord'
                      : '└ ⚠️ Chord couldn’t do that - try again'
                    : '└ ✅ Chord'
                  : '└ ⚠️ Chord didn’t catch that - try again'}
            </Text>
            {shownTools(receipt.tools).length > 0 && (
              <View style={styles.receiptTools}>
                {shownTools(receipt.tools).map((t, i) => (
                  <Text
                    key={i}
                    style={[
                      styles.receiptToolText,
                      // `declined` (ran, but its own result said nothing
                      // happened — a past-date refusal, an unresolvable
                      // repeat, …) reads just as wrong styled like a success
                      // as a thrown `error` does.
                      t.status !== 'ok' && styles.receiptToolError,
                    ]}
                    numberOfLines={1}
                  >
                    {toolLabel(t.name, t.status)}
                    {toolSummaryText(t)}
                  </Text>
                ))}
              </View>
            )}
            {receipt.cards.length > 0 && (
              <View style={styles.receiptCards}>
                {receipt.cards.map((c, i) => {
                  if (c.kind === 'memory') return <MemoryCard key={i} card={c} />;
                  if (c.kind === 'save') {
                    return (
                      <View key={i} style={styles.cardSaveTiny}>
                        <Text style={styles.cardSaveTinyIcon}>{cardIcon(c.kind)}</Text>
                        <Text style={styles.cardSaveTinyText} numberOfLines={1}>
                          {c.title}
                          {c.subtitle ? ` · ${c.subtitle}` : ''}
                        </Text>
                      </View>
                    );
                  }
                  const inner = (
                    <>
                      <Text style={styles.cardIcon}>{cardIcon(c.kind)}</Text>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.cardTitle,
                            c.kind === 'action' && c.url ? styles.cardTitleLink : null,
                          ]}
                          numberOfLines={1}
                        >
                          {c.title}
                        </Text>
                        {c.subtitle && (
                          <Text style={styles.cardSub} numberOfLines={1}>
                            {c.subtitle}
                          </Text>
                        )}
                        {c.meta && <Text style={styles.cardMeta}>{c.meta}</Text>}
                      </View>
                    </>
                  );
                  if (c.kind === 'action' && c.url) {
                    const url = c.url;
                    const appUrl = c.appUrl;
                    return (
                      <Pressable
                        key={i}
                        style={[styles.card, styles.cardAction]}
                        onPress={() => {
                          void openCardLink(appUrl, url);
                        }}
                      >
                        {inner}
                      </Pressable>
                    );
                  }
                  return (
                    <View key={i} style={styles.card}>
                      {inner}
                    </View>
                  );
                })}
              </View>
            )}
            {proposalPills}
          </View>
        )}
      </View>
    </View>
  );
}, bubblePropsEqual);

const styles = themed((colors) => ({
  inviteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.accentLight,
  },
  inviteLabel: { color: colors.accentDark, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  inviteCode: { color: colors.accent, fontWeight: '700', letterSpacing: 2 },
  inviteCodeLink: { textDecorationLine: 'underline', letterSpacing: 0.3 },
  mirrorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mirrorBox: { color: colors.accentDark, fontSize: 16 },
  mirrorBoxChecked: { color: colors.accent },
  mirrorLabel: {
    color: colors.accentDark,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  ingestBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    paddingHorizontal: 14,
    backgroundColor: byScheme('#f1ece0', colors.accentLight),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ingestText: { color: colors.text, fontSize: 12, flex: 1 },

  list: { padding: 12, paddingBottom: 8 },
  loadingOlder: { paddingVertical: 12, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 60, fontStyle: 'italic' },
  headerSelectTxt: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  hidden: { display: 'none' },
  selectRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  selectBox: { fontSize: 20, color: colors.accent, width: 24, textAlign: 'center' },
  selectBoxOff: { color: colors.border },
  selectBubble: { flex: 1 },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  selectBarTxt: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  selectBarCount: { color: colors.muted, fontSize: 13 },
  selectBarDelete: { color: colors.red, fontSize: 15, fontWeight: '700' },
  selectBarDeleteOff: { opacity: 0.35 },
  daySeparator: { alignItems: 'center', marginVertical: 10 },
  daySeparatorText: {
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  unreadDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 10,
  },
  unreadLine: { flex: 1, height: 1, backgroundColor: colors.accent, opacity: 0.5 },
  unreadLabel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 8 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubAv: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  bubAvTxt: { fontSize: 10, fontWeight: '700' },

  bubbleCol: { flexShrink: 1, maxWidth: '78%' },
  bubbleColFixed: { width: '78%' },
  bubbleAlignStart: { alignSelf: 'flex-start' },
  bubbleAlignEnd: { alignSelf: 'flex-end' },
  bubble: { padding: 10, borderRadius: 14 },
  bubbleMine: { backgroundColor: colors.rightBubble, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: colors.leftBubble, borderBottomLeftRadius: 4 },
  bubbleBot: { backgroundColor: colors.chordBubble, borderBottomLeftRadius: 4 },
  bubbleName: { fontSize: 10, color: colors.muted, fontWeight: '600' },
  bubbleNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  bubbleNameBot: { color: colors.accent },
  shadowChip: { fontSize: 9, color: colors.muted, fontStyle: 'italic' },
  bubbleText: { fontSize: 14, color: colors.text, lineHeight: 20 },
  copiedToast: {
    alignSelf: 'center',
    marginTop: 3,
    fontSize: 11,
    color: colors.muted,
  },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  attachTxt: {
    fontSize: 22,
    color: colors.muted,
    fontWeight: '300',
    // Center the glyph in the 40px circle: flex centers the text box, but the
    // glyph rides high off the baseline without a matching lineHeight.
    lineHeight: 40,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  composerWrap: { flex: 1 },
  textField: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    backgroundColor: colors.bg,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendIcon: { color: colors.onAccent, fontSize: 15, fontWeight: '700', marginLeft: 2 },

  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheetPanel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 18,
    paddingBottom: 28,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 16,
  },
  sheetGrid: { flexDirection: 'row', gap: 12 },
  sheetTile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  sheetTileIcon: { fontSize: 26 },
  sheetTileLabel: { fontSize: 12, color: colors.text, fontWeight: '600' },
  err: { color: colors.red, paddingHorizontal: 12, paddingBottom: 4 },

  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerBack: { paddingLeft: 12, paddingRight: 4, paddingVertical: 6 },
  headerBackTxt: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  headerTitleTxt: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  headerTitleHint: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: -1 },
  dot: { width: 8, height: 8, borderRadius: 4 },

  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  pickerCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
  },
  pickerTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  pickerFile: { fontSize: 12, color: colors.muted, marginBottom: 12 },
  pickerBtnRow: { flexDirection: 'row', gap: 8, marginTop: 12, justifyContent: 'flex-end' },
  pickerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  pickerBtnText: { color: colors.onAccent, fontWeight: '600', fontSize: 13 },
  pickerBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  pickerBtnGhostText: { color: colors.text, fontWeight: '600', fontSize: 13 },

  fileCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 8,
    marginBottom: 4,
    borderRadius: 10,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 180,
  },
  fileCardMine: { backgroundColor: byScheme('rgba(255,255,255,0.6)', 'rgba(255,255,255,0.06)') },
  fileIcon: { fontSize: 22, marginTop: 1 },
  fileName: { fontSize: 13, fontWeight: '700', color: colors.text },
  fileMeta: { fontSize: 10, color: colors.muted, marginTop: 2 },
  fileSummary: { fontSize: 11, color: colors.muted, marginTop: 4, fontStyle: 'italic' },
  fileTags: { fontSize: 11, color: colors.muted, marginTop: 2 },
  imageThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  lightboxImage: { width: '100%', height: '85%' },
  lightboxCaption: { position: 'absolute', left: 16, right: 16, bottom: 24 },
  lightboxFilename: { color: '#fff', fontSize: 14, fontWeight: '600' },
  lightboxSummary: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 4 },

  toolStrip: { marginTop: 4, flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  toolPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.accentLight,
    borderWidth: 1,
    borderColor: colors.accent,
    maxWidth: '100%',
  },
  toolPillError: {
    backgroundColor: colors.card,
    borderColor: colors.red,
  },
  toolPillIcon: { fontSize: 10, color: colors.accent },
  toolPillText: { fontSize: 11, color: colors.text, flexShrink: 1 },

  sourceFooter: {
    marginTop: 4,
    fontSize: 10,
    color: colors.muted,
    fontStyle: 'italic',
    lineHeight: 13,
  },
  sourceFooterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: 4,
  },
  sourceFooterLink: {
    color: colors.accent,
    textDecorationLine: 'underline',
    fontStyle: 'italic',
  },

  proposalStack: { marginTop: 6, gap: 6 },
  proposalPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: byScheme('#FFF9E6', colors.amberBg),
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
  },
  proposalTag: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: colors.warn,
    backgroundColor: colors.amberBg,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  proposalText: { fontSize: 12, color: colors.text },
  proposalTextLink: { textDecorationLine: 'underline', textDecorationColor: colors.border },
  proposalBtn: {
    minWidth: 28,
    height: 26,
    paddingHorizontal: 6,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  proposalBtnOk: { backgroundColor: colors.greenBg },
  proposalBtnOkTxt: { color: byScheme('#1e7a3b', colors.green), fontWeight: '700', fontSize: 13 },
  proposalBtnNo: { backgroundColor: colors.redBg },
  proposalBtnNoTxt: { color: byScheme('#b91c1c', colors.red), fontWeight: '700', fontSize: 13 },
  proposalBtnEdit: { backgroundColor: colors.accentLight },
  proposalBtnEditTxt: { color: colors.accent, fontWeight: '700', fontSize: 12 },

  cardStack: { marginTop: 4, gap: 6 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  cardIcon: { fontSize: 16, marginTop: 1 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  cardTitleLink: { color: colors.accent, textDecorationLine: 'underline' },
  cardAction: { borderColor: colors.accent },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.card,
  },
  choiceChipText: { fontSize: 13, color: colors.accent, fontWeight: '600' },
  cardSub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  cardPreview: { fontSize: 12, color: colors.text, marginTop: 3, lineHeight: 16 },
  cardMeta: { fontSize: 11, color: colors.muted, marginTop: 2, fontStyle: 'italic' },
  cardSaveTiny: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  cardSaveTinyIcon: { fontSize: 11, color: colors.muted },
  cardSaveTinyText: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  receiptStrip: {
    marginTop: 4,
    paddingLeft: 6,
    gap: 4,
  },
  receiptHeader: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  receiptHeaderFailed: { color: colors.red },
  receiptTools: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 12 },
  receiptToolText: { fontSize: 11, color: colors.muted },
  receiptToolError: { color: colors.red },
  receiptCards: { paddingLeft: 12, gap: 4 },
  saveOfferCardWrap: { marginTop: 4 },
  saveOfferDismiss: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveOfferDismissText: { fontSize: 16, color: colors.muted, lineHeight: 16 },

  offerBanner: {
    marginHorizontal: 10,
    marginBottom: 6,
    padding: 10,
    borderRadius: 10,
    backgroundColor: colors.accentLight,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  offerText: { fontSize: 12, color: colors.text, lineHeight: 17 },
  offerBtnRow: { flexDirection: 'row', gap: 8, marginTop: 8, justifyContent: 'flex-end' },
}));
