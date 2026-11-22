/**
 * Email thread (ADR 0060). Shows the ordered messages in a thread; HTML is
 * sanitized and rendered via EmailBody.
 *
 * Two layouts, one screen. Reading: the mail has the whole screen and three
 * floating icons (trash, more, reply) hold every action. Answering: the
 * composer takes the whole screen with Send in the header, so the text being
 * written sits above the keyboard rather than behind it. They share one
 * screen because they share the draft, its autosave and its recipients.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { useSignatureCaret } from '@/signature-caret';
import {
  applyReplyAll,
  bodyWithSignature,
  holdImageToken,
  inlineImageContentIds,
  isOnlySignature,
  pickReplyTarget,
  printableThreadHtml,
  replyAllAdds,
  replyRecipients,
  replyToWarning,
  aiDraftToRevise,
  placeAiReply,
  threadOpenPlan,
  threadToPlainText,
  afterRemoveTarget,
  nextInWalk,
  prevInWalk,
  type EmailAfterRemove,
  type EmailDraft,
  type EmailMessage,
  type EmailThreadDetail,
  type HeldImageToken,
  runExclusive,
  messagesOnScreen,
  messagesToMarkRead,
  replyShapeOf,
  reviseReplyAsks,
  splitSignature,
  defaultComposeFormat,
} from '@chord/kernel';

import {
  GmailReconnectError,
  composeEmailReply,
  getEmailThread,
  getFamily,
  summarizeEmailThread,
  fetchEmailReplyAsks,
  getSettingsCached,
  modifyEmailThread,
  setEmailImageSender,
  unsubscribeEmailThread,
  openUserStream,
  replyEmailThread,
  shareEmailThreadToGroup,
  type StreamHandle,
} from '@/api';
import { confirmDestructive } from '@/confirm';
import { EmailBody, sanitizeEmailHtml, stripHtml } from '@/email-body';
import { openEmailAttachment } from '@/open-email-attachment';
import { MagicCard } from '@/email-magic';
import { LinkChip } from '@/link-chip';
import {
  currentWalk,
  getAfterRemovePref,
  hasPrefetchedThread,
  putPrefetchedThread,
  setAfterRemovePref,
  takePrefetchedThread,
  useEmailThreadNav,
} from '@/email-thread-nav';
import { applyThreadUpdate, readStoredThread, removeStoredThreads, storeThread } from '@/email-device-store';
import { useApp } from '@/store';
import { EmailAttachments, FileDropOverlay, useEmailAttachments } from '@/email-attach';
import { useDraftAutosave } from '@/email-draft';
import { outboxNotice, queueEmail, useEmailWaiting } from '@/email-outbox';
import { newSendId } from '@/send-queue';
import { showAlert } from '@/alert';
import { OfflineError, SlowServerError } from '@/network';
import { useEmailSignature, useEmailSignatureHtml } from '@/email-signature';
import { ComposeBodyEditor, FormatSwitch, useComposeBody } from '@/compose-body';
import { OutdatedSignatureNote, useSignatureFollow } from '@/outdated-signature';
import { takeReplyDraft } from '@/reply-draft';
import { AskBar, type AskChip, AskWriting, composeHeaderOptions, composeStyles as cs } from '@/email-compose-ui';
import { EmailLabelSheet } from '@/email-label-sheet';
import { EmailSplit, PaneHeader } from '@/email-split-pane';
import { PlainModeNotice, RecipientsSheet, SenderSheet, SenderWarning, senderMark } from '@/email-sender-sheet';
import { ActionSheet, Icon, ReaderBar, type SheetRow } from '@/email-reader-bar';
import { byScheme, colors, themed } from '@/theme';
import { KeyboardScreen, DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';
import { backHomeHeaderLeft, goBackOr } from '@/back-home';

/**
 * One-tap asks for the suggested reply's ask bar (ADR 0197). Only the
 * fallback now: the bar asks for chips read off this email first.
 */
const AI_QUICK_ASKS = [
  { label: 'Suggest times', ask: 'Reply suggesting 2–3 times I am free' },
  { label: 'Say yes', ask: 'Reply accepting' },
  { label: 'Decline', ask: 'Reply politely declining' },
  { label: 'Thanks', ask: 'Reply with a short thank-you' },
];

/** "a@x.com, b@y.com; c@z.com" → deduped list of address-shaped tokens. */
function parseRecipients(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).filter((t) => t.includes('@')))];
}

function prettySize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return bytes > 0 ? `${bytes} B` : '';
}

/** "To: a@b, c@d" / "Cc: …" on one line; tapping opens the recipients box (ADR 0294). */
function RecipientLine({ msg, onPress }: { msg: EmailMessage; onPress: () => void }) {
  const to = msg.toEmails ?? [];
  const cc = msg.ccEmails ?? [];
  if (to.length === 0 && cc.length === 0) return null;
  return (
    // Only the text opens the box; the rest of the line belongs to the header,
    // which folds the message.
    <Pressable onPress={onPress} hitSlop={4} style={styles.tapToText}>
      {to.length > 0 ? (
        <Text style={styles.msgRcpt} numberOfLines={1}>
          To: {to.join(', ')}
        </Text>
      ) : null}
      {cc.length > 0 ? (
        <Text style={styles.msgRcpt} numberOfLines={1}>
          Cc: {cc.join(', ')}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One line of what a folded message says, so folding is not hiding. */
function previewOf(msg: EmailMessage): string {
  const raw = msg.snippet?.trim() || msg.bodyText?.trim() || stripHtml(msg.bodyHtml) || '';
  return raw.replace(/\s+/g, ' ').slice(0, 140);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MessageCard({
  msg,
  open,
  onToggle,
  showRemoteImages,
  imageToken,
  onBlockedImages,
  answering,
  mailboxEmail,
}: {
  msg: EmailMessage;
  open: boolean;
  /** The mailbox this thread is in - marks "(you)" among the recipients. */
  mailboxEmail?: string | null;
  onToggle?: () => void;
  /** This is the message the floating bar's reply would answer. */
  answering?: boolean;
  showRemoteImages?: boolean;
  imageToken?: string | null;
  onBlockedImages?: (count: number) => void;
}) {
  const [busyAtt, setBusyAtt] = useState<string | null>(null);
  const [attErr, setAttErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'sender' | 'recipients' | null>(null);
  const mark = senderMark(msg.senderCheck);
  // ADR 0294 - mail that may not be from who it says is shown as text, with
  // no images and no tappable links, until the reader asks for the original.
  const suspect = msg.senderCheck?.level === 'danger';
  const [showOriginal, setShowOriginal] = useState(false);
  // The reader may still ask for this message's images; never remembered for
  // the sender (that would be the thread banner's "Always").
  const [suspectImages, setSuspectImages] = useState(false);
  const plainOnly = suspect && !showOriginal;

  const openAtt = useCallback(
    async (att: { id: string; filename: string; mimeType: string }) => {
      setBusyAtt(att.id);
      setAttErr(null);
      try {
        await openEmailAttachment(msg.id, att);
      } catch (e) {
        setAttErr((e as Error).message);
      } finally {
        setBusyAtt(null);
      }
    },
    [msg.id],
  );

  // A logo or photo the body already shows in place is not a file to open.
  const shownInline = new Set(inlineImageContentIds(msg.bodyHtml));
  const files = (msg.attachments ?? []).filter(
    (a) => !(a.contentId && shownInline.has(a.contentId)),
  );

  if (!open) {
    return (
      <Pressable style={[styles.msg, styles.msgFolded]} onPress={onToggle}>
        <View style={styles.msgHead}>
          <Text style={styles.msgFrom} numberOfLines={1}>
            {mark ? <Text style={{ color: mark.color }}>{mark.text} </Text> : null}
            {msg.fromName ?? msg.fromEmail ?? 'Unknown'}
          </Text>
          <Text style={styles.msgTime}>
            {files.length > 0 ? '\u{1F4CE} ' : ''}
            {shortDate(msg.internalDate)}
          </Text>
        </View>
        <Text style={styles.msgFoldedTxt} numberOfLines={1}>
          {previewOf(msg)}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.msg, answering && styles.msgAnswering]}>
      {/* The whole header folds the message, except the name and the
          To/Cc text, which open their boxes and stop at the text. */}
      <Pressable onPress={onToggle} disabled={!onToggle}>
        <View style={styles.msgHead}>
          <View style={styles.msgFromCol}>
            <Pressable
              style={[styles.tapToText, styles.msgFromTap]}
              onPress={() => setSheet('sender')}
              hitSlop={6}
            >
              <Text style={styles.msgFrom} numberOfLines={1}>
                {mark ? <Text style={{ color: mark.color }}>{mark.text} </Text> : null}
                {msg.fromName ?? msg.fromEmail ?? 'Unknown'}
              </Text>
              {msg.fromName && msg.fromEmail ? (
                <Text style={styles.msgFromAddr} numberOfLines={1}>
                  {msg.fromEmail}
                </Text>
              ) : null}
            </Pressable>
          </View>
          <Text style={styles.msgTime}>{shortDate(msg.internalDate)}</Text>
        </View>
        <RecipientLine msg={msg} onPress={() => setSheet('recipients')} />
      </Pressable>
      <SenderWarning msg={msg} onPress={() => setSheet('sender')} />
      <SenderSheet open={sheet === 'sender'} onClose={() => setSheet(null)} msg={msg} />
      <RecipientsSheet
        open={sheet === 'recipients'}
        onClose={() => setSheet(null)}
        msg={msg}
        mailboxEmail={mailboxEmail ?? null}
      />
      {suspect ? (
        <PlainModeNotice
          html={msg.bodyHtml}
          showingOriginal={showOriginal}
          onToggle={() => {
            setShowOriginal((v) => !v);
            setSuspectImages(false);
          }}
          imagesLoaded={suspectImages}
          onLoadImages={() => {
            setShowOriginal(true);
            setSuspectImages(true);
          }}
        />
      ) : null}
      {!msg.bodyHtml && !msg.bodyText ? (
        <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 6 }}>
          Showing a preview. The full email hasn't come through from your mailbox yet.
        </Text>
      ) : null}
      <EmailBody
        html={msg.bodyHtml}
        text={msg.bodyText}
        snippet={msg.snippet}
        plainOnly={plainOnly}
        // Even the original keeps images off unless asked: loading one tells
        // the sender the address is live.
        showRemoteImages={suspect ? suspectImages : showRemoteImages}
        imageToken={imageToken}
        messageId={msg.id}
        // Its own notice offers the images; the thread banner's Show cannot.
        onBlockedImages={suspect ? undefined : onBlockedImages}
      />
      {files.length > 0 ? (
        <View style={styles.attRow}>
          {files.map((a) => (
            <Pressable
              key={a.id}
              style={[styles.attChip, busyAtt !== null && { opacity: 0.5 }]}
              disabled={busyAtt !== null}
              onPress={() => void openAtt(a)}
            >
              {busyAtt === a.id ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={styles.attChipTxt} numberOfLines={1}>
                  📎 {a.filename}
                  {a.size > 0 ? `  ·  ${prettySize(a.size)}` : ''}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      ) : null}
      {attErr ? <Text style={styles.attErr}>{attErr}</Text> : null}
    </View>
  );
}

/**
 * On a wide screen the mail list keeps its half beside this screen - reading
 * and writing alike (ADR 0320). The reader itself is unchanged: every early
 * return below, the composer included, is rendered into the right-hand pane,
 * and on a phone the wrapper is not there at all.
 */
export default function EmailThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  return (
    <EmailSplit openId={threadId ?? null}>
      <EmailThreadReader />
    </EmailSplit>
  );
}

/**
 * `embedded`: drawn in the list screen's reading pane rather than as its own
 * screen (ADR 0320). The route header then belongs to the list, so this draws
 * its own in-pane header, and moving between emails or leaving one is the
 * parent's selection changing rather than a navigation.
 */
export function EmailThreadReader({
  threadId: threadIdProp,
  embedded = false,
  onSelect,
  onClose,
}: {
  threadId?: string;
  embedded?: boolean;
  onSelect?: (id: string) => void;
  onClose?: () => void;
} = {}) {
  const params = useLocalSearchParams<{ threadId: string }>();
  const threadId = threadIdProp ?? params.threadId;
  // A neighbour the previous reader warmed paints at once; the real open below
  // (read-time pass, fresh unread state) replaces it when it lands.
  const [detail, setDetail] = useState<EmailThreadDetail | null>(() =>
    threadId ? takePrefetchedThread(threadId) : null,
  );
  const [loading, setLoading] = useState(() => detail === null);
  /** Showing the phone's stored copy because the open could not reach the server (ADR 0302). */
  const [offline, setOffline] = useState<false | 'offline' | 'slow'>(false);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const openFailed = useRef(false);
  const [afterRemove, setAfterRemove] = useState<EmailAfterRemove>(
    () => getAfterRemovePref() ?? 'next',
  );
  useEffect(() => {
    if (getAfterRemovePref()) return;
    getSettingsCached()
      .then((s) => {
        const v = s.emailAfterRemove ?? 'next';
        setAfterRemovePref(v);
        setAfterRemove(v);
      })
      .catch(() => {});
  }, []);
  const [reply, setReply] = useState('');
  // The signature is in the box, where the user can see it and delete it
  // (ADR 0260 addendum); a box holding only that is nothing written yet.
  // The one of the mailbox this thread is in: a reply leaves from there.
  const signature = useEmailSignature(detail?.thread.accountId ?? null);
  useSignatureFollow(signature, setReply);
  const signatureHtml = useEmailSignatureHtml(detail?.thread.accountId ?? null);
  // ADR 0339: Plain or Rich, and what the box holds in each.
  const replyCompose = useComposeBody(reply, setReply, signature, signatureHtml);
  const replyLoad = replyCompose.load;
  const threadLoaded = !!detail;
  const written = !isOnlySignature(reply, signature);
  const replyCaret = useSignatureCaret(reply, signature);
  const [busy, setBusy] = useState<
    null | 'reply' | 'read' | 'archive' | 'trash' | 'label' | 'chord' | 'unsub' | 'share'
  >(null);
  const [err, setErr] = useState<string | null>(null);
  // The mailbox no longer has this email (deleted at the source since the
  // list that led here was drawn).
  const [gone, setGone] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const loginEmail = useApp((s) => s.user?.email)?.toLowerCase() ?? null;
  // The mailbox's address, not the login's: a thread on an attached account is
  // addressed to that account.
  const myEmail = detail?.mailboxEmail?.toLowerCase() ?? loginEmail;
  const [replyAll, setReplyAll] = useState(false);
  // The message the reader chose to answer; null = the default below.
  const [replyToId, setReplyToId] = useState<string | null>(null);
  // null = derive from the latest message + mode; a string = user-edited.
  const [toStr, setToStr] = useState<string | null>(null);
  const [ccStr, setCcStr] = useState<string | null>(null);
  const [bccStr, setBccStr] = useState<string | null>(null);

  // ADR-less: prev/next over the Traditional list's own ordered ids, published
  // by mobile/app/email/index.tsx. Absent (e.g. opened from a bot search
  // card) reads as no sibling context, not an error - both chevrons hide.
  const navIds = useEmailThreadNav((s) => s.ids);
  const navHasMore = useEmailThreadNav((s) => s.hasMore);
  const navLoadMore = useEmailThreadNav((s) => s.loadMore);
  const navScope = useEmailThreadNav((s) => s.scope);
  const navRead = useEmailThreadNav((s) => s.read);
  // A category walk (AI view) or the list with Unread on: next skips email
  // already read, and the walk ends back where it started after the last one
  // (kernel/src/email-walk.ts), rather than on a dead end.
  const inWalk = navScope === 'category' || navScope === 'unread';
  const navRemoving = useEmailThreadNav((s) => s.removing);
  const navRemovedAt = useEmailThreadNav((s) => s.removedAt);
  const walk = useMemo(
    () => currentWalk({ ids: navIds, scope: navScope, read: navRead, removing: navRemoving, removedAt: navRemovedAt }),
    [navIds, navScope, navRead, navRemoving, navRemovedAt],
  );
  const [navBusy, setNavBusy] = useState(false);
  const navIndex = threadId ? navIds.indexOf(threadId) : -1;
  const prevId = threadId ? prevInWalk(walk, threadId) : null;
  const hasPrev = prevId !== null;
  const nextId = threadId ? nextInWalk(walk, threadId) : null;
  const hasNext = navIndex >= 0 && (nextId !== null || navHasMore || navScope === 'category');
  // A file to download, not an image shown in the body: the title's paperclip.
  const hasFile = !!detail?.messages.some((m) => m.attachments?.some((a) => !a.contentId));
  // Opening an email reads it: for the walk, it is done.
  const shown = !!detail;
  useEffect(() => {
    if (threadId && shown) useEmailThreadNav.getState().markRead(threadId);
  }, [threadId, shown]);
  useEffect(() => {
    if (!detail) return;
    for (const id of [nextId, prevId]) {
      if (!id || hasPrefetchedThread(id)) continue;
      const fetchedAt = Date.now();
      getEmailThread(id, { prefetch: true })
        .then((d) => {
          putPrefetchedThread(id, d);
          void storeThread(d, fetchedAt);
        })
        .catch(() => {});
    }
    // Once per thread shown, not per reload of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!detail, nextId, prevId]);

  const goToThread = useCallback(
    (id: string) => {
      if (embedded) {
        onSelect?.(id);
        return;
      }
      router.replace(`/email/${id}` as Parameters<typeof router.replace>[0]);
    },
    [embedded, onSelect],
  );

  /** Done with this email: back to the list, or just deselected in the pane. */
  const leave = useCallback(() => {
    if (embedded) onClose?.();
    else goBackOr('/email');
  }, [embedded, onClose]);

  const goPrev = useCallback(() => {
    if (prevId) goToThread(prevId);
  }, [prevId, goToThread]);

  const goNext = useCallback(async () => {
    if (navIndex < 0) return;
    if (nextId) {
      goToThread(nextId);
      return;
    }
    if (navScope === 'category') {
      leave();
      return;
    }
    // At the edge of what's loaded - fetch the next keyset page (ADR 0119)
    // through the list's own loadMore before giving up.
    if (navHasMore && navLoadMore) {
      setNavBusy(true);
      try {
        await navLoadMore();
        const fresh = threadId ? nextInWalk(currentWalk(useEmailThreadNav.getState()), threadId) : null;
        if (fresh) goToThread(fresh);
        else if (inWalk) leave();
      } finally {
        setNavBusy(false);
      }
    }
  }, [navIndex, nextId, navScope, navHasMore, navLoadMore, goToThread, threadId, inWalk, leave]);

  // The message the reader picked. Otherwise not simply the newest: once you
  // have replied, the newest is your own, and the composer would address the
  // next reply to you.
  const latest =
    (replyToId ? detail?.messages.find((m) => m.id === replyToId) : undefined) ??
    pickReplyTarget(detail?.messages ?? [], myEmail);
  // Shared with the reply_to_email bot tool (kernel) so the two surfaces cannot
  // disagree about who receives a message the user already sent.
  const { to: defaultTo, cc: defaultCc } = replyRecipients(latest, {
    replyAll,
    myEmail,
  });
  const to = toStr !== null ? parseRecipients(toStr) : defaultTo;
  const cc = ccStr !== null ? parseRecipients(ccStr) : defaultCc;
  const bcc = bccStr !== null ? parseRecipients(bccStr) : [];

  // ADR 0339: a reply opens the way the email it answers was written; a saved
  // draft that says otherwise wins (`replyLoad`).
  const replyInit = replyCompose.init;
  const latestHtml = latest?.bodyHtml ?? null;
  const latestKnown = !!latest;
  useEffect(() => {
    if (latestKnown) replyInit(defaultComposeFormat({ kind: 'reply', original: { bodyHtml: latestHtml } }));
  }, [latestKnown, latestHtml, replyInit]);

  // A bot-drafted reply the user chose to edit arrives here in the reply box
  // (its proposal already closed, so it can only be sent from this screen).
  useEffect(() => {
    // Waits for the signature (and the thread, which names the mailbox and so
    // which signature) so the handed draft shows it like any reply.
    if (!threadId || signature === undefined || !threadLoaded) return;
    const handed = takeReplyDraft(threadId);
    if (!handed) return;
    setReply(bodyWithSignature(handed.body, signature));
    setReplyAll(handed.replyAll);
    setReplying(true);
  }, [threadId, signature, threadLoaded]);

  // The composer is a whole-screen layout, opened from the floating bar and
  // closed only by Send or Cancel. Cancel keeps what was written: the draft
  // autosaves (ADR 0113) and the reply menu offers to pick it back up.
  const [replying, setReplying] = useState(false);
  // Adds the ask bar (ADR 0197). The message being sent is the same box.
  const [suggested, setSuggested] = useState(false);
  // Chips for an empty reply box, read off this email (ADR 0197 addendum).
  // Keyed on the newest message, so a new reply in the thread asks again.
  // Empty while asking; on failure the fixed chips stand in.
  const newestId = detail?.messages[detail.messages.length - 1]?.id;
  const asksKey = threadId && newestId ? `${threadId}:${newestId}` : null;
  const [emailAsks, setEmailAsks] = useState<{ key: string; asks: AskChip[] | null } | null>(null);
  useEffect(() => {
    if (!replying || written || !threadId || !asksKey || emailAsks?.key === asksKey) return;
    setEmailAsks({ key: asksKey, asks: null });
    fetchEmailReplyAsks(threadId)
      .then((r) => setEmailAsks((cur) => (cur?.key === asksKey ? { key: asksKey, asks: r.asks } : cur)))
      .catch(() => setEmailAsks((cur) => (cur?.key === asksKey ? { key: asksKey, asks: AI_QUICK_ASKS } : cur)));
  }, [replying, written, threadId, asksKey, emailAsks?.key]);
  // The bar once there is a draft to change (ADR 0337): the chips that fit
  // this email first, then the style changes. Read off the message in code.
  const reviseAsks = useMemo(() => {
    const shape = replyShapeOf(detail?.messages ?? [], detail?.thread.subject ?? '');
    // The email's own chips already judged whether it is about a time.
    const timeChip = emailAsks?.asks?.some((a) => /suggest times/i.test(a.label)) ?? false;
    return reviseReplyAsks({ ...shape, aboutTime: shape.aboutTime || timeChip });
  }, [detail, emailAsks]);
  const [menu, setMenu] = useState<null | 'reply' | 'more'>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const headerHeight = useHeaderHeight();

  // Android's back button leaves the composer, not the email under it.
  useEffect(() => {
    if (!replying) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setReplying(false);
      return true;
    });
    return () => sub.remove();
  }, [replying]);

  const pickMode = (all: boolean) => {
    setReplyAll(all);
    // Mode switch re-derives; manual edits are reset on purpose.
    setToStr(null);
    setCcStr(null);
    setBccStr(null);
  };

  // The same switch once the composer is open (ADR 0320). Deliberately NOT
  // `pickMode`: mid-reply there may be a recipient the user typed or deleted,
  // and re-deriving the fields would throw it away. `applyReplyAll` only adds
  // the people a plain reply misses, and takes the same people out again.
  const toggleReplyAll = () => {
    const next = !replyAll;
    const merged = applyReplyAll({ to, cc }, latest, { replyAll: next, myEmail });
    setReplyAll(next);
    setToStr(merged.to.join(', '));
    setCcStr(merged.cc.join(', '));
  };

  // The open, mark-read, the read-time check and a sync each ask for a re-read
  // within seconds of each other. One at a time, and a request made while one
  // is running becomes a single re-read after it, so they cannot land out of
  // order or stack up.
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const loadRun = useRef<Promise<void> | null>(null);
  const loadAgain = useRef(false);
  const readOnce = useCallback(async () => {
    if (!threadId) return;
    try {
      // Taken before the request: a removal while it is in flight wins (ADR 0286).
      const fetchedAt = Date.now();
      const d = await getEmailThread(threadId);
      // router.replace to the next email reuses this screen: a late answer for
      // the one we left must not paint over it.
      if (currentThread.current !== threadId) return;
      setDetail(d);
      setGone(false);
      setOffline(false);
      openFailed.current = false;
      void storeThread(d, fetchedAt);
    } catch (e) {
      if (currentThread.current !== threadId) return;
      if ((e as Error).message === 'thread not found') {
        // Said plainly, and nothing of the old copy left on screen: a blank
        // page with a reply button reads as mail that failed to load.
        setGone(true);
        setDetail(null);
        void removeStoredThreads([threadId]);
      } else if (e instanceof GmailReconnectError) {
        setErr('Gmail disconnected - reconnect in Settings.');
      } else if (detailRef.current) {
        // A stored or warmed copy is on screen: say it may be stale rather
        // than covering it with a network error.
        setOffline(e instanceof SlowServerError ? 'slow' : 'offline');
      } else {
        openFailed.current = true;
        setErr((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  const load = useCallback((): Promise<void> => {
    if (loadRun.current) {
      loadAgain.current = true;
      return loadRun.current;
    }
    const run = (async () => {
      do {
        loadAgain.current = false;
        await readOnce();
      } while (loadAgain.current);
    })().finally(() => {
      loadRun.current = null;
    });
    loadRun.current = run;
    return run;
  }, [readOnce]);

  useEffect(() => {
    loadRun.current = null;
    loadAgain.current = false;
    void load();
  }, [load]);

  // Nothing warmed in memory: paint the phone's stored copy while the real
  // open (read-time check, mark-read) runs behind it.
  useEffect(() => {
    if (!threadId || detailRef.current) return;
    void readStoredThread(threadId).then((d) => {
      if (!d || currentThread.current !== threadId || detailRef.current) return;
      setDetail(d);
      setLoading(false);
      if (openFailed.current) {
        setErr(null);
        setOffline('offline');
      }
    });
  }, [threadId]);

  // Stream events arrive in bursts (one sync, several threads); one re-read covers them.
  const loadSoonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSoon = useCallback(() => {
    if (loadSoonTimer.current) clearTimeout(loadSoonTimer.current);
    loadSoonTimer.current = setTimeout(() => {
      loadSoonTimer.current = null;
      void load();
    }, 300);
  }, [load]);
  useEffect(
    () => () => {
      if (loadSoonTimer.current) clearTimeout(loadSoonTimer.current);
    },
    [],
  );

  // Every read mints a new image token, and the token is in every image URL:
  // adopting each one rebuilt the body and reloaded its images once per re-read.
  const heldToken = useRef<HeldImageToken | null>(null);
  heldToken.current = threadId
    ? holdImageToken(heldToken.current, threadId, detail?.imageToken, Date.now())
    : null;
  const imageToken = heldToken.current?.token ?? null;

  useFocusEffect(
    useCallback(() => {
      if (!threadId) return;
      let handle: StreamHandle | null = null;
      let cancelled = false;
      void openUserStream({
        onEmailThreadUpdated: (e) => {
          if (e.threadId === threadId) loadSoon();
        },
        // A new message in this thread arrives only as a sync (thread.updated
        // is sent for label/read changes), so a sync that changed nothing is
        // the one that needs no re-read.
        onEmailSynced: (r) => {
          if (r.inserted + r.updated + r.deleted > 0) loadSoon();
        },
      })
        .then((h) => {
          if (cancelled) h.close();
          else handle = h;
        })
        // The screen works without live updates; a failed open must not be an
        // unhandled rejection.
        .catch((e) => console.warn('[email-thread] live updates unavailable', e));
      return () => {
        cancelled = true;
        handle?.close();
      };
    }, [threadId, loadSoon]),
  );

  // Esc closes the thread on web (like the sheet's swipe-down) - but never
  // while typing, so a draft reply can't be lost to a stray keypress.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        leave();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [leave]),
  );

  // Older messages fold to one line; the newest opens (ADR 0121). A value
  // here is the reader's own choice and outranks that default.
  const [openMsgs, setOpenMsgs] = useState<Record<string, boolean>>({});

  // ADR 0250 — a thread with unread mail opens at it. Decided once, from the
  // state at opening: opening marks the thread read, and re-deciding after
  // the refresh would fold the new messages back up.
  const [openPlan, setOpenPlan] = useState<{
    threadId: string;
    open: Set<string>;
    /** Messages there at opening; one that arrives later opens, to be read. */
    known: Set<string>;
    scrollTo: string | null;
  } | null>(null);
  useEffect(() => {
    if (!threadId || !detail?.messages.length || openPlan?.threadId === threadId) return;
    if (detail.thread.id !== threadId) return;
    const plan = threadOpenPlan(detail.messages);
    setOpenPlan({
      threadId,
      open: new Set(plan.open),
      known: new Set(detail.messages.map((m) => m.id)),
      scrollTo: plan.scrollTo,
    });
  }, [threadId, detail, openPlan?.threadId]);
  const listRef = useRef<ScrollView>(null);
  const scrolledFor = useRef<string | null>(null);
  const messageY = useRef<Record<string, number>>({});
  const tryScroll = useCallback(() => {
    if (!threadId || openPlan?.threadId !== threadId || !openPlan.scrollTo) return;
    if (scrolledFor.current === threadId) return;
    const y = messageY.current[openPlan.scrollTo];
    if (y === undefined) return;
    scrolledFor.current = threadId;
    listRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
  }, [threadId, openPlan]);
  useEffect(() => {
    tryScroll();
  }, [tryScroll]);
  const isMessageOpen = useCallback(
    (id: string) => {
      const all = detail?.messages ?? [];
      const planned =
        openPlan?.threadId === threadId
          ? openPlan.open.has(id) || !openPlan.known.has(id)
          : all[all.length - 1]?.id === id;
      return openMsgs[id] ?? planned;
    },
    [detail?.messages, openPlan, threadId, openMsgs],
  );

  // Reading is message by message (kernel/src/email-auto-read.ts): each open
  // message is marked read once enough of it is on screen. A message sent from
  // here is not sent again, so a manual "Mark unread" sticks.
  const messageH = useRef<Record<string, number>>({});
  const scrollY = useRef(0);
  const viewportH = useRef(0);
  const readSent = useRef<{ threadId: string; ids: Set<string> } | null>(null);
  const readPending = useRef<Set<string>>(new Set());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRead = useCallback(() => {
    readTimer.current = null;
    const ids = [...readPending.current];
    readPending.current = new Set();
    if (!threadId || ids.length === 0) return;
    const forThread = threadId;
    // Quietly - this is not an action the user took, so it takes no busy state
    // and a failure must not raise an error over their mail. Patched in place:
    // re-fetching the thread to learn one flag was a second full open.
    void modifyEmailThread(forThread, { markRead: true, messageIds: ids })
      .then((summary) => {
        // The stored copy reads it too (ADR 0304).
        void applyThreadUpdate({
          userId: useApp.getState().user?.id ?? '',
          threadId: summary.id,
          isUnread: summary.isUnread,
          isArchived: summary.isArchived,
          labelIds: summary.labelIds,
        });
        const done = new Set(ids);
        setDetail((d) =>
          d && d.thread.id === summary.id
            ? {
                ...d,
                thread: {
                  ...d.thread,
                  ...summary,
                  chordLabelIds: summary.chordLabelIds ?? d.thread.chordLabelIds,
                },
                messages: d.messages.map((m) => (done.has(m.id) ? { ...m, isUnread: false } : m)),
              }
            : d,
        );
      })
      .catch((e) => {
        // Not over their mail, but not silent; the next scroll retries.
        console.warn('[email] mark message read failed', e);
        if (readSent.current?.threadId === forThread) for (const id of ids) readSent.current.ids.delete(id);
      });
  }, [threadId, setDetail]);
  const checkSeen = useCallback(() => {
    if (!threadId || !detail || detail.thread.id !== threadId) return;
    if (readSent.current?.threadId !== threadId) readSent.current = { threadId, ids: new Set() };
    const sent = readSent.current.ids;
    const boxes = detail.messages
      .filter((m) => messageY.current[m.id] !== undefined && messageH.current[m.id] !== undefined)
      .map((m) => ({ id: m.id, y: messageY.current[m.id], height: messageH.current[m.id] }));
    const ids = messagesToMarkRead(
      detail.messages,
      messagesOnScreen(boxes, scrollY.current, viewportH.current),
      isMessageOpen,
      sent,
    );
    if (ids.length === 0) return;
    for (const id of ids) {
      sent.add(id);
      readPending.current.add(id);
    }
    // One request for a fast scroll past several messages.
    if (!readTimer.current) readTimer.current = setTimeout(flushRead, 300);
  }, [threadId, detail, isMessageOpen, flushRead]);
  useEffect(() => {
    checkSeen();
  }, [checkSeen]);
  useEffect(
    () => () => {
      if (readTimer.current) {
        clearTimeout(readTimer.current);
        flushRead();
      }
    },
    [flushRead],
  );

  const scrollToMessage = useCallback(
    (id: string, y: number, height: number) => {
      messageY.current[id] = y;
      messageH.current[id] = height;
      tryScroll();
      checkSeen();
    },
    [tryScroll, checkSeen],
  );

  // ADR 0122. One button, three honest outcomes; the wording comes from the
  // server because only it knows which mechanism the sender offered.
  const [unsubMsg, setUnsubMsg] = useState<string | null>(null);
  const doUnsubscribe = useCallback(async () => {
    if (!threadId) return;
    setBusy('unsub');
    setUnsubMsg(null);
    try {
      const out = await unsubscribeEmailThread(threadId);
      setUnsubMsg(out.message);
      if (out.url) {
        if (Platform.OS === 'web') window.open(out.url, '_blank');
        else await Linking.openURL(out.url);
      }
      // Re-read so a recorded request shows on the button from now on.
      if (out.unsubscribed || out.requested) await load();
    } catch (e) {
      setUnsubMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [threadId, load]);

  // ADR 0234. The family chat, when there is one: sharing an email into it is
  // one tap from this menu, and the row only exists once there is somewhere
  // to share to.
  const [familyGroupId, setFamilyGroupId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getFamily()
      .then((f) => {
        if (!cancelled) setFamilyGroupId(f.groupId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const shareToFamily = useCallback(async () => {
    if (!threadId) return;
    setBusy('share');
    setUnsubMsg(null);
    try {
      const out = await shareEmailThreadToGroup(threadId);
      setUnsubMsg(`Shared to ${out.groupName}.`);
    } catch (e) {
      setUnsubMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [threadId]);

  // Only while the reply composer is open: a file dropped on an email being
  // read must not quietly attach itself to a reply nobody started.
  const attach = useEmailAttachments({ dropEnabled: replying });

  // ADR 0261 — "Summarize": asked for, never automatic, and forgotten when
  // the reader moves to another email.
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryFor = useRef(threadId);
  summaryFor.current = threadId;
  useEffect(() => {
    setSummary(null);
    setSummaryErr(null);
    setSummaryOpen(false);
  }, [threadId]);
  const summarize = useCallback(async () => {
    if (!threadId || summaryBusy) return;
    if (summary) {
      setSummaryOpen((o) => !o);
      return;
    }
    const forThread = threadId;
    setSummaryOpen(true);
    setSummaryBusy(true);
    setSummaryErr(null);
    try {
      const out = await summarizeEmailThread(forThread);
      if (forThread === summaryFor.current) setSummary(out.summary);
    } catch (e) {
      if (forThread === summaryFor.current) setSummaryErr((e as Error).message);
    } finally {
      setSummaryBusy(false);
    }
  }, [threadId, summary, summaryBusy]);

  // ADR 0120. Starts from the server's answer so the choice is the same on
  // every device; the local override is this reading only.
  const [showImagesOnce, setShowImagesOnce] = useState(false);
  const [blockedImages, setBlockedImages] = useState(0);
  const showImages = showImagesOnce || detail?.imagesAllowed === true;

  // Counted across the thread's messages, so one banner covers one decision.
  const onBlockedImages = useCallback((count: number) => {
    setBlockedImages((prev) => (count > prev ? count : prev));
  }, []);

  const allowSender = useCallback(async () => {
    const from = detail?.thread.fromEmail;
    if (!from) return;
    setShowImagesOnce(true);
    try {
      await setEmailImageSender({ email: from });
      // Re-read so `imagesAllowed` is the server's answer rather than an
      // optimistic guess the next open would contradict.
      await load();
    } catch {
      /* the images are showing either way; the permission just did not stick */
    }
  }, [detail, load]);

  // Print on the web, share on a phone: those are the two things the platform
  // actually does without a native print module (ADR 0121).
  const printable = useCallback(
    () => ({
      subject: detail?.thread.subject ?? '',
      messages: (detail?.messages ?? []).map((m) => ({
        from: m.fromName ? `${m.fromName} <${m.fromEmail ?? ''}>` : (m.fromEmail ?? 'Unknown'),
        dateLabel: shortDate(m.internalDate),
        to: m.toEmails ?? [],
        cc: m.ccEmails ?? [],
        sanitizedHtml: m.bodyHtml
          ? sanitizeEmailHtml(m.bodyHtml, { blockRemoteImages: !showImages })
          : null,
        text: m.bodyText ?? stripHtml(m.bodyHtml) ?? m.snippet ?? '',
      })),
    }),
    [detail, showImages],
  );

  const printOrShare = useCallback(async () => {
    const doc = printable();
    if (Platform.OS === 'web') {
      const w = window.open('', '_blank');
      if (!w) {
        setErr('Your browser blocked the print window.');
        return;
      }
      w.document.write(printableThreadHtml(doc));
      w.document.close();
      w.focus();
      w.print();
      return;
    }
    try {
      await Share.share({ message: threadToPlainText(doc), title: doc.subject });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [printable]);

  // A reply draft is keyed by its thread, so walking away and coming back
  // finds the same one rather than starting a second (ADR 0113).
  const restoreAttachments = attach.restore;
  const onRestoreDraft = useCallback(
    (d: EmailDraft) => {
      setReply(d.body);
      replyLoad(d.format, d.body, d.bodyHtml);
      // Only where they were edited: untouched recipients keep following the
      // message being answered.
      if (d.to.length) setToStr(d.to.join(', '));
      if (d.cc.length) setCcStr(d.cc.join(', '));
      if (d.bcc.length) setBccStr(d.bcc.join(', '));
      if (d.attachments?.length) restoreAttachments(d.attachments);
    },
    [restoreAttachments, replyLoad],
  );
  const emailWaiting = useEmailWaiting();
  const { draftId, handOff: handOffReply } = useDraftAutosave({
    kind: 'reply',
    threadId,
    onRestore: onRestoreDraft,
    signature,
    content: { to, cc, bcc, body: reply, attachmentIds: attach.ids, ...replyCompose.wire },
    // The recipients are pre-filled, so they alone are not something the
    // user wrote — saving them left an empty reply draft behind every thread
    // that was merely opened.
    enabled:
      written ||
      attach.ids.length > 0 ||
      toStr !== null ||
      ccStr !== null ||
      bccStr !== null,
  });

  // ADR 0197 — the ask is never sent; only what it writes into the reply box
  // is, and only once the user taps Send.
  const [aiAsk, setAiAsk] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  // Set only by the first draft of a Suggested reply (never by a typed ask or
  // a quick-ask chip, both of which the reader worded themselves) - clears the
  // moment the reader edits the box, so the banner never sits on their words.
  const [autoSuggested, setAutoSuggested] = useState(false);
  const compose = useCallback(
    async (instruction: string, opts?: { first?: boolean }) => {
      if (!threadId || !instruction.trim() || aiBusy) return;
      setAiBusy(true);
      setAiErr(null);
      try {
        // The model rewrites the message, never the signature under it; a
        // signature the user deleted stays deleted. Suggested writes from the
        // thread as it stands, not from a draft saved against older mail.
        const draft = aiDraftToRevise(reply, signature, { fresh: !!opts?.first });
        const out = await composeEmailReply(threadId, {
          instruction: instruction.trim(),
          ...(draft ? { draft } : {}),
        });
        setReply((cur) => placeAiReply(cur, out.body, signature));
        setAiAsk('');
        setAutoSuggested(!!opts?.first);
      } catch (e) {
        setAiErr((e as Error).message);
      } finally {
        setAiBusy(false);
      }
    },
    [threadId, reply, aiBusy, signature],
  );

  // A reply opens with the signature in it (ADR 0260 addendum). Only into an
  // empty box, and only on opening: a box the user emptied stays empty.
  useEffect(() => {
    if (replying && signature) setReply((cur) => (cur.trim() ? cur : bodyWithSignature('', signature)));
  }, [replying, signature]);

  // The reply menu's ways in. Forward is its own screen (ADR 0112); the rest
  // open the composer here, on whichever message is open.
  const startReply = (how: 'reply' | 'replyAll' | 'suggested' | 'resume') => {
    // A likely fake asking for replies elsewhere (ADR 0294 addendum): starting
    // a reply is confirmed first, and Cancel is the default.
    const risk = how === 'resume' ? null : replyToWarning(latest?.senderCheck);
    if (risk?.confirmBeforeReply) {
      // The reply menu is a Modal closing as this runs; iOS drops an alert
      // presented during that dismissal, so wait for it to finish.
      setTimeout(
        () =>
          confirmDestructive(
            'Reply to a likely fake?',
            risk.message,
            () => openReply(how),
            { confirmLabel: 'Reply anyway', cancelLabel: 'Cancel' },
          ),
        350,
      );
      return;
    }
    openReply(how);
  };

  const openReply = (how: 'reply' | 'replyAll' | 'suggested' | 'resume') => {
    if (how === 'reply' || how === 'replyAll') pickMode(how === 'replyAll');
    setSuggested(how === 'suggested');
    setShowOriginal(false);
    setReplying(true);
    // Always a new suggestion, replacing what is in the box: a saved draft may
    // answer an older message. Continue draft is the way back to it.
    if (how === 'suggested') {
      void compose('Write a brief, appropriate reply to this email.', { first: true });
    }
  };

  // A ref, not the busy state: a second tap in the same frame does not see
  // that state yet, and would send the message twice.
  const sendReplyGate = useRef(false);
  const sendReply = useCallback(
    () =>
      runExclusive(sendReplyGate, async () => {
        if (!threadId || !written) return;
        setBusy('reply');
        // One id for this Send, used by the direct attempt and by the Outbox if it
        // falls back there, so the server sends it once (ADR 0311 addendum).
        const sendId = newSendId();
        setErr(null);
        try {
          // An earlier email still waits in the Outbox: this reply joins the line
          // behind it rather than overtaking it (ADR 0311 addendum).
          if (emailWaiting) throw new OfflineError();
          const d = await replyEmailThread(threadId, {
            body: reply.trim(),
            ...replyCompose.wire,
            ...(to.length ? { to } : {}),
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
            ...(attach.ids.length ? { attachmentIds: attach.ids } : {}),
            ...(latest ? { messageId: latest.id } : {}),
            ...(draftId ? { draftId } : {}),
          }, sendId);
          setDetail(d);
          setReplyToId(null);
          setReply('');
          setAutoSuggested(false);
          setToStr(null);
          setCcStr(null);
          setBccStr(null);
          setReplying(false);
          attach.clear();
        } catch (e) {
          if (!(e instanceof OfflineError)) {
            setErr((e as Error).message);
            return;
          }
          // No network (ADR 0311): the reply waits in the Outbox and goes,
          // through this same call, when the server answers again.
          try {
            await queueEmail({
              kind: 'reply',
              threadId,
              to,
              cc,
              bcc,
              body: reply.trim(),
              ...replyCompose.wire,
              attachmentIds: attach.ids,
              messageId: latest?.id ?? null,
              draftId: draftId ?? null,
            }, sendId);
            await handOffReply();
            setReplyToId(null);
            setReply('');
            setAutoSuggested(false);
            setToStr(null);
            setCcStr(null);
            setBccStr(null);
            setReplying(false);
            attach.clear();
            showAlert('In your Outbox', outboxNotice());
          } catch (qe) {
            setErr((qe as Error).message);
          }
        } finally {
          setBusy(null);
        }
      }),
    [threadId, reply, written, to, cc, bcc, attach, draftId, latest, handOffReply, emailWaiting],
  );

  const doModify = useCallback(
    async (
      patch: {
        markRead?: boolean;
        archive?: boolean;
        trash?: true;
        applyCategoryLabel?: boolean;
        addChordLabels?: string[];
        removeChordLabels?: string[];
      },
      key: 'read' | 'archive' | 'trash' | 'label' | 'chord',
    ) => {
      if (!threadId) return;
      if (patch.archive || patch.trash) {
        // ADR 0218 - leave at once and let the mailbox catch up: the provider
        // round trip no longer sits between the tap and the next email. A
        // refusal releases the row, so the list shows it again and says why.
        // In a walk the earlier ones were already read: after the last, the
        // walk is over, and it never goes back to one of them.
        const target = afterRemove === 'next' && threadId ? afterRemoveTarget(walk, threadId) : null;
        const nav = useEmailThreadNav.getState();
        nav.setRemoveError(null);
        nav.startRemoving([threadId]);
        const id = threadId;
        void modifyEmailThread(id, patch)
          .then(() => useEmailThreadNav.getState().doneRemoving([id]))
          .catch((e) => {
            nav.setRemoveError((e as Error).message);
            useEmailThreadNav.getState().doneRemoving([id], [id]);
          });
        if (target) goToThread(target);
        else leave();
        return;
      }
      if (patch.markRead === false && detail?.thread.id === threadId) {
        // Marked unread on purpose: scrolling must not mark any of these read
        // again. Only a message that arrives later is.
        readSent.current = { threadId, ids: new Set(detail.messages.map((m) => m.id)) };
      }
      setBusy(key);
      setErr(null);
      try {
        const summary = await modifyEmailThread(threadId, patch);
        // Optimistic chip state from the modify response; full reload for bodies.
        setDetail((d) =>
          d
            ? {
                ...d,
                thread: {
                  ...d.thread,
                  ...summary,
                  chordLabelIds: summary.chordLabelIds ?? [],
                },
              }
            : d,
        );
        if (key !== 'chord') await load();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [threadId, detail, load, afterRemove, walk, goToThread, leave],
  );

  /**
   * The route header, or the pane's own when embedded: the list screen owns
   * `Stack.Screen` there, and two option sets in one route fight over it.
   */
  const screenHeader = (opts: {
    title?: string;
    headerLeft?: () => ReactNode;
    headerRight?: () => ReactNode;
    headerBackVisible?: boolean;
  }) =>
    embedded ? (
      <PaneHeader title={opts.title} left={opts.headerLeft} right={opts.headerRight} />
    ) : (
      <Stack.Screen options={opts} />
    );

  const threadNavHeader = (
    <View style={styles.headerRight}>
      <Pressable
        onPress={goPrev}
        disabled={!hasPrev}
        hitSlop={8}
        accessibilityLabel="Previous email"
        style={[styles.navBtn, !hasPrev && styles.navBtnDisabled]}
      >
        <Icon name="chevron-up" size={26} />
      </Pressable>
      <Pressable
        onPress={() => void goNext()}
        disabled={!hasNext || navBusy}
        hitSlop={8}
        accessibilityLabel="Next email"
        style={[styles.navBtn, (!hasNext || navBusy) && styles.navBtnDisabled]}
      >
        {navBusy ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Icon name="chevron-down" size={26} />
        )}
      </Pressable>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        {screenHeader({ title: 'Thread', headerRight: () => threadNavHeader, headerLeft: embedded ? undefined : backHomeHeaderLeft('Email', '/email') })}
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (gone) {
    return (
      <View style={[styles.screen, styles.center]}>
        {screenHeader({ title: '', headerRight: () => threadNavHeader, headerLeft: embedded ? undefined : backHomeHeaderLeft('Email', '/email') })}
        <Text style={styles.goneTitle}>This email is no longer in your mailbox</Text>
        <Text style={styles.goneTxt}>It was deleted since this list was last updated.</Text>
        <Pressable onPress={leave} hitSlop={8}>
          <Text style={styles.goneBack}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (replying) {
    const canSend = written && to.length > 0 && busy !== 'reply';
    // Switching audience without leaving the composer (ADR 0320): the only way
    // in used to be the reader's reply menu, which the composer replaces. Shown
    // only when reply-all would actually widen it - a one-to-one email has
    // nobody to add, and a button that changes nothing is worse than none.
    const canReplyAll = replyAll || replyAllAdds(latest, myEmail).length > 0;
    // It lives on the Cc line, because Cc is the field it fills - so that line
    // is on screen whenever reply-all is possible, empty but labelled. Bcc
    // stays behind the link: nothing here offers to fill it.
    const ccVisible = showCcBcc || cc.length > 0 || canReplyAll;
    const bccVisible = showCcBcc || bcc.length > 0;
    const subject = detail?.thread.subject || '(no subject)';
    const asks = written
      ? reviseAsks
      : emailAsks?.key === asksKey
        ? (emailAsks.asks ?? [])
        : AI_QUICK_ASKS;
    return (
      <KeyboardScreen style={cs.screen} headerHeight={headerHeight}>
        {screenHeader(
          composeHeaderOptions({
            title: suggested ? 'Suggested reply' : replyAll ? 'Reply all' : 'Reply',
            onCancel: () => setReplying(false),
            actions: [
              {
                key: 'attach',
                icon: 'paperclip',
                label: 'Attach a file',
                onPress: () => void attach.pick(),
                busy: attach.busy,
              },
            ],
            canSend,
            sending: busy === 'reply',
            onSend: () => void sendReply(),
          }),
        )}

        <View style={cs.fld}>
          <Text style={cs.fldLabel}>To:</Text>
          <TextInput
            style={cs.fldInput}
            value={toStr ?? to.join(', ')}
            onChangeText={setToStr}
            placeholder="name@example.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          {!ccVisible || !bccVisible ? (
            <Pressable onPress={() => setShowCcBcc(true)} hitSlop={8}>
              <Text style={cs.fldLink}>{ccVisible ? 'Bcc' : 'Cc/Bcc'}</Text>
            </Pressable>
          ) : null}
        </View>
        {[
          ...(ccVisible
            ? [{ label: 'Cc:', value: ccStr ?? cc.join(', '), set: setCcStr, all: canReplyAll }]
            : []),
          ...(bccVisible
            ? [{ label: 'Bcc:', value: bccStr ?? bcc.join(', '), set: setBccStr, all: false }]
            : []),
        ].map((f) => (
          <View key={f.label} style={cs.fld}>
            <Text style={cs.fldLabel}>{f.label}</Text>
            <TextInput
              style={cs.fldInput}
              value={f.value}
              onChangeText={f.set}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            {f.all ? (
              <Pressable
                onPress={toggleReplyAll}
                hitSlop={8}
                accessibilityLabel={replyAll ? 'Reply to the sender only' : 'Reply all'}
              >
                <Text style={[cs.fldLink, replyAll && styles.replyAllOn]}>
                  {replyAll ? 'Sender only' : 'Reply all'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        <View style={cs.fld}>
          <Text style={cs.fldLabel}>Subject:</Text>
          <Text style={cs.fldStatic} numberOfLines={1}>
            {/^re:/i.test(subject) ? subject : `Re: ${subject}`}
          </Text>
        </View>

        {attach.files.length > 0 || attach.err || attach.busy ? (
          <View style={cs.attach}>
            <EmailAttachments
              files={attach.files}
              onPick={() => void attach.pick()}
              onRemove={attach.remove}
              busy={attach.busy}
              err={attach.err}
              hidePick
            />
          </View>
        ) : null}

        {autoSuggested && !aiBusy ? (
          <Text style={styles.autoSuggestedLabel}>Suggested by Chord. Edit it, or send as is.</Text>
        ) : null}
        {aiBusy ? <AskWriting /> : null}

        <FormatSwitch value={replyCompose.format} onChange={replyCompose.choose} />
        <OutdatedSignatureNote body={reply} signature={signature} onChange={setReply} />
        <ComposeBodyEditor
          compose={replyCompose}
          placeholder="Write your reply"
          plain={
            <TextInput
              ref={replyCaret.ref}
              onFocus={replyCaret.onFocus}
              onBlur={replyCaret.onBlur}
              style={cs.body}
              value={reply}
              onChangeText={(t) => {
                setReply(t);
                setAutoSuggested(false);
              }}
              placeholder="Write your reply"
              placeholderTextColor={colors.muted}
              multiline
              autoFocus
              textAlignVertical="top"
            />
          }
        />

        {err ? <Text style={cs.err}>{err}</Text> : null}

        {latest ? (
          <View style={styles.orig}>
            <Pressable
              style={styles.origHead}
              onPress={() => setShowOriginal((v) => !v)}
              accessibilityLabel="Show the message you are answering"
            >
              <Icon
                name={showOriginal ? 'chevron-down' : 'chevron-up'}
                size={18}
                color={colors.muted}
              />
              <Text style={styles.origHeadTxt} numberOfLines={1}>
                Answering{' '}
                {latest.sent ? 'your message' : (latest.fromName ?? latest.fromEmail ?? 'Unknown')}
                {' · '}
                {shortDate(latest.internalDate)}
              </Text>
            </Pressable>
            {showOriginal ? (
              <ScrollView style={styles.origScroll}>
                <Text style={styles.origTxt}>
                  {latest.bodyText?.trim() || stripHtml(latest.bodyHtml) || latest.snippet || ''}
                </Text>
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        <AskBar
          hasDraft={written}
          chips={asks}
          value={aiAsk}
          onChangeText={setAiAsk}
          onAsk={(q) => void compose(q)}
          busy={aiBusy}
          err={aiErr}
          placeholder={
            written ? '"add that I\'ll bring snacks"' : '"say yes, ask about parking"'
          }
        />
        <FileDropOverlay visible={attach.dragging} />
      </KeyboardScreen>
    );
  }

  const labels = detail?.thread.chordLabelIds ?? [];
  const manyMessages = (detail?.messages.length ?? 0) > 1;
  const answeringHint =
    manyMessages && latest
      ? `${latest.sent ? 'Your message' : (latest.fromName ?? latest.fromEmail ?? 'Unknown')} · ${shortDate(latest.internalDate)}`
      : undefined;

  // Forward passes on the message selected in the thread (the one opened
  // last), else the newest - which may be your own (ADR 0112 addendum).
  const forwardTarget =
    (replyToId ? detail?.messages.find((m) => m.id === replyToId) : undefined) ??
    detail?.messages[detail.messages.length - 1];
  const forwardHint =
    manyMessages && forwardTarget
      ? `${forwardTarget.sent ? 'Your message' : (forwardTarget.fromName ?? forwardTarget.fromEmail ?? 'Unknown')} · ${shortDate(forwardTarget.internalDate)}`
      : undefined;

  const replyRows: SheetRow[] = [
    ...(written
      ? [
          {
            key: 'resume',
            icon: 'pencil-outline' as const,
            label: 'Continue draft',
            onPress: () => startReply('resume'),
          },
        ]
      : []),
    {
      key: 'reply',
      icon: 'reply',
      label: 'Reply',
      hint: answeringHint,
      onPress: () => startReply('reply'),
    },
    { key: 'replyAll', icon: 'reply-all', label: 'Reply all', onPress: () => startReply('replyAll') },
    {
      key: 'forward',
      icon: 'share',
      label: 'Forward',
      hint: forwardHint,
      onPress: () =>
        router.push(
          forwardTarget
            ? `/email/forward/${threadId}?message=${encodeURIComponent(forwardTarget.id)}`
            : `/email/forward/${threadId}`,
        ),
    },
    {
      key: 'suggested',
      icon: 'creation-outline',
      label: 'Suggested',
      hint: 'Chord drafts it, you review and send',
      onPress: () => startReply('suggested'),
    },
  ];

  const moreRows: SheetRow[] = [
    {
      key: 'archive',
      icon: 'archive-outline',
      label: 'Archive',
      onPress: () => void doModify({ archive: true }, 'archive'),
    },
    {
      key: 'read',
      icon: detail?.thread.isUnread ? 'email-open-outline' : 'email-mark-as-unread',
      label: detail?.thread.isUnread ? 'Mark read' : 'Mark unread',
      onPress: () => void doModify({ markRead: !!detail?.thread.isUnread }, 'read'),
    },
    {
      key: 'share',
      icon: Platform.OS === 'web' ? 'printer-outline' : 'export-variant',
      label: Platform.OS === 'web' ? 'Print' : 'Share',
      onPress: () => void printOrShare(),
    },
    ...(familyGroupId
      ? [
          {
            key: 'family',
            icon: 'account-group-outline' as const,
            label: 'Share to family chat',
            onPress: () => void shareToFamily(),
          },
        ]
      : []),
    ...(detail?.unsubscribe
      ? [
          {
            key: 'unsub',
            icon: 'email-off-outline' as const,
            label: detail.unsubscribe.requestedAt ? 'Unsubscribe again' : 'Unsubscribe',
            onPress: () => void doUnsubscribe(),
          },
        ]
      : []),
    ...(detail?.providerLink
      ? [
          {
            // ADR 0107 — filing lives in the provider, so this is the way there.
            key: 'provider',
            icon: 'open-in-new' as const,
            label: detail.providerLink.label,
            onPress: () => {
              const link = detail.providerLink!;
              if (Platform.OS === 'web') window.open(link.url, '_blank');
              else void Linking.openURL(link.url);
            },
          },
        ]
      : []),
  ];

  return (
    <View style={styles.screen}>
      {screenHeader({
        // The subject is the first line of the page, in full; a clipped copy
        // of it in the header only pushed the mail down.
        title: '',
        headerBackVisible: true,
        headerLeft: embedded ? undefined : backHomeHeaderLeft('Email', '/email'),
        headerRight: () => threadNavHeader,
      })}

      <ScrollView
        {...DISMISS_KEYBOARD_ON_DRAG}
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        scrollEventThrottle={100}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          checkSeen();
        }}
        onLayout={(e) => {
          viewportH.current = e.nativeEvent.layout.height;
          checkSeen();
        }}
      >
        <Text style={styles.subject}>
          {hasFile ? (
            <MaterialCommunityIcons name="paperclip" size={16} color={colors.muted} accessibilityLabel="Has attachment" />
          ) : null}
          {hasFile ? ' ' : ''}
          {detail?.thread.subject || '(no subject)'}
        </Text>
        <Pressable
          style={[styles.summarizeBtn, summaryOpen && styles.summarizeBtnOn]}
          onPress={() => void summarize()}
          disabled={!detail || summaryBusy}
          accessibilityRole="button"
          accessibilityLabel="Summarize this email"
        >
          {summaryBusy ? (
            <ActivityIndicator size="small" color={summaryTone().fg} />
          ) : (
            <Icon name="creation" size={16} color={summaryTone().fg} />
          )}
          <Text style={styles.summarizeTxt}>
            {summaryBusy ? 'tldr…' : summary && summaryOpen ? 'Hide tldr' : 'tldr'}
          </Text>
        </Pressable>
        {summaryOpen && (summary || summaryErr) ? (
          <View style={[styles.summaryCard, summaryErr ? styles.summaryCardErr : null]}>
            {summary ? (
              <>
                <Text style={styles.summaryHead}>✨ tldr</Text>
                <Text style={styles.summaryTxt} selectable>
                  {summary}
                </Text>
              </>
            ) : (
              <Text style={styles.summaryErrTxt}>{summaryErr}</Text>
            )}
          </View>
        ) : null}
        <View style={styles.labelRow}>
          {labels.map((name) => (
            <View key={name} style={styles.labelChip}>
              <Text style={styles.labelChipTxt}>{name}</Text>
            </View>
          ))}
          <Pressable
            style={styles.labelBtn}
            onPress={() => setLabelsOpen(true)}
            hitSlop={6}
            accessibilityLabel="Add or remove labels"
          >
            <Icon name="tag-outline" size={15} color={colors.muted} />
            <Text style={styles.labelBtnTxt}>Label</Text>
          </Pressable>
        </View>
        {detail?.readAdvisory ? (
          <View style={styles.advisoryBanner}>
            <Text style={styles.advisoryTxt}>⚠️ {detail.readAdvisory.note}</Text>
          </View>
        ) : null}
        {!showImages && blockedImages > 0 ? (
          <View style={styles.imgBanner}>
            <Text style={styles.imgBannerTxt}>
              {blockedImages === 1
                ? '1 image not loaded'
                : `${blockedImages} images not loaded`}
            </Text>
            <View style={styles.imgBannerActions}>
              <Pressable onPress={() => setShowImagesOnce(true)} hitSlop={6}>
                <Text style={styles.imgBannerBtn}>Show</Text>
              </Pressable>
              {detail?.thread.fromEmail ? (
                <Pressable onPress={() => void allowSender()} hitSlop={6}>
                  <Text style={styles.imgBannerBtn}>Always</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
        {detail?.flight || detail?.tracking ? (
          <View style={styles.trackRow}>
            {/* ADR 0138 — an airline we cannot name has no url, and the number
                on its own is still worth reading. */}
            {detail.flight ? (
              detail.flight.url ? (
                <LinkChip
                  url={detail.flight.url}
                  label={`Track ${detail.flight.iata}`}
                  icon="✈️"
                />
              ) : (
                <Text style={styles.trackTxt}>✈️ {detail.flight.iata}</Text>
              )
            ) : null}
            {detail.tracking ? (
              <LinkChip
                url={detail.tracking.url}
                label={`Track · ${detail.tracking.carrier}`}
                icon="📦"
              />
            ) : null}
          </View>
        ) : null}
        {(detail?.thread.magics ?? [])
          .filter((m) => !dismissed.has(m.proposalId))
          .map((m) => (
            <MagicCard
              key={m.proposalId}
              magic={m}
              wide
              onDismissed={(pid) => setDismissed((s) => new Set(s).add(pid))}
            />
          ))}
        {(detail?.messages ?? []).map((m, i, all) => {
          const open = isMessageOpen(m.id);
          return (
            <View
              key={m.id}
              onLayout={(e) => scrollToMessage(m.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
            >
            <MessageCard
              msg={m}
              open={open}
              mailboxEmail={detail?.mailboxEmail ?? null}
              // A single-message thread has nothing to fold away.
              onToggle={
                all.length > 1
                  ? () => {
                      setOpenMsgs((prev) => ({ ...prev, [m.id]: !open }));
                      // The bar answers the message you opened last; folding
                      // that one hands it back to the default.
                      const next = open ? (replyToId === m.id ? null : replyToId) : m.id;
                      if (next !== replyToId) {
                        setReplyToId(next);
                        setToStr(null);
                        setCcStr(null);
                        setBccStr(null);
                      }
                    }
                  : undefined
              }
              showRemoteImages={showImages}
              imageToken={imageToken}
              onBlockedImages={onBlockedImages}
              answering={all.length > 1 && latest?.id === m.id}
            />
            </View>
          );
        })}
        {written && detail ? (
          // ADR 0338: an unsent reply shows in its thread, not only in Drafts.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue your draft reply"
            onPress={() => startReply('resume')}
            style={styles.draftCard}
          >
            <Text style={styles.draftTag}>Draft</Text>
            {to.length ? (
              <Text style={styles.draftTo} numberOfLines={1}>
                To {to.join(', ')}
              </Text>
            ) : null}
            <Text style={styles.draftText} numberOfLines={4}>
              {splitSignature(reply, signature).main.trim()}
            </Text>
          </Pressable>
        ) : null}
        {unsubMsg ? <Text style={styles.unsubMsg}>{unsubMsg}</Text> : null}
        {offline ? (
          <Text style={styles.unsubMsg}>
            {offline === 'slow'
              ? 'Your mailbox is slow to answer - showing the copy saved on this phone.'
              : 'No connection - showing the copy saved on this phone.'}
          </Text>
        ) : null}
        {err ? <Text style={styles.err}>{err}</Text> : null}
      </ScrollView>

      <ReaderBar
        disabled={!detail}
        onTrash={() => void doModify({ trash: true }, 'trash')}
        onMore={() => setMenu('more')}
        onReply={() => setMenu('reply')}
      />
      <ActionSheet open={menu === 'reply'} rows={replyRows} onClose={() => setMenu(null)} />
      <ActionSheet open={menu === 'more'} rows={moreRows} onClose={() => setMenu(null)} />
      <EmailLabelSheet
        open={labelsOpen}
        onClose={() => setLabelsOpen(false)}
        labels={labels}
        busy={busy !== null}
        onAdd={(name) => void doModify({ addChordLabels: [name] }, 'chord')}
        onRemove={(name) => void doModify({ removeChordLabels: [name] }, 'chord')}
        onApplyCategory={
          detail?.thread.categoryId
            ? () => {
                setLabelsOpen(false);
                void doModify({ applyCategoryLabel: true }, 'label');
              }
            : undefined
        }
      />
    </View>
  );
}

function summaryTone(): { bg: string; fg: string; errBg: string } {
  return byScheme(
    { bg: '#EEF2FF', fg: '#4338CA', errBg: '#FEF2F2' },
    { bg: '#1E2140', fg: '#A5B4FC', errBg: colors.redBg },
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  goneTitle: { color: colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  goneTxt: { color: colors.muted, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  goneBack: { color: colors.accent, fontSize: 15, fontWeight: '600', marginTop: 18 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  navBtn: { paddingHorizontal: 4, paddingVertical: 4, minWidth: 28, alignItems: 'center' },
  navBtnDisabled: { opacity: 0.3 },
  list: { flex: 1 },
  // The bottom padding clears the floating bar, so the last line of the last
  // message can be scrolled out from under it.
  listContent: { padding: 14, gap: 12, paddingBottom: 96 },
  subject: { color: colors.text, fontSize: 18, fontWeight: '700' },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: -4 },
  labelChip: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: colors.accentLight,
  },
  labelChipTxt: { color: colors.accentDark, fontSize: 12, fontWeight: '600' },
  labelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  labelBtnTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  summarizeBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    backgroundColor: summaryTone().bg,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  summarizeBtnOn: { borderWidth: 1, borderColor: summaryTone().fg },
  summarizeTxt: { color: summaryTone().fg, fontSize: 13, fontWeight: '700' },
  summaryCard: {
    backgroundColor: summaryTone().bg,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  summaryCardErr: { backgroundColor: summaryTone().errBg },
  summaryHead: { color: summaryTone().fg, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  summaryTxt: { color: colors.text, fontSize: 14, lineHeight: 20 },
  summaryErrTxt: { color: colors.red, fontSize: 13 },
  msg: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  msgAnswering: { borderColor: colors.accent },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  msgFolded: { paddingVertical: 9, backgroundColor: colors.bg2 },
  unsubMsg: { color: colors.muted, fontSize: 13, marginTop: 4 },
  draftCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    gap: 4,
  },
  draftTag: { color: colors.red, fontSize: 13, fontWeight: '700' },
  draftTo: { color: colors.muted, fontSize: 12 },
  draftText: { color: colors.text, fontSize: 14 },
  msgFoldedTxt: { color: colors.muted, fontSize: 13 },
  attRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  attChip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  attChipTxt: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  attErr: { color: colors.red, fontSize: 12, marginTop: 6 },
  msgFrom: { color: colors.text, fontSize: 14, fontWeight: '600' },
  msgFromCol: { flex: 1, minWidth: 0 },
  msgFromTap: { paddingRight: 8 },
  tapToText: { alignSelf: 'flex-start', maxWidth: '100%' },
  msgFromAddr: { color: colors.muted, fontSize: 12 },
  msgTime: { color: colors.muted, fontSize: 12 },
  msgRcpt: { color: colors.muted, fontSize: 12, marginBottom: 4 },
  err: { color: colors.red, fontSize: 13 },
  trackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  trackTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  imgBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  imgBannerTxt: { color: colors.muted, fontSize: 12, flex: 1 },
  advisoryBanner: { backgroundColor: colors.warnBg, borderRadius: 8, padding: 10 },
  advisoryTxt: { color: colors.warn, fontSize: 13, fontWeight: '600' },
  imgBannerActions: { flexDirection: 'row', gap: 14 },
  imgBannerBtn: { color: colors.accent, fontSize: 13, fontWeight: '700' },

  orig: { borderTopWidth: 1, borderTopColor: colors.border },
  origHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  origHeadTxt: { flex: 1, color: colors.muted, fontSize: 12, fontWeight: '600' },
  origScroll: { maxHeight: 150, paddingHorizontal: 16, marginBottom: 8 },
  origTxt: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  // 'Reply all' / 'Sender only' on the Cc line, lit while reply-all is on.
  replyAllOn: { color: colors.accent, fontWeight: '600' },
  // The first draft came from Chord, not the reader - say so until it's edited.
  autoSuggestedLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
}));
