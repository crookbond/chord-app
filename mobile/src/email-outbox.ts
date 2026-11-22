/**
 * ADR 0311 (email outbox addendum) - email written without a network.
 *
 * Send with no network puts the message in the shared send queue (ADR 0311
 * addendum), shown as the Outbox; it goes oldest first once the server answers,
 * through the same call the composer makes online. A draft whose save could
 * not reach the server is kept on the phone and uploaded to Drafts later.
 * Both are kept sealed in the signed-in user's device folder (ADR 0302), never
 * in plain storage; without the key store they live in memory while the app
 * (or web page) is open.
 */
import { useSyncExternalStore } from 'react';
import {
  mergeForUser,
  onlyForUser,
  outboxItemProblem,
  outboxSendPath,
  sendOutcome,
  type EmailBodyFormat,
  type OutboxKind,
  type QueuedSend,
  type UserTagged,
} from '@chord/kernel';

import { ApiError, forwardEmailThread, replyEmailThread, saveEmailDraft, sendEmail } from './api';
import { readDeviceJson, writeDeviceJson } from './email-device-store';
import { OfflineError, isOnline, onNetworkChange } from './network';
import { registerSender, sendOrQueue, useSendQueue } from './send-queue';
import { onSignOut } from './sign-out';
import { useApp } from './store';

/** Everything a queued email needs to be sent later: the queue's payload for kind `email`. */
export interface EmailOutboxPayload {
  kind: OutboxKind;
  /** The thread a reply or forward belongs to. */
  threadId?: string | null;
  /** The mailbox a new message leaves from; null = the primary Gmail. */
  accountId?: string | null;
  /** A verified send-as address (ADR 0130), new messages only. */
  alias?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body: string;
  /** ADR 0339: how it was written; rich carries the editor's HTML. */
  format?: EmailBodyFormat;
  bodyHtml?: string | null;
  attachmentIds: string[];
  /** Reply: the message answered. Forward: the message passed on. */
  messageId?: string | null;
  /** Forward only: carry the original's files. */
  includeAttachments?: boolean;
  /** The server draft the composer had saved, cleared by the send. */
  draftId?: string | null;
}

/** One draft kept on the phone because its save could not reach the server. */
export interface LocalEmailDraft extends UserTagged {
  /** Which composer it belongs to: `localDraftKey`. */
  key: string;
  /** The server draft it updates, if one was saved before the network went. */
  serverId?: string | null;
  kind: OutboxKind;
  threadId?: string | null;
  accountId?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
  format?: EmailBodyFormat;
  bodyHtml?: string | null;
  attachmentIds: string[];
  forwardMessageId?: string | null;
  updatedAt: string;
  /** The server refused the upload; shown, not retried. */
  error?: string | null;
}

/**
 * One key per composer: a reply or forward has one draft per thread (ADR 0113),
 * a resumed draft its server id, a brand-new message the composer's own id.
 */
export function localDraftKey(a: {
  kind: OutboxKind;
  threadId?: string | null;
  serverId?: string | null;
  composerId: string;
}): string {
  if (a.kind !== 'new' && a.threadId) return `${a.kind}:${a.threadId}`;
  if (a.serverId) return `draft:${a.serverId}`;
  return `new:${a.composerId}`;
}

/** What the composers say when Send went to the Outbox, and when a draft could only stay here. */
export function outboxNotice(): string {
  return isOnline()
    ? "It's in your Outbox and will send right after the email waiting ahead of it."
    : "You're offline. It's in your Outbox and will send when you're back online.";
}
export const PHONE_DRAFT_NOTICE = "Saved on this phone. It will go to Drafts when you're back online.";

/** Stop (no network, server error) means keep the draft on the phone; a refusal would only fail again. */
export function keepDraftOnPhone(e: unknown): boolean {
  return (
    sendOutcome({
      offline: e instanceof OfflineError,
      status: e instanceof ApiError ? e.status : undefined,
    }) === 'stop'
  );
}

// ── Sending ──────────────────────────────────────────────────────────────

/** The online send, for a payload: the same call each composer makes. */
function composedOf(p: EmailOutboxPayload): { format?: EmailBodyFormat; bodyHtml?: string | null } {
  return p.format ? { format: p.format, bodyHtml: p.format === 'rich' ? (p.bodyHtml ?? null) : null } : {};
}

async function sendEmailPayload(p: EmailOutboxPayload, sendId: string): Promise<void> {
  const problem = outboxItemProblem(p);
  // A 400-shaped refusal, so the queue marks it failed with this reason.
  if (problem) throw new ApiError(problem, 400);
  const draftId = p.draftId ?? undefined;
  switch (outboxSendPath(p)) {
    case 'send':
      await sendEmail({
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject ?? '',
        body: p.body,
        ...composedOf(p),
        ...(p.accountId ? { accountId: p.accountId } : {}),
        ...(p.alias ? { from: p.alias } : {}),
        ...(p.attachmentIds.length ? { attachmentIds: p.attachmentIds } : {}),
        ...(draftId ? { draftId } : {}),
      }, sendId);
      return;
    case 'reply':
      await replyEmailThread(p.threadId!, {
        body: p.body,
        ...composedOf(p),
        ...(p.to.length ? { to: p.to } : {}),
        ...(p.cc.length ? { cc: p.cc } : {}),
        ...(p.bcc.length ? { bcc: p.bcc } : {}),
        ...(p.attachmentIds.length ? { attachmentIds: p.attachmentIds } : {}),
        ...(p.messageId ? { messageId: p.messageId } : {}),
        ...(draftId ? { draftId } : {}),
      }, sendId);
      return;
    case 'forward':
      await forwardEmailThread(p.threadId!, {
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        ...(p.body.trim() ? { body: p.body } : {}),
        ...composedOf(p),
        includeAttachments: p.includeAttachments !== false,
        ...(p.attachmentIds.length ? { attachmentIds: p.attachmentIds } : {}),
        ...(p.messageId ? { messageId: p.messageId } : {}),
        ...(draftId ? { draftId } : {}),
      }, sendId);
      return;
  }
}

/** Put a message the composer could not send into the Outbox. */
export async function queueEmail(p: EmailOutboxPayload, sendId?: string): Promise<void> {
  // The composer only gets here having found no network, so this queues;
  // should the server have come back in between, it simply sends.
  await sendOrQueue('email', p, sendEmailPayload, sendId);
}

/** True while an earlier email waits: a new Send joins the line rather than overtaking it. */
export function useEmailWaiting(): boolean {
  return useSendQueue().some((m) => m.kind === 'email' && m.status === 'queued');
}

export function useEmailOutbox(): QueuedSend<EmailOutboxPayload>[] {
  return useSendQueue().filter((m) => m.kind === 'email') as QueuedSend<EmailOutboxPayload>[];
}

// ── Drafts kept on the phone ─────────────────────────────────────────────

const DRAFTS_FILE = 'email-phone-drafts';

let drafts: LocalEmailDraft[] = [];
let draftsLoadedFor: string | null = null;
let draftsLoading: Promise<void> | null = null;
const draftListeners = new Set<() => void>();

function emitDrafts(): void {
  for (const fn of draftListeners) fn();
}

function currentUid(): string | null {
  return useApp.getState().user?.id ?? null;
}

/** Bumped by sign-out, so a read still in flight cannot bring the old account's drafts back. */
let draftsEpoch = 0;
let draftsLoadingFor: string | null = null;

/** Read this user's drafts; drafts held for anyone else stay behind (never shown, never uploaded). */
async function ensureDraftsLoaded(): Promise<void> {
  const uid = currentUid();
  if (!uid || draftsLoadedFor === uid) return;
  if (!draftsLoading || draftsLoadingFor !== uid) {
    const epoch = ++draftsEpoch;
    draftsLoadingFor = uid;
    const run = (async () => {
      const stored =
        (await readDeviceJson<{ drafts?: LocalEmailDraft[] }>(DRAFTS_FILE))?.drafts ?? [];
      if (epoch !== draftsEpoch || currentUid() !== uid) return;
      drafts = mergeForUser({ uid, stored, held: drafts, key: (d) => d.key, prefer: 'held' });
      draftsLoadedFor = uid;
      persistDrafts();
      emitDrafts();
    })().finally(() => {
      if (draftsLoading === run) {
        draftsLoading = null;
        draftsLoadingFor = null;
      }
    });
    draftsLoading = run;
  }
  await draftsLoading;
}

function persistDrafts(): void {
  if (!draftsLoadedFor || currentUid() !== draftsLoadedFor) return;
  const mine = onlyForUser(drafts, draftsLoadedFor);
  void writeDeviceJson(DRAFTS_FILE, mine.length > 0 ? { drafts: mine } : null);
}

function setDrafts(next: LocalEmailDraft[]): void {
  drafts = next;
  persistDrafts();
  emitDrafts();
}

function subscribeDrafts(fn: () => void): () => void {
  draftListeners.add(fn);
  void ensureDraftsLoaded();
  return () => {
    draftListeners.delete(fn);
  };
}

export function usePhoneDrafts(): readonly LocalEmailDraft[] {
  return useSyncExternalStore(subscribeDrafts, () => drafts, () => drafts);
}

/** Drafts a composer has open; the composer uploads those itself, so the pass below must not. */
const openDraftKeys = new Set<string>();

export function markDraftOpen(key: string): () => void {
  openDraftKeys.add(key);
  return () => {
    openDraftKeys.delete(key);
    if (isOnline()) void uploadPhoneDrafts();
  };
}

export async function findPhoneDraft(key: string): Promise<LocalEmailDraft | null> {
  await ensureDraftsLoaded();
  return onlyForUser(drafts, currentUid()).find((d) => d.key === key) ?? null;
}

export async function savePhoneDraft(d: Omit<LocalEmailDraft, 'updatedAt'>): Promise<void> {
  await ensureDraftsLoaded();
  const uid = currentUid();
  // Nobody signed in: nowhere to keep it.
  if (!uid || draftsLoadedFor !== uid) return;
  const row: LocalEmailDraft = { ...d, uid, updatedAt: new Date().toISOString(), error: null };
  setDrafts([...drafts.filter((x) => x.key !== d.key), row]);
}

export async function removePhoneDraft(key: string): Promise<void> {
  await ensureDraftsLoaded();
  if (drafts.some((d) => d.key === key)) setDrafts(drafts.filter((d) => d.key !== key));
}

let uploading: Promise<void> | null = null;

/** Put drafts kept on the phone onto the server's Drafts, once it answers. */
export function uploadPhoneDrafts(): Promise<void> {
  uploading ??= (async () => {
    await ensureDraftsLoaded();
    const uid = currentUid();
    for (const d of onlyForUser(drafts, uid)) {
      if (!isOnline() || currentUid() !== uid) return;
      if (openDraftKeys.has(d.key) || d.error) continue;
      try {
        await saveEmailDraft({
          ...(d.serverId ? { id: d.serverId } : {}),
          kind: d.kind,
          ...(d.threadId ? { threadId: d.threadId } : {}),
          ...(d.accountId ? { accountId: d.accountId } : {}),
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          ...(d.subject !== undefined ? { subject: d.subject } : {}),
          ...(d.body !== undefined ? { body: d.body } : {}),
          attachmentIds: d.attachmentIds,
          ...(d.forwardMessageId !== undefined ? { forwardMessageId: d.forwardMessageId } : {}),
        });
        await removePhoneDraft(d.key);
      } catch (e) {
        if (keepDraftOnPhone(e)) return;
        setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, error: (e as Error).message } : x)));
      }
    }
  })().finally(() => {
    uploading = null;
  });
  return uploading;
}

// ── Start ────────────────────────────────────────────────────────────────

let started = false;

/** Once, from the root layout: queued mail and phone drafts go whenever the server answers. */
export function startEmailOutbox(): void {
  if (started) return;
  started = true;
  registerSender<EmailOutboxPayload>('email', sendEmailPayload);
  onNetworkChange((online) => {
    if (online) void uploadPhoneDrafts();
  });
  useApp.subscribe((s, prev) => {
    if (s.user?.id && s.user.id !== prev.user?.id) void uploadPhoneDrafts();
  });
  onSignOut(() => {
    drafts = [];
    draftsLoadedFor = null;
    draftsEpoch++;
    draftsLoading = null;
    draftsLoadingFor = null;
    emitDrafts();
  });
  if (isOnline()) void uploadPhoneDrafts();
}
