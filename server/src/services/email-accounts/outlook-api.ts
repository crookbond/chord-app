/**
 * Microsoft Graph mail seam (ADR 0080) — mirrors gmail-api.ts: an interface,
 * a bare-fetch real implementation, and a deterministic mock fixture selected
 * by OUTLOOK_PROVIDER so connect → sync → reply run keyless in tests/demos.
 */
import type { Kysely } from 'kysely';

import { normalizeContentId, type EmailAttachmentRef } from '@chord/kernel';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import type { AccountRow } from './account-utils.js';
import { getOutlookAccessToken } from './outlook-oauth.js';
import { fetchWithTimeout } from '../../utils/fetch-timeout.js';

/** A file on its way out. Graph wants base64 in the JSON body rather than a
 *  MIME part, so the bytes are encoded here and nowhere else. */
export interface OutgoingFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Graph's inline attachment shape. `#microsoft.graph.fileAttachment` is the
 * small-file path — anything large needs a draft plus an upload session, which
 * is why the caller caps the total before we get here (ADR 0111).
 */
function graphAttachments(files: OutgoingFile[] | undefined) {
  return (files ?? []).map((f) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: f.filename,
    contentType: f.mimeType,
    contentBytes: f.content.toString('base64'),
  }));
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

/** Subset of the Graph message resource we consume. */
export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  categories?: string[];
  internetMessageId?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name?: string; value?: string }[];
  '@removed'?: { reason?: string };
}

/** File-attachment facts (itemAttachments/references are skipped in v1). */
export interface OutlookAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** Raw Content-ID of an inline part (how a body's `cid:` image finds it). */
  contentId?: string;
}

/** The stored/wire shape of one Graph attachment. */
export function outlookAttachmentRef(a: OutlookAttachmentMeta): EmailAttachmentRef {
  return {
    id: a.id,
    filename: a.name,
    mimeType: a.contentType,
    size: a.size,
    ...(a.contentId ? { contentId: normalizeContentId(a.contentId) } : {}),
  };
}

export interface OutlookDeltaPage {
  messages: GraphMessage[];
  nextLink?: string;
  deltaLink?: string;
  /** Graph invalidated the delta token (410) — restart from scratch. */
  resync?: boolean;
}

/** Native Graph meeting-message facts for the invite probe (ADR 0074/0080). */
export interface OutlookMeetingInfo {
  /** `meetingRequest` | `meetingCancelled` | accept/decline notifications. */
  meetingMessageType: string;
  event: {
    iCalUId?: string | null;
    subject?: string | null;
    /** UTC wall time as Graph returns it with Prefer: outlook.timezone=UTC. */
    start?: { dateTime?: string; timeZone?: string } | null;
    end?: { dateTime?: string; timeZone?: string } | null;
    location?: { displayName?: string | null } | null;
    isAllDay?: boolean;
    /** Who to answer (ADR 0104). Without it an Outlook invitation could not
     *  be answered by email at all. */
    organizer?: { emailAddress?: { address?: string | null; name?: string | null } | null } | null;
  } | null;
}

export interface OutlookApi {
  /** `link` null → initial delta request bounded to `windowDays`.
   *  `folder` is the well-known name: `inbox`, or `sentitems` for the Sent
   *  stream ADR 0116 added so Outlook mirrors as much as Gmail does. */
  deltaPage(
    link: string | null,
    windowDays: number,
    folder?: 'inbox' | 'sentitems',
  ): Promise<OutlookDeltaPage>;
  /** Full message incl. body; null when it vanished. */
  getMessage(id: string): Promise<GraphMessage | null>;
  /** Meeting-message facts, or null for a plain (or vanished) message. */
  getMeetingInfo(id: string): Promise<OutlookMeetingInfo | null>;
  /** File attachments on a message (metadata only). */
  listAttachments(id: string): Promise<OutlookAttachmentMeta[]>;
  /** One attachment's bytes (base64) + facts; null when gone/unsupported. */
  getAttachment(
    id: string,
    attId: string,
  ): Promise<{ name: string; contentType: string; contentBytes: string } | null>;
  /** Graph `reply` action; recipient overrides for reply-all/cc/bcc. */
  reply(
    id: string,
    htmlComment: string,
    recipients?: { to?: string[]; cc?: string[]; bcc?: string[] },
    attachments?: OutgoingFile[],
  ): Promise<void>;
  /** Compose a NEW message (not a reply) — Graph's sendMail. */
  sendNew(input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    html: string;
    attachments?: OutgoingFile[];
  }): Promise<void>;
  /** Send a message given as RFC 822 MIME (ADR 0312: an iTIP reply, whose
   *  `text/calendar; method=REPLY` part the JSON form cannot express). */
  sendMime(mime: string): Promise<void>;
  setRead(id: string, read: boolean): Promise<void>;
  /**
   * The message's CURRENT Graph id, found by its RFC 822 Message-ID. Graph ids
   * are not stable: a message moved to another folder (archived in Outlook)
   * gets a new one, so a stored id goes stale (docs/notes/0199). null = gone.
   *
   * A message sent to yourself has TWO copies with one Message-ID, one in Sent
   * and one received, so the caller says which copy it means.
   */
  findIdByInternetMessageId(
    internetMessageId: string,
    copy: 'sent' | 'received',
  ): Promise<string | null>;
  /** ADR 0142 — current categories on a message; null when vanished. */
  getCategories(id: string): Promise<string[] | null>;
  /** ADR 0142 — replace the categories array (Graph replaces, does not merge). */
  setCategories(id: string, categories: string[]): Promise<void>;
  /** Move to the well-known `archive` folder. */
  archive(id: string): Promise<void>;
  /** Move to the well-known `deleteditems` folder (ADR 0215). */
  trash(id: string): Promise<void>;
  /** ADR 0309 — the id of the top-level mail folder named `name` (any case),
   *  creating it when there is none. With `create: false`, null when there is
   *  none (a folder deleted in Outlook moves under Deleted Items). */
  ensureFolder(name: string, opts?: { create?: boolean }): Promise<string | null>;
  /** ADR 0309 — move a message into a folder by id. */
  moveToFolder(id: string, folderId: string): Promise<void>;
  /**
   * Where a delta-`@removed` message actually went. Graph reports archive and
   * delete identically, but the difference decides whether the thread's
   * pending to-dos survive (ADR 0073): `deleted` = in Deleted Items,
   * `junk` = in Junk Email, `gone` = purged outright, `moved` = archived
   * or filed elsewhere.
   */
  getRemovalState(id: string): Promise<'deleted' | 'gone' | 'moved' | 'junk'>;
  /** Newest messages in the Junk Email folder (bodies included — junk peek). */
  listJunk(top: number): Promise<GraphMessage[]>;
  /** "Not junk" — move back to the inbox so delta sync picks it up. */
  moveToInbox(id: string): Promise<void>;
  /**
   * Register for change notifications on the inbox (ADR 0118), returning
   * the subscription id. Graph validates the URL first by calling it with
   * a `validationToken`, so this fails when the callback is unreachable —
   * which is the honest outcome: an unreachable URL means no push.
   */
  subscribe(opts: {
    notificationUrl: string;
    clientState: string;
    expiresAt: Date;
  }): Promise<string>;
  /**
   * ADR 0303 — the mailbox's own Drafts folder (Mail.ReadWrite). A reply draft
   * starts from Graph's `createReply` so Outlook threads it; its content is
   * then set with `updateDraft`. Optional for test doubles.
   */
  createDraft?(content: OutlookDraftContent): Promise<string>;
  /** null = the message being answered is gone; the caller starts a plain draft. */
  createReplyDraft?(replyToId: string): Promise<string | null>;
  /** false = the draft is gone (sent or deleted in Outlook). */
  updateDraft?(id: string, content: OutlookDraftContent): Promise<boolean>;
  /** Already gone is a success. */
  deleteDraft?(id: string): Promise<void>;
  /**
   * The ids, of those given, that are no longer drafts: deleted (Outlook moves
   * it to Deleted Items, usually under a new id), sent, or moved out of Drafts.
   */
  missingDrafts?(ids: string[]): Promise<Set<string>>;
}

export interface OutlookDraftContent {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
}

function draftPayload(c: OutlookDraftContent) {
  const toRecip = (a: string[]) => a.map((address) => ({ emailAddress: { address } }));
  return {
    subject: c.subject,
    body: { contentType: 'HTML', content: c.html },
    toRecipients: toRecip(c.to),
    ccRecipients: toRecip(c.cc),
    bccRecipients: toRecip(c.bcc),
  };
}

const DELTA_SELECT =
  'id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,internetMessageId';

/**
 * Graph reports a meeting message as one of three derived types: an
 * invitation is `eventMessageRequest`, an accept/decline/tentative reply is
 * `eventMessageResponse`, and only some messages carry the base
 * `eventMessage`. Matching the base name alone read the user's own
 * "Accepted:" reply as ordinary mail, and the model then staged a second
 * event for the meeting and invited the organizer to it.
 */
export function isGraphEventMessageType(odataType: string | undefined): boolean {
  return (
    odataType === '#microsoft.graph.eventMessage' ||
    odataType === '#microsoft.graph.eventMessageRequest' ||
    odataType === '#microsoft.graph.eventMessageResponse'
  );
}

// ── real implementation ───────────────────────────────────────────────
async function graphFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {},
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Each attempt is time-limited; one that hung is not retried (ADR 0334).
    const res = await fetchWithTimeout(
      url,
      {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      },
      'graph request',
    );
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0);
      await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1)));
      continue;
    }
    return res;
  }
}

export function realOutlookApi(accessToken: string): OutlookApi {
  /** Deleted Items folder id — resolved once, reused for removal checks. */
  let deletedItemsId: string | null = null;
  /** Junk Email folder id — resolved once, so a move to Junk reads as spam. */
  let junkId: string | null = null;
  /** Sent Items folder id — resolved once, to tell a Sent copy from a received one. */
  let sentItemsId: string | null = null;

  async function sentItemsFolderId(): Promise<string | null> {
    if (sentItemsId) return sentItemsId;
    const f = await graphFetch(
      accessToken,
      `${GRAPH_BASE}/me/mailFolders/sentitems?${new URLSearchParams({ $select: 'id' }).toString()}`,
    );
    if (!f.ok) {
      throw new Error(`graph sentitems folder ${f.status}: ${(await f.text()).slice(0, 300)}`);
    }
    sentItemsId = ((await f.json()) as { id?: string }).id ?? null;
    return sentItemsId;
  }

  async function moveTo(id: string, destinationId: string): Promise<void> {
    const res = await graphFetch(
      accessToken,
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/move`,
      { method: 'POST', body: JSON.stringify({ destinationId }) },
    );
    if (!res.ok && res.status !== 201) {
      throw new Error(`graph move ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  return {
    async deltaPage(link, windowDays, folder) {
      let url: string;
      if (link) {
        url = link;
      } else {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({
          $select: DELTA_SELECT,
          $filter: `receivedDateTime ge ${since}`,
        });
        url = `${GRAPH_BASE}/me/mailFolders/${folder ?? 'inbox'}/messages/delta?${params.toString()}`;
      }
      const res = await graphFetch(accessToken, url);
      if (res.status === 410) return { messages: [], resync: true };
      if (!res.ok) {
        throw new Error(`graph delta ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      return {
        messages: body.value ?? [],
        nextLink: body['@odata.nextLink'],
        deltaLink: body['@odata.deltaLink'],
      };
    },

    async getMessage(id) {
      // internetMessageHeaders is deliberately NOT on the delta select: it
      // carries every header of every message on the hot path, to serve a
      // question only asked about a thread someone opened (ADR 0122).
      const params = new URLSearchParams({
        $select: `${DELTA_SELECT},hasAttachments,body,internetMessageHeaders`,
      });
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`graph getMessage ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return (await res.json()) as GraphMessage;
    },

    async getMeetingInfo(id) {
      // Two steps: derived-type properties can't be $select'ed on the base
      // message, so read @odata.type first, then expand the linked event
      // (UTC-preferred) only for actual eventMessages. `event` is a navigation
      // property of the derived type, so on /me/messages it is reached through
      // the type cast; a bare `event` is a Graph 400 on every call.
      const probe = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: 'id' }).toString()}`,
      );
      if (probe.status === 404) return null;
      if (!probe.ok) {
        throw new Error(`graph meeting probe ${probe.status}: ${(await probe.text()).slice(0, 300)}`);
      }
      const head = (await probe.json()) as { '@odata.type'?: string };
      if (!isGraphEventMessageType(head['@odata.type'])) return null;

      const params = new URLSearchParams({
        $expand: 'microsoft.graph.eventMessage/event($select=iCalUId,subject,start,end,location,isAllDay,organizer)',
      });
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
        { headers: { Prefer: 'outlook.timezone="UTC"' } },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`graph meeting info ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        meetingMessageType?: string;
        event?: OutlookMeetingInfo['event'];
      };
      if (!body.meetingMessageType) return null;
      return { meetingMessageType: body.meetingMessageType, event: body.event ?? null };
    },

    async reply(id, htmlComment, recipients, attachments) {
      const payload: Record<string, unknown> = { comment: htmlComment };
      const toRecip = (a?: string[]) => a?.map((address) => ({ emailAddress: { address } }));
      if (attachments?.length) {
        payload.message = { attachments: graphAttachments(attachments) };
      }
      if (recipients?.to?.length || recipients?.cc?.length || recipients?.bcc?.length) {
        payload.message = {
          ...(payload.message as Record<string, unknown> | undefined),
          ...(recipients.to?.length ? { toRecipients: toRecip(recipients.to) } : {}),
          ...(recipients.cc?.length ? { ccRecipients: toRecip(recipients.cc) } : {}),
          ...(recipients.bcc?.length ? { bccRecipients: toRecip(recipients.bcc) } : {}),
        };
      }
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/reply`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      if (!res.ok && res.status !== 202) {
        throw new Error(`graph reply ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async sendNew(input) {
      const toRecip = (a?: string[]) => (a ?? []).map((address) => ({ emailAddress: { address } }));
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/me/sendMail`, {
        method: 'POST',
        body: JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: 'HTML', content: input.html },
            toRecipients: toRecip(input.to),
            ...(input.cc?.length ? { ccRecipients: toRecip(input.cc) } : {}),
            ...(input.bcc?.length ? { bccRecipients: toRecip(input.bcc) } : {}),
            ...(input.attachments?.length
              ? { attachments: graphAttachments(input.attachments) }
              : {}),
          },
          saveToSentItems: true,
        }),
      });
      // sendMail answers 202 Accepted, not 200.
      if (!res.ok && res.status !== 202) {
        throw new Error(`graph sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async sendMime(mime) {
      // Graph takes a MIME message as base64 text on the same endpoint.
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/me/sendMail`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(mime, 'utf8').toString('base64'),
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`graph sendMail (mime) ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async setRead(id, read) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ isRead: read }) },
      );
      if (!res.ok) {
        throw new Error(`graph setRead ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async findIdByInternetMessageId(internetMessageId, copy) {
      const params = new URLSearchParams({
        // OData string literal: a single quote is escaped by doubling it.
        $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`,
        $select: 'id,parentFolderId',
        $top: '10',
      });
      // The Sent copy is searched where it lives; a received copy can be in
      // any other folder (it moved, which is why the id went stale), so the
      // whole mailbox is searched with the Sent folder left out.
      const scope = copy === 'sent' ? '/me/mailFolders/sentitems/messages' : '/me/messages';
      const res = await graphFetch(accessToken, `${GRAPH_BASE}${scope}?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`graph findByMessageId ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { value?: { id?: string; parentFolderId?: string }[] };
      const hits = body.value ?? [];
      if (copy === 'sent') return hits[0]?.id ?? null;
      const sent = await sentItemsFolderId();
      return hits.find((m) => !sent || m.parentFolderId !== sent)?.id ?? null;
    },

    async getCategories(id) {
      const params = new URLSearchParams({ $select: 'categories' });
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`graph getCategories ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { categories?: string[] };
      return body.categories ?? [];
    },

    async setCategories(id, categories) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ categories }) },
      );
      if (!res.ok) {
        throw new Error(`graph setCategories ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async archive(id) {
      await moveTo(id, 'archive');
    },

    async trash(id) {
      await moveTo(id, 'deleteditems');
    },

    async ensureFolder(name, opts) {
      const key = name.trim().toLowerCase();
      // Top-level folders are few; page through rather than trust a $filter on
      // displayName, which compares case-sensitively on some tenants.
      let url: string | null =
        `${GRAPH_BASE}/me/mailFolders?${new URLSearchParams({ $select: 'id,displayName', $top: '100' }).toString()}`;
      while (url) {
        const res = await graphFetch(accessToken, url);
        if (!res.ok) throw new Error(`graph list folders ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const page = (await res.json()) as {
          value?: Array<{ id: string; displayName?: string }>;
          '@odata.nextLink'?: string;
        };
        const hit = page.value?.find((f) => (f.displayName ?? '').trim().toLowerCase() === key);
        if (hit) return hit.id;
        url = page['@odata.nextLink'] ?? null;
      }
      if (opts?.create === false) return null;
      const created = await graphFetch(accessToken, `${GRAPH_BASE}/me/mailFolders`, {
        method: 'POST',
        body: JSON.stringify({ displayName: name.trim() }),
      });
      if (!created.ok) {
        throw new Error(`graph create folder ${created.status}: ${(await created.text()).slice(0, 300)}`);
      }
      const body = (await created.json()) as { id?: string };
      if (!body.id) throw new Error('graph create folder returned no id');
      return body.id;
    },

    async moveToFolder(id, folderId) {
      await moveTo(id, folderId);
    },

    async listAttachments(id) {
      // contentId lives on fileAttachment, which the base collection cannot
      // $select; isInline is on the base type, so list with that and read
      // only the inline parts (small, and few) for their Content-ID.
      const base = `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/attachments`;
      const params = new URLSearchParams({ $select: 'id,name,contentType,size,isInline' });
      const res = await graphFetch(accessToken, `${base}?${params.toString()}`);
      if (res.status === 404) return [];
      if (!res.ok) {
        throw new Error(`graph attachments ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        value?: {
          '@odata.type'?: string;
          id?: string;
          name?: string;
          contentType?: string;
          size?: number;
          isInline?: boolean;
        }[];
      };
      const files = (body.value ?? []).filter(
        (a) => (a['@odata.type'] ?? '').endsWith('fileAttachment') && a.id,
      );
      const out: OutlookAttachmentMeta[] = [];
      for (const a of files) {
        let contentId: string | undefined;
        if (a.isInline) {
          const one = await graphFetch(accessToken, `${base}/${encodeURIComponent(a.id!)}`);
          if (one.ok) contentId = ((await one.json()) as { contentId?: string }).contentId ?? undefined;
        }
        out.push({
          id: a.id!,
          name: a.name ?? 'attachment',
          contentType: a.contentType ?? 'application/octet-stream',
          size: a.size ?? 0,
          ...(contentId ? { contentId } : {}),
        });
      }
      return out;
    },

    async getAttachment(id, attId) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`graph attachment ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        name?: string;
        contentType?: string;
        contentBytes?: string;
      };
      if (!body.contentBytes) return null;
      return {
        name: body.name ?? 'attachment',
        contentType: body.contentType ?? 'application/octet-stream',
        contentBytes: body.contentBytes,
      };
    },

    async getRemovalState(id) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({
          $select: 'id,parentFolderId',
        }).toString()}`,
      );
      // Purged outright (or beyond reach) — the user's intent was a delete.
      if (res.status === 404) return 'gone';
      if (!res.ok) {
        throw new Error(`graph removal probe ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { parentFolderId?: string };
      if (!deletedItemsId) {
        const f = await graphFetch(
          accessToken,
          `${GRAPH_BASE}/me/mailFolders/deleteditems?${new URLSearchParams({ $select: 'id' }).toString()}`,
        );
        if (f.ok) deletedItemsId = ((await f.json()) as { id?: string }).id ?? null;
      }
      if (!junkId) {
        const f = await graphFetch(
          accessToken,
          `${GRAPH_BASE}/me/mailFolders/junkemail?${new URLSearchParams({ $select: 'id' }).toString()}`,
        );
        if (f.ok) junkId = ((await f.json()) as { id?: string }).id ?? null;
      }
      if (!body.parentFolderId) return 'moved';
      if (body.parentFolderId === deletedItemsId) return 'deleted';
      return body.parentFolderId === junkId ? 'junk' : 'moved';
    },

    async listJunk(top) {
      const params = new URLSearchParams({
        $select: `${DELTA_SELECT},body`,
        $orderby: 'receivedDateTime desc',
        $top: String(Math.min(Math.max(top, 1), 50)),
      });
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/mailFolders/junkemail/messages?${params.toString()}`,
      );
      if (!res.ok) {
        throw new Error(`graph junk list ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { value?: GraphMessage[] };
      return body.value ?? [];
    },

    async subscribe({ notificationUrl, clientState, expiresAt }) {
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify({
          changeType: 'created',
          notificationUrl,
          resource: "me/mailFolders('inbox')/messages",
          expirationDateTime: expiresAt.toISOString(),
          clientState,
        }),
      });
      if (!res.ok) {
        throw new Error(`graph subscribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { id?: string };
      if (!body.id) throw new Error('graph subscribe returned no id');
      return body.id;
    },

    async moveToInbox(id) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/move`,
        { method: 'POST', body: JSON.stringify({ destinationId: 'inbox' }) },
      );
      if (!res.ok && res.status !== 201) {
        throw new Error(`graph move-to-inbox ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async createDraft(content) {
      // POST /me/messages files the new message in Drafts.
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/me/messages`, {
        method: 'POST',
        body: JSON.stringify(draftPayload(content)),
      });
      if (!res.ok) {
        throw new Error(`graph create draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const id = ((await res.json()) as { id?: string }).id;
      if (!id) throw new Error('graph create draft returned no id');
      return id;
    },

    async createReplyDraft(replyToId) {
      const res = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/messages/${encodeURIComponent(replyToId)}/createReply`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`graph createReply ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return ((await res.json()) as { id?: string }).id ?? null;
    },

    async updateDraft(id, content) {
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(draftPayload(content)),
      });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(`graph update draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return true;
    },

    async deleteDraft(id) {
      const res = await graphFetch(accessToken, `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`graph delete draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    },

    async missingDrafts(ids) {
      const missing = new Set<string>();
      if (!ids.length) return missing;
      const folderRes = await graphFetch(
        accessToken,
        `${GRAPH_BASE}/me/mailFolders/drafts?${new URLSearchParams({ $select: 'id' }).toString()}`,
      );
      if (!folderRes.ok) throw new Error(`graph drafts folder ${folderRes.status}`);
      const draftsId = ((await folderRes.json()) as { id?: string }).id;
      for (const id of ids) {
        const res = await graphFetch(
          accessToken,
          `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: 'isDraft,parentFolderId' }).toString()}`,
        );
        if (res.status === 404) {
          missing.add(id);
          continue;
        }
        if (!res.ok) throw new Error(`graph get draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const m = (await res.json()) as { isDraft?: boolean; parentFolderId?: string };
        if (m.isDraft === false || (draftsId && m.parentFolderId && m.parentFolderId !== draftsId)) {
          missing.add(id);
        }
      }
      return missing;
    },
  };
}

// ── mock implementation ───────────────────────────────────────────────
interface MockOp {
  kind: 'upsert' | 'removed';
  message: GraphMessage;
  /** Mirrors the real provider's archive-vs-delete distinction. */
  removalState?: 'deleted' | 'gone' | 'moved' | 'junk';
}

interface MockOutlookMailbox {
  /** Append-only oplog; the delta cursor is an index into it. */
  ops: MockOp[];
  byId: Map<string, GraphMessage>;
  junk: Map<string, GraphMessage>;
  /** Messages that left the inbox under a NEW id, as Graph re-issues ids on a
   *  move: findable by Message-ID, not by the id the mirror stored. */
  relocated: Map<string, GraphMessage>;
  meetings: Map<string, OutlookMeetingInfo | Error>;
  /** messageId → file attachments (meta + base64 bytes). */
  attachments: Map<string, (OutlookAttachmentMeta & { contentBytes: string })[]>;
  /** messageId → where a removed message went (default 'moved' = archived). */
  removalStates: Map<string, 'deleted' | 'gone' | 'moved' | 'junk'>;
  sentCount: number;
  /** Filenames on the last outgoing message — so a test can tell a send that
   *  carried its attachments from one that quietly dropped them. */
  lastSentAttachments: string[];
  /** HTML of the last `sendNew`. */
  lastSentHtml: string | null;
  /** MIME of every `sendMime` call, oldest first. */
  sentMime: string[];
  /** The Sent folder's own delta stream (ADR 0116). Separate from `ops`,
   *  because a mock that returned the same messages for both folders would
   *  import every message twice and look like it worked. */
  sentOps: MockOp[];
  /** Ids of messages that live in the Sent folder. */
  sentIds: Set<string>;
  /** Last clientState handed to `subscribe` (ADR 0118 tests). */
  lastClientState: string | null;
  /** Test hook: the next N setRead calls fail like a Graph outage. */
  setReadFailures: number;
  /** ADR 0303 — the Drafts folder: id → content (+ the message it answers). */
  drafts: Map<string, OutlookDraftContent & { replyTo: string | null }>;
  /** ADR 0309 — mail folders made or found by name: folder id → name, and
   *  folder id → the messages filed there. */
  folders: Map<string, string>;
  filed: Map<string, GraphMessage[]>;
  /** Test hook: getMessage waits on this, like Graph holding a request. */
  getMessageGate: Promise<void> | null;
  getMessageInFlight: number;
  getMessageMaxInFlight: number;
}

/** Test helper — hold every getMessage until the returned release is called. */
export function __holdOutlookMockGetMessage(accountKey: string): () => void {
  let release!: () => void;
  mockBox(accountKey).getMessageGate = new Promise<void>((r) => {
    release = r;
  });
  return () => {
    mockBox(accountKey).getMessageGate = null;
    release();
  };
}

/** Test helper — the most getMessage calls this mailbox has had open at once. */
export function __outlookMockGetMessageMaxInFlight(accountKey: string): number {
  return mockBox(accountKey).getMessageMaxInFlight;
}

/** Test helper — what was filed where in this mock Outlook mailbox (folder name → subjects). */
export function __outlookMockFiled(accountKey: string): Map<string, string[]> {
  const box = mockBox(accountKey);
  const out = new Map<string, string[]>();
  for (const [id, msgs] of box.filed) out.set(box.folders.get(id) ?? id, msgs.map((m) => m.subject ?? ''));
  return out;
}

/** Test helper — the user deletes a folder in Outlook (with what was in it). */
export function __deleteOutlookMockFolder(accountKey: string, name: string): void {
  const box = mockBox(accountKey);
  for (const [id, n] of box.folders) {
    if (n.toLowerCase() !== name.toLowerCase()) continue;
    box.folders.delete(id);
    box.filed.delete(id);
  }
}

/** Test helper — the folders in this mock Outlook mailbox, by name. */
export function __outlookMockFolderNames(accountKey: string): string[] {
  return [...mockBox(accountKey).folders.values()];
}

/** Test helper — the drafts in this mock Outlook mailbox. */
export function __outlookMockDrafts(
  accountKey: string,
): Map<string, OutlookDraftContent & { replyTo: string | null }> {
  return mockBox(accountKey).drafts;
}

const mockMailboxes = new Map<string, MockOutlookMailbox>();
let mockDraftSeq = 0;

function seedOutlookMailbox(): MockOutlookMailbox {
  const box: MockOutlookMailbox = {
    ops: [],
    byId: new Map(),
    junk: new Map(),
    relocated: new Map(),
    meetings: new Map(),
    attachments: new Map(),
    removalStates: new Map(),
    sentCount: 0,
    lastSentAttachments: [],
    lastSentHtml: null,
    sentMime: [],
    sentOps: [],
    sentIds: new Set(),
    lastClientState: null,
    setReadFailures: 0,
    drafts: new Map(),
    folders: new Map(),
    filed: new Map(),
    getMessageGate: null,
    getMessageInFlight: 0,
    getMessageMaxInFlight: 0,
  };
  const seed = (m: GraphMessage) => {
    box.byId.set(m.id, m);
    box.ops.push({ kind: 'upsert', message: m });
  };
  const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  seed({
    id: 'ol-msg-1',
    conversationId: 'ol-conv-1',
    subject: 'Soccer practice moved to Thursday',
    bodyPreview: 'Hi parents — this week practice moves to Thursday 5pm at Miller Field.',
    from: { emailAddress: { name: 'Coach Dana', address: 'coach@lions-soccer.example' } },
    toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
    receivedDateTime: hourAgo(20),
    isRead: false,
    internetMessageId: '<ol-msg-1@lions-soccer.example>',
    body: {
      contentType: 'html',
      content: '<p>Hi parents — this week practice moves to <b>Thursday 5pm</b> at Miller Field.</p>',
    },
  });
  seed({
    id: 'ol-msg-2',
    conversationId: 'ol-conv-2',
    subject: 'Your Microsoft 365 receipt',
    bodyPreview: 'Thanks for your subscription payment of $9.99.',
    from: { emailAddress: { name: 'Microsoft', address: 'billing@microsoft.example' } },
    toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
    receivedDateTime: hourAgo(46),
    isRead: true,
    internetMessageId: '<ol-msg-2@microsoft.example>',
    body: { contentType: 'text', content: 'Thanks for your subscription payment of $9.99.' },
  });
  return box;
}

function mockBox(accountKey: string): MockOutlookMailbox {
  let box = mockMailboxes.get(accountKey);
  if (!box) {
    box = seedOutlookMailbox();
    mockMailboxes.set(accountKey, box);
  }
  return box;
}

export function mockOutlookApi(accountKey: string): OutlookApi {
  const box = mockBox(accountKey);
  return {
    async deltaPage(link, _windowDays, folder) {
      const ops = folder === 'sentitems' ? box.sentOps : box.ops;
      const from = link ? Number(link.replace('mock-delta:', '')) || 0 : 0;
      const slice = ops.slice(from);
      return {
        messages: slice.map((op) =>
          op.kind === 'removed'
            ? { id: op.message.id, '@removed': { reason: 'changed' } }
            : op.message,
        ),
        deltaLink: `mock-delta:${ops.length}`,
      };
    },
    async getMessage(id) {
      mockGetMessageCount += 1;
      box.getMessageInFlight += 1;
      box.getMessageMaxInFlight = Math.max(box.getMessageMaxInFlight, box.getMessageInFlight);
      try {
        // Yield once so calls started together are seen together.
        await Promise.resolve();
        if (box.getMessageGate) await box.getMessageGate;
        return box.byId.get(id) ?? null;
      } finally {
        box.getMessageInFlight -= 1;
      }
    },
    async getMeetingInfo(id) {
      const info = box.meetings.get(id);
      if (info instanceof Error) throw info;
      return info ?? null;
    },
    async listAttachments(id) {
      return (box.attachments.get(id) ?? []).map(({ contentBytes: _cb, ...meta }) => meta);
    },
    async getAttachment(id, attId) {
      const att = (box.attachments.get(id) ?? []).find((a) => a.id === attId);
      return att
        ? { name: att.name, contentType: att.contentType, contentBytes: att.contentBytes }
        : null;
    },
    async reply(id, htmlComment, _recipients, attachments) {
      const parent = box.byId.get(id);
      if (!parent) throw new Error(`mock outlook: no message ${id}`);
      box.sentCount += 1;
      box.lastSentAttachments = (attachments ?? []).map((a) => a.filename);
    },
    async sendNew(input) {
      box.sentCount += 1;
      box.lastSentAttachments = (input.attachments ?? []).map((a) => a.filename);
      box.lastSentHtml = input.html;
    },
    async sendMime(mime) {
      box.sentCount += 1;
      box.sentMime.push(mime);
    },
    async setRead(id, read) {
      if (box.setReadFailures > 0) {
        box.setReadFailures -= 1;
        throw new Error('graph setRead 503: {"error":{"code":"ServiceUnavailable"}}');
      }
      const m = box.byId.get(id);
      // Mirrors Graph: a stale id (message moved since) is a 404, not a no-op.
      if (!m) {
        throw new Error(
          'graph setRead 404: {"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store."}}',
        );
      }
      const next = { ...m, isRead: read };
      box.byId.set(id, next);
      box.ops.push({ kind: 'upsert', message: next });
    },
    async findIdByInternetMessageId(internetMessageId, copy) {
      for (const m of box.byId.values()) {
        if (m.internetMessageId !== internetMessageId) continue;
        if (box.sentIds.has(m.id) === (copy === 'sent')) return m.id;
      }
      if (copy === 'received') {
        for (const m of box.relocated.values()) if (m.internetMessageId === internetMessageId) return m.id;
      }
      return null;
    },
    async getCategories(id) {
      const m = box.byId.get(id);
      if (!m) return null;
      return [...(m.categories ?? [])];
    },
    async setCategories(id, categories) {
      const m = box.byId.get(id);
      if (m) {
        const next = { ...m, categories: [...categories] };
        box.byId.set(id, next);
        box.ops.push({ kind: 'upsert', message: next });
      }
    },
    async archive(id) {
      const m = box.byId.get(id);
      if (m) {
        box.byId.delete(id);
        box.ops.push({ kind: 'removed', message: m });
      }
    },
    async trash(id) {
      const m = box.byId.get(id);
      if (m) {
        box.byId.delete(id);
        box.removalStates.set(id, 'deleted');
        box.ops.push({ kind: 'removed', message: m, removalState: 'deleted' });
      }
    },
    async ensureFolder(name, opts) {
      const key = name.trim().toLowerCase();
      for (const [id, n] of box.folders) if (n.toLowerCase() === key) return id;
      if (opts?.create === false) return null;
      const id = `mock-folder-${box.folders.size + 1}`;
      box.folders.set(id, name.trim());
      return id;
    },
    async moveToFolder(id, folderId) {
      const m = box.byId.get(id);
      if (m) {
        box.byId.delete(id);
        box.filed.set(folderId, [...(box.filed.get(folderId) ?? []), m]);
        box.ops.push({ kind: 'removed', message: m });
      }
    },
    async getRemovalState(id) {
      return box.removalStates.get(id) ?? 'moved';
    },
    async listJunk(top) {
      return [...box.junk.values()]
        .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
        .slice(0, top);
    },
    async subscribe({ clientState }) {
      box.lastClientState = clientState;
      return `mock-sub-${box.ops.length}`;
    },
    async moveToInbox(id) {
      const m = box.junk.get(id);
      if (m) {
        box.junk.delete(id);
        box.byId.set(id, m);
        box.ops.push({ kind: 'upsert', message: m });
      }
    },
    async createDraft(content) {
      const id = `ol-draft-${++mockDraftSeq}`;
      box.drafts.set(id, { ...content, replyTo: null });
      return id;
    },
    async createReplyDraft(replyToId) {
      const parent = box.byId.get(replyToId);
      if (!parent) return null;
      const id = `ol-draft-${++mockDraftSeq}`;
      box.drafts.set(id, { to: [], cc: [], bcc: [], subject: `RE: ${parent.subject ?? ''}`, html: '', replyTo: replyToId });
      return id;
    },
    async updateDraft(id, content) {
      const d = box.drafts.get(id);
      if (!d) return false;
      box.drafts.set(id, { ...content, replyTo: d.replyTo });
      const during = mockDraftWriteHook;
      mockDraftWriteHook = null;
      await during?.();
      return true;
    },
    async deleteDraft(id) {
      box.drafts.delete(id);
    },
    async missingDrafts(ids) {
      return new Set(ids.filter((id) => !box.drafts.has(id)));
    },
  };
}

let mockGetMessageCount = 0;
/** Test helper — how many single-message reads the mock has served. */
export function __outlookMockGetMessageCount(): number {
  return mockGetMessageCount;
}

let mockDraftWriteHook: (() => Promise<void>) | null = null;
/** Test helper — run `fn` once, while the next draft update is in flight. */
export function __duringNextOutlookMockDraftWrite(fn: () => Promise<void>): void {
  mockDraftWriteHook = fn;
}

// ── test helpers ──────────────────────────────────────────────────────
export function __resetOutlookMock(accountKey?: string): void {
  if (accountKey) mockMailboxes.delete(accountKey);
  else {
    mockMailboxes.clear();
    mockDraftWriteHook = null;
  }
}

export function __addOutlookMockMessage(accountKey: string, message: GraphMessage): void {
  const box = mockBox(accountKey);
  box.byId.set(message.id, message);
  box.ops.push({ kind: 'upsert', message });
}

/**
 * A change to an existing message, delivered the way Graph's delta delivers
 * one: only `id` plus the properties that changed (e.g. `{ id, isRead }` after
 * the message was read elsewhere). The full resource behind it is updated too,
 * so a follow-up `getMessage` sees the real state.
 */
export function __changeOutlookMockMessage(
  accountKey: string,
  id: string,
  changed: Partial<GraphMessage>,
): void {
  const box = mockBox(accountKey);
  const m = box.byId.get(id);
  if (m) box.byId.set(id, { ...m, ...changed });
  box.ops.push({ kind: 'upsert', message: { id, ...changed } });
}

/**
 * What Outlook does to a message moved to another folder: the same message,
 * a NEW Graph id. The delta for the old folder only says the old id left.
 */
export function __reissueOutlookMockId(accountKey: string, oldId: string, newId: string): void {
  const box = mockBox(accountKey);
  const m = box.byId.get(oldId);
  if (!m) return;
  box.byId.delete(oldId);
  box.byId.set(newId, { ...m, id: newId });
  if (box.sentIds.delete(oldId)) box.sentIds.add(newId);
}

/** The next `n` setRead calls fail like a Graph outage (503). */
export function __failOutlookMockSetRead(accountKey: string, n: number): void {
  mockBox(accountKey).setReadFailures = n;
}

export function __outlookMockIsRead(accountKey: string, id: string): boolean | null {
  const m = mockBox(accountKey).byId.get(id);
  return m ? m.isRead === true : null;
}

/** Where the mock put a message that left the inbox, if anywhere. */
export function __outlookMockRemovalState(
  accountKey: string,
  id: string,
): 'deleted' | 'gone' | 'moved' | 'junk' | null {
  return mockBox(accountKey).removalStates.get(id) ?? null;
}

/** `state` mirrors the provider: 'moved' = archived (default), 'deleted' =
 *  Deleted Items, 'gone' = purged. */
export function __removeOutlookMockMessage(
  accountKey: string,
  id: string,
  state: 'deleted' | 'gone' | 'moved' | 'junk' = 'moved',
): void {
  const box = mockBox(accountKey);
  const m = box.byId.get(id);
  if (!m) return;
  box.byId.delete(id);
  box.removalStates.set(id, state);
  box.ops.push({ kind: 'removed', message: m, removalState: state });
}

/**
 * What Outlook does when its spam filter acts after delivery: the message
 * moves to Junk under a new id, so the id the mirror stored answers 404.
 */
export function __junkOutlookMockMessageLater(accountKey: string, id: string): void {
  const box = mockBox(accountKey);
  const m = box.byId.get(id);
  if (!m) return;
  box.byId.delete(id);
  box.removalStates.set(id, 'gone');
  const moved = { ...m, id: `${id}-junk` };
  box.relocated.set(moved.id, moved);
  box.removalStates.set(moved.id, 'junk');
  box.ops.push({ kind: 'removed', message: m, removalState: 'gone' });
}

export function __outlookMockSentCount(accountKey: string): number {
  return mockBox(accountKey).sentCount;
}

export function __outlookMockSentAttachments(accountKey: string): string[] {
  return mockBox(accountKey).lastSentAttachments;
}

export function __outlookMockSentHtml(accountKey: string): string | null {
  return mockBox(accountKey).lastSentHtml;
}

export function __outlookMockSentMime(accountKey: string): string[] {
  return mockBox(accountKey).sentMime;
}

/** ADR 0142 — categories currently on a mock message. */
export function __outlookMockCategories(accountKey: string, id: string): string[] | null {
  const m = mockBox(accountKey).byId.get(id);
  if (!m) return null;
  return [...(m.categories ?? [])];
}

/** Put a message in the mock Sent folder (ADR 0116 parity tests). */
export function __addOutlookMockSent(accountKey: string, message: GraphMessage): void {
  const box = mockBox(accountKey);
  box.byId.set(message.id, message);
  box.sentIds.add(message.id);
  box.sentOps.push({ kind: 'upsert', message });
}

export function __addOutlookMockJunk(accountKey: string, message: GraphMessage): void {
  mockBox(accountKey).junk.set(message.id, message);
}

export function __setOutlookMockAttachments(
  accountKey: string,
  messageId: string,
  atts: (OutlookAttachmentMeta & { contentBytes: string })[],
): void {
  const box = mockBox(accountKey);
  box.attachments.set(messageId, atts);
  const m = box.byId.get(messageId);
  // Graph's hasAttachments ignores inline parts (the ones with a Content-ID).
  if (m) m.hasAttachments = atts.some((a) => !a.contentId);
}

export function __setOutlookMockMeeting(
  accountKey: string,
  messageId: string,
  /** An Error makes the probe throw, like a Graph outage. */
  info: OutlookMeetingInfo | Error,
): void {
  mockBox(accountKey).meetings.set(messageId, info);
}

// ── seam ──────────────────────────────────────────────────────────────
export async function getOutlookApi(db: Kysely<DB>, account: AccountRow): Promise<OutlookApi> {
  if (env.OUTLOOK_PROVIDER === 'mock') return mockOutlookApi(account.id);
  const accessToken = await getOutlookAccessToken(db, account);
  return realOutlookApi(accessToken);
}
