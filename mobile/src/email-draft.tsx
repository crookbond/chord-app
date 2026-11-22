/**
 * Autosaving what you were writing (ADR 0113).
 *
 * The debounce is the whole design. Saving per keystroke would be a request per
 * character; saving only on unmount loses the case autosave exists for, which
 * is the app being killed rather than left. So: quiet for a second and a half,
 * then save — and save again on the way out.
 *
 * A draft is deliberately NOT saved until there is something in it. An empty
 * composer opened and closed should leave no trace, or the Drafts list fills
 * with blanks nobody wrote.
 *
 * Saving is half of a draft; the other half is finding it again. A reply or a
 * forward has one draft per thread, so the composer asks for it when it opens
 * and hands it to the screen through `onRestore`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  draftAutosaveDelay,
  isOnlySignature,
  serialRerun,
  type EmailDraft,
  type EmailBodyFormat,
  type EmailDraftKind,
} from '@chord/kernel';

import { deleteEmailDraft, getEmailDraft, getEmailThreadDraft, saveEmailDraft } from '@/api';
import {
  findPhoneDraft,
  keepDraftOnPhone,
  localDraftKey,
  markDraftOpen,
  removePhoneDraft,
  savePhoneDraft,
  type LocalEmailDraft,
} from '@/email-outbox';
import { onNetworkChange } from '@/network';


export interface DraftContent {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachmentIds?: string[];
  /** Forward only: the message passed on. Not "written", so not in isEmpty. */
  forwardMessageId?: string | null;
  /** ADR 0339: how it is being written; rich carries the editor's HTML. */
  format?: EmailBodyFormat;
  bodyHtml?: string | null;
}

/** A draft kept on the phone, in the shape the composers restore from. Its
 *  files' names were not kept, so they show under a placeholder. */
function phoneDraftAsDraft(d: LocalEmailDraft): EmailDraft {
  return {
    id: d.serverId ?? '',
    kind: d.kind,
    threadId: d.threadId ?? null,
    accountId: d.accountId ?? null,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject ?? '',
    body: d.body ?? '',
    ...(d.format ? { format: d.format, bodyHtml: d.bodyHtml ?? null } : {}),
    attachmentIds: d.attachmentIds,
    attachments: d.attachmentIds.map((id) => ({ id, filename: 'Attached file', size: 0 })),
    updatedAt: d.updatedAt,
    preview: '',
    forwardMessageId: d.forwardMessageId ?? null,
  };
}

/** Nothing written yet. A body holding only the signature the composer opened
 *  with counts as empty: the user has not written anything. */
function isEmpty(c: DraftContent, signature?: string | null): boolean {
  return (
    !c.to?.length &&
    !c.cc?.length &&
    !c.bcc?.length &&
    !c.subject?.trim() &&
    isOnlySignature(c.body ?? '', signature) &&
    !c.attachmentIds?.length
  );
}

export function useDraftAutosave(opts: {
  kind: EmailDraftKind;
  threadId?: string | null;
  accountId?: string | null;
  /** Existing draft being resumed, so the first save updates it. */
  initialId?: string | null;
  content: DraftContent;
  /** Off once the message has actually gone, so the send's own cleanup wins. */
  enabled?: boolean;
  /** Called once with the saved draft this composer should start from. */
  onRestore?: (draft: EmailDraft) => void;
  /** The saved draft could not be read. */
  onRestoreError?: () => void;
  /** The signature the composer opened with; a body of only that is empty. */
  signature?: string | null;
  /** Reopen a draft that only exists on this phone (ADR 0311), by its key. */
  phoneKey?: string | null;
}) {
  const { kind, threadId, accountId, initialId, content, enabled = true } = opts;
  // Where this composer's draft is kept on the phone when the server cannot
  // take it. Fixed for the composer's life, so every save lands on one copy.
  const composerId = useRef(Math.random().toString(36).slice(2, 10)).current;
  const phoneKey = useRef(
    opts.phoneKey ?? localDraftKey({ kind, threadId, serverId: initialId, composerId }),
  ).current;
  const savedOnPhone = useRef(false);
  // Set once the message itself went to the Outbox: from then on nothing is
  // saved, here or on the server - until the composer holds something new (a
  // reader can write a second reply to the same thread).
  const handedOff = useRef(false);
  const handedOffContent = useRef<string | null>(null);
  const signatureRef = useRef(opts.signature);
  signatureRef.current = opts.signature;
  const [draftId, setDraftId] = useState<string | null>(initialId ?? null);
  // Latest content, read by the save that fires later. A ref rather than a
  // dependency so the timer is not rebuilt on every keystroke.
  const latest = useRef(content);
  latest.current = content;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const idRef = useRef(draftId);
  idRef.current = draftId;
  // Set by Delete draft. A ref, because the save on the way out reads it
  // before any re-render could carry a state change.
  const discarded = useRef(false);
  const onRestore = useRef(opts.onRestore);
  onRestore.current = opts.onRestore;
  const onRestoreError = useRef(opts.onRestoreError);
  onRestoreError.current = opts.onRestoreError;

  useEffect(() => markDraftOpen(phoneKey), [phoneKey]);

  useEffect(() => {
    let cancelled = false;
    const fromServer = () =>
      initialId
        ? getEmailDraft(initialId)
        : kind !== 'new' && threadId
          ? getEmailThreadDraft(threadId, kind)
          : null;
    // A copy kept on the phone is newer than the server's: it exists only
    // because a later save could not reach the server.
    const found: Promise<EmailDraft | null> = findPhoneDraft(phoneKey).then((local) => {
      if (local) {
        savedOnPhone.current = true;
        return phoneDraftAsDraft(local);
      }
      return fromServer();
    });
    found
      .then((d) => {
        if (cancelled || !d || discarded.current) return;
        if (d.id) {
          idRef.current = d.id;
          setDraftId(d.id);
        }
        // Never over something already typed here: this sitting is newer than
        // the saved one.
        if (enabledRef.current && !isEmpty(latest.current, signatureRef.current) && !initialId) return;
        onRestore.current?.(d);
      })
      .catch(() => {
        if (!cancelled && initialId) onRestoreError.current?.();
      });
    return () => {
      cancelled = true;
    };
  }, [kind, threadId, initialId, phoneKey]);

  const saveOnce = useCallback(async (): Promise<string | null> => {
    const c = latest.current;
    if (handedOff.current || discarded.current || !enabledRef.current || isEmpty(c, signatureRef.current)) {
      return idRef.current;
    }
    try {
      const saved = await saveEmailDraft({
        ...(idRef.current ? { id: idRef.current } : {}),
        kind,
        ...(threadId ? { threadId } : {}),
        ...(accountId ? { accountId } : {}),
        ...c,
      });
      if (discarded.current) {
        // Deleted while this save was in the air; it must not bring it back.
        void deleteEmailDraft(saved.id).catch(() => {});
        return null;
      }
      idRef.current = saved.id;
      setDraftId(saved.id);
      if (savedOnPhone.current) {
        savedOnPhone.current = false;
        void removePhoneDraft(phoneKey);
      }
      return saved.id;
    } catch (e) {
      // The server could not be reached (ADR 0311): keep it on the phone, and
      // upload it once the server answers. A refusal would only fail again,
      // and surfacing either would put an error on screen mid-sentence.
      if (keepDraftOnPhone(e) && !handedOff.current && !discarded.current) {
        savedOnPhone.current = true;
        await savePhoneDraft({
          key: phoneKey,
          serverId: idRef.current,
          kind,
          threadId: threadId ?? null,
          accountId: accountId ?? null,
          to: c.to ?? [],
          cc: c.cc ?? [],
          bcc: c.bcc ?? [],
          subject: c.subject,
          body: c.body,
          ...(c.format ? { format: c.format, bodyHtml: c.bodyHtml ?? null } : {}),
          attachmentIds: c.attachmentIds ?? [],
          ...(c.forwardMessageId !== undefined ? { forwardMessageId: c.forwardMessageId } : {}),
        });
      }
      return idRef.current;
    }
  }, [kind, threadId, accountId, phoneKey]);

  // The debounce, the way out, a network change and saveNow (Send) can all
  // fire together. Two requests in the air made two drafts of a new message
  // (neither had an id yet) or let an older body land last; so one save runs
  // at a time, and a call meanwhile runs once more after it, with the id the
  // first one got and the latest content.
  const save = useMemo(() => serialRerun(saveOnce), [saveOnce]);

  // Back online with a copy only on the phone: put it on the server now.
  useEffect(
    () =>
      onNetworkChange((online) => {
        if (online && savedOnPhone.current) void save();
      }),
    [save],
  );

  /** Delete draft: nothing is saved from here on, and what was saved goes. */
  const discard = useCallback(async () => {
    discarded.current = true;
    const id = idRef.current;
    idRef.current = null;
    setDraftId(null);
    savedOnPhone.current = false;
    await removePhoneDraft(phoneKey);
    if (id) await deleteEmailDraft(id).catch(() => {});
  }, [phoneKey]);

  /** The message went to the Outbox: save nothing more, and drop the phone copy
   *  (the Outbox has the content; the server draft is cleared by the send). */
  const handOff = useCallback(async () => {
    handedOff.current = true;
    handedOffContent.current = JSON.stringify(latest.current);
    savedOnPhone.current = false;
    await removePhoneDraft(phoneKey);
  }, [phoneKey]);

  /** Whether the last save could only keep the draft on this phone. */
  const isSavedOnPhoneOnly = useCallback(() => savedOnPhone.current, []);

  // When the oldest change not yet saved was made; null = nothing pending.
  const pendingSince = useRef<number | null>(null);
  const serialized = JSON.stringify(content);
  const firstRender = useRef(true);
  useEffect(() => {
    if (handedOff.current && serialized !== handedOffContent.current) handedOff.current = false;
    if (!enabled) return;
    const now = Date.now();
    const delay = draftAutosaveDelay(pendingSince.current, now);
    if (firstRender.current) firstRender.current = false;
    else pendingSince.current ??= now;
    const run = () => {
      pendingSince.current = null;
      void save();
    };
    const t = setTimeout(run, delay);
    return () => clearTimeout(t);
  }, [serialized, enabled, save]);

  // On the way out, catching whatever the debounce had not committed yet.
  useEffect(
    () => () => {
      void save();
    },
    [save],
  );

  return { draftId, saveNow: save, discard, handOff, isSavedOnPhoneOnly };
}
