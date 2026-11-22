import fs from 'node:fs';
import path from 'node:path';

import type { Kysely } from 'kysely';

import { SSE, mentionsBot } from '@chord/kernel';

import { logger } from '../../../config/logging.js';
import { runInBackground } from '../../../utils/background.js';
import type { DB } from '../../../db/schema.js';
import { mapConcurrent } from '../../../utils/concurrency.js';
import { newId, slugify } from '../../../utils/ids.js';
import { saveFile } from '../../attachments.service.js';
import { getDefaultPersona } from '../../bot-personas.service.js';
import { applyToolCall } from '../../bot/executor.js';
import { createGroup } from '../../groups.service.js';
import { getLlmForUser } from '../../llm/factory.js';
import { canUseAi, isAiRefusal } from '../../llm/refusal.js';
import { queueAiWork } from '../../ai-backlog.service.js';
import type { LlmService } from '../../llm/types.js';
import { sseHub } from '../../sse.hub.js';

import {
  extractFromWindow,
  windowMessages,
  type ExtractedCall,
} from './extract.js';
import type { ToolCall } from '../../bot/tools.js';
import { classifyWhatsAppFilename } from './media.js';
import { parseChat, type ParsedChatMessage } from './parse.js';
import { cleanupTempDir, extractZipFromBuffer } from './unzip.js';

export interface ImportWhatsAppInput {
  zipBuffer: Buffer;
  uploaderId: string;
  /** Defaults to "Imported chat". */
  groupName?: string;
  /** Skip windowed LLM extraction. Useful for tests / structural-only imports. */
  skipExtraction?: boolean;
  /** Override the LLM service (defaults to the uploader's, ADR 0257). Used by tests. */
  llm?: LlmService;
  /**
   * If true, the structural phase (group + messages + media) runs synchronously
   * and extraction runs as a detached background job that broadcasts progress
   * + entity events via SSE. The returned `entitiesExtracted` is always 0 in
   * this mode — consumers should listen on the group stream instead.
   *
   * Defaults to false so tests keep the deterministic sync path.
   */
  runExtractionAsync?: boolean;
}

export interface ImportWhatsAppResult {
  groupId: string;
  messagesInserted: number;
  shadowUsersCreated: number;
  attachmentsUploaded: number;
  attachmentsLinked: number;
  entitiesExtracted: number;
}

const MESSAGE_BATCH_SIZE = 500;

export async function importWhatsAppZip(
  db: Kysely<DB>,
  input: ImportWhatsAppInput,
): Promise<ImportWhatsAppResult> {
  const { zipBuffer, uploaderId } = input;
  const { tempDir, entries } = extractZipFromBuffer(zipBuffer);

  try {
    const chatEntry = entries.find((e) => path.basename(e) === '_chat.txt');
    if (!chatEntry) {
      throw new Error('zip does not contain _chat.txt at any level');
    }

    const chatContent = fs.readFileSync(path.join(tempDir, chatEntry), 'utf-8');
    const messages = parseChat(chatContent);
    if (messages.length === 0) {
      throw new Error('_chat.txt parsed to zero messages');
    }

    const personaMap = await resolvePersonas(db, messages, uploaderId);
    const shadowUsersCreated = [...personaMap.values()].filter(
      (v) => v.createdNow,
    ).length;

    const group = await createGroup(db, {
      name: input.groupName ?? 'Imported chat',
      kind: 'group',
      createdBy: uploaderId,
    });

    // Each persona is a freshly-minted (or the uploader's own) user id with no
    // per-row conditional beyond the uploader-skip filter, so one batch
    // insert replaces N round trips.
    const memberRows = [...personaMap.values()]
      .filter(({ userId }) => userId !== uploaderId)
      .map(({ userId }) => ({
        group_id: group.id,
        user_id: userId,
        role: 'member' as const,
        tier: 'trusted' as const,
        joined_at: new Date().toISOString(),
      }));
    if (memberRows.length > 0) {
      await db.insertInto('group_members').values(memberRows).execute();
    }

    const attachmentMap = await uploadMedia(db, {
      tempDir,
      entries,
      groupId: group.id,
      uploaderId,
    });

    const messageRows = messages.map((m) => {
      const attachmentId = m.attachmentFilename
        ? attachmentMap.get(m.attachmentFilename) ?? null
        : null;
      return {
        id: newId('m'),
        group_id: group.id,
        sender_id: personaMap.get(m.sender)?.userId ?? null,
        kind: attachmentId ? ('file' as const) : ('text' as const),
        body: m.body,
        attachment_id: attachmentId,
        reply_to_id: null,
        mentions_bot: mentionsBot(m.body, getDefaultPersona().mentionAliases) ? 1 : 0,
        created_at: m.sentAt.toISOString(),
        source: 'import' as const,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      };
    });

    for (let i = 0; i < messageRows.length; i += MESSAGE_BATCH_SIZE) {
      await db
        .insertInto('messages')
        .values(messageRows.slice(i, i + MESSAGE_BATCH_SIZE))
        .execute();
    }

    const attachmentsLinked = messageRows.filter((r) => r.attachment_id).length;
    const memberNames = Array.from(new Set(messages.map((m) => m.sender)));

    let entitiesExtracted = 0;
    // ADR 0283 — the imported chat is kept either way; only the model pass
    // over it waits for the uploader's consent and allowance, and is run
    // from the stored messages once both are met (ai-backlog).
    const aiNow = !input.skipExtraction && (await canUseAi(db, input.uploaderId));
    if (!input.skipExtraction && !aiNow) {
      await queueAiWork(db, { userId: uploaderId, kind: 'whatsapp_import', ref: group.id, payload: { fromWindow: 0 } });
    }
    if (aiNow) {
      const llm = input.llm ?? (await getLlmForUser(db, input.uploaderId, 'whatsapp_import'));
      if (input.runExtractionAsync) {
        runInBackground(
          runExtractionBackground({
            db,
            groupId: group.id,
            uploaderId,
            messages,
            members: memberNames,
            llm,
          }).catch((err) => logger.error('whatsapp import extraction failed', { err, groupId: group.id })),
        );
      } else {
        entitiesExtracted = await runExtractionSync({
          db,
          groupId: group.id,
          uploaderId,
          messages,
          members: memberNames,
          llm,
        });
      }
    }

    logger.info(
      `whatsapp import: group=${group.id} messages=${messageRows.length} ` +
        `shadow=${shadowUsersCreated} attachments=${attachmentMap.size} ` +
        `linked=${attachmentsLinked} extracted=${entitiesExtracted}` +
        (input.runExtractionAsync ? ' (async)' : ''),
    );

    return {
      groupId: group.id,
      messagesInserted: messageRows.length,
      shadowUsersCreated,
      attachmentsUploaded: attachmentMap.size,
      attachmentsLinked,
      entitiesExtracted,
    };
  } finally {
    cleanupTempDir(tempDir);
  }
}

interface RunExtractionInput {
  db: Kysely<DB>;
  groupId: string;
  uploaderId: string;
  messages: ParsedChatMessage[];
  members: string[];
  llm: LlmService;
}

/**
 * Stable natural-key for deduping calls produced by overlapping extraction
 * windows. Read-side tools and `record_rsvp` are non-idempotent by design and
 * always return null, opting out of dedup.
 */
function dedupKey(call: ToolCall): string | null {
  const a = call.args as Record<string, unknown>;
  const s = (v: unknown) => String(v ?? '').trim().toLowerCase();
  switch (call.name) {
    case 'create_task':
      return `task:${s(a.title)}`;
    case 'save_link':
      return `link:${s(a.url)}`;
    case 'save_place':
      return `place:${s(a.name)}`;
    case 'save_media':
      return `media:${s(a.kind)}:${s(a.title)}`;
    case 'save_contact':
      return `contact:${s(a.name)}`;
    case 'create_event':
      return `event:${s(a.title)}:${s(a.startsAt)}`;
    case 'create_trip':
      return `trip:${s(a.name)}:${s(a.startDate)}`;
    case 'add_travel_leg':
      return `leg:${s(a.origin)}:${s(a.destination)}:${s(a.departAt)}`;
    case 'add_accommodation':
      return `accom:${s(a.propertyName)}:${s(a.checkinDate)}`;
    case 'add_reservation':
      return `res:${s(a.name)}:${s(a.dateTime)}`;
    case 'add_person':
      return `person:${s(a.displayName)}`;
    case 'add_important_date':
      return `date:${s(a.personName)}:${s(a.kind)}:${s(a.date)}`;
    case 'add_list_item':
    case 'delete_event':
    case 'set_leg_passenger':
    case 'set_trip_passengers':
    case 'record_rsvp':
    case 'list_tasks':
    case 'search_saves':
    case 'lookup_contact':
    case 'get_event_status':
    case 'find_events':
    case 'find_conflicts':
    case 'get_trip_status':
    case 'relay':
    case 'suggest_external_action':
    case 'list_memories':
    case 'list_people':
    case 'look_at_attachment':
    case 'start_form_fill':
    case 'complete_form_fill':
    case 'set_my_name':
    case 'set_nudge_time':
      return null;
  }
  // New tool names land in the registry from time to time; default
  // them to opting out of dedup (read-side fallback) rather than
  // silently producing collisions on a stale key.
  return null;
}

async function applyCallsSafe(
  db: Kysely<DB>,
  groupId: string,
  uploaderId: string,
  calls: ExtractedCall[],
  seenKeys: Set<string>,
): Promise<number> {
  let applied = 0;
  for (const ec of calls) {
    const key = dedupKey(ec.call);
    if (key && seenKeys.has(key)) {
      logger.debug(`whatsapp import: deduped ${ec.call.name} ${key}`);
      continue;
    }
    try {
      await applyToolCall(db, {
        groupId,
        call: ec.call,
        actorUserId: uploaderId,
        provenance: ec.provenance,
      });
      if (key) seenKeys.add(key);
      applied++;
    } catch (err) {
      logger.warn(`whatsapp import: applyToolCall failed for ${ec.call.name}`, {
        err,
      });
    }
  }
  return applied;
}

async function runExtractionSync(input: RunExtractionInput, fromWindow = 0): Promise<number> {
  const windows = windowMessages(input.messages);
  const seen = new Set<string>();
  let applied = 0;
  for (let i = fromWindow; i < windows.length; i++) {
    let calls: ExtractedCall[];
    try {
      calls = await extractFromWindow(input.llm, windows[i]!, input.members);
    } catch (err) {
      // Refused (allowance spent partway): the rest waits, from this window.
      if (isAiRefusal(err)) {
        await queueAiWork(input.db, {
          userId: input.uploaderId,
          kind: 'whatsapp_import',
          ref: input.groupId,
          payload: { fromWindow: i },
        });
        return applied;
      }
      throw err;
    }
    applied += await applyCallsSafe(input.db, input.groupId, input.uploaderId, calls, seen);
  }
  return applied;
}

/**
 * ai-backlog runner: the model pass over an imported chat that was held back,
 * rebuilt from the messages the import stored (the zip is gone by now).
 */
export async function rerunHeldBackImportExtraction(
  db: Kysely<DB>,
  uploaderId: string,
  groupId: string,
  fromWindow: number,
): Promise<number> {
  const rows = await db
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(['messages.body', 'messages.created_at', 'messages.attachment_id', 'users.display_name', 'users.username'])
    .where('messages.group_id', '=', groupId)
    .where('messages.source', '=', 'import')
    .orderBy('messages.created_at', 'asc')
    .execute();
  if (rows.length === 0) return 0;
  const messages: ParsedChatMessage[] = rows.map((r) => ({
    sentAt: new Date(r.created_at),
    sender: r.display_name || r.username || 'unknown',
    body: r.body ?? '',
    hasAttachment: r.attachment_id != null,
    attachmentFilename: null,
  }));
  const members = Array.from(new Set(messages.map((m) => m.sender)));
  const llm = await getLlmForUser(db, uploaderId, 'whatsapp_import');
  return runExtractionSync({ db, groupId, uploaderId, messages, members, llm }, fromWindow);
}

async function runExtractionBackground(input: RunExtractionInput): Promise<void> {
  const start = Date.now();
  const windows = windowMessages(input.messages);
  const seen = new Set<string>();
  let applied = 0;
  try {
    for (let i = 0; i < windows.length; i++) {
      let calls: ExtractedCall[];
      try {
        calls = await extractFromWindow(input.llm, windows[i]!, input.members);
      } catch (err) {
        if (!isAiRefusal(err)) throw err;
        await queueAiWork(input.db, {
          userId: input.uploaderId,
          kind: 'whatsapp_import',
          ref: input.groupId,
          payload: { fromWindow: i },
        });
        break;
      }
      applied += await applyCallsSafe(input.db, input.groupId, input.uploaderId, calls, seen);
      sseHub.broadcast(input.groupId, SSE.ingestProgress, {
        phase: 'extracting',
        window: i + 1,
        totalWindows: windows.length,
        entitiesSoFar: applied,
      });
    }
    sseHub.broadcast(input.groupId, SSE.ingestDone, {
      entitiesExtracted: applied,
      durationMs: Date.now() - start,
    });
    logger.info(
      `whatsapp import (async): group=${input.groupId} extracted=${applied} in ${Date.now() - start}ms`,
    );
  } catch (err) {
    logger.error('whatsapp import (async) extraction failed', { err });
    sseHub.broadcast(input.groupId, SSE.ingestDone, {
      entitiesExtracted: applied,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

interface PersonaEntry {
  userId: string;
  createdNow: boolean;
}

async function resolvePersonas(
  db: Kysely<DB>,
  messages: ParsedChatMessage[],
  uploaderId: string,
): Promise<Map<string, PersonaEntry>> {
  const uploader = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', uploaderId)
    .executeTakeFirstOrThrow();
  const uploaderDisplay = (uploader.display_name ?? uploader.username)
    .trim()
    .toLowerCase();

  const map = new Map<string, PersonaEntry>();
  const senderNames = Array.from(new Set(messages.map((m) => m.sender)));

  // Every non-uploader sender is an unconditional new shadow user (ids are
  // freshly generated here, so there's no "insert if not exists" to race) —
  // one batch insert instead of one round trip per sender.
  const createdAt = new Date().toISOString();
  const newUsers: {
    id: string;
    username: string;
    display_name: string;
    created_at: string;
    shadow: number;
  }[] = [];

  for (const name of senderNames) {
    const needle = name.trim().toLowerCase();
    if (needle === uploaderDisplay) {
      map.set(name, { userId: uploaderId, createdNow: false });
      continue;
    }

    const userId = newId('u');
    const baseUsername = slugify(name) || 'shadow';
    const username = `${baseUsername}-${userId.slice(2, 8)}`;
    newUsers.push({ id: userId, username, display_name: name, created_at: createdAt, shadow: 1 });
    map.set(name, { userId, createdNow: true });
  }

  if (newUsers.length > 0) {
    await db.insertInto('users').values(newUsers).execute();
  }

  return map;
}

async function uploadMedia(
  db: Kysely<DB>,
  opts: {
    tempDir: string;
    entries: string[];
    groupId: string;
    uploaderId: string;
  },
): Promise<Map<string, string>> {
  // Filter/classify first (cheap, sync), then read + saveFile each candidate
  // bounded-concurrent — each is independent disk + DB work. Duplicate
  // basenames still resolve last-wins in original entry order, since results
  // come back in input order and are applied to the map sequentially below.
  const candidates = opts.entries
    .map((entryName) => {
      const basename = path.basename(entryName);
      if (basename === '_chat.txt') return null;
      const classified = classifyWhatsAppFilename(basename);
      if (!classified) return null;
      const filePath = path.join(opts.tempDir, entryName);
      if (!fs.existsSync(filePath)) return null;
      return { basename, filePath, mimeType: classified.mimeType };
    })
    .filter((c): c is { basename: string; filePath: string; mimeType: string } => c !== null);

  const uploaded = await mapConcurrent(candidates, 5, async (c) => {
    const buffer = fs.readFileSync(c.filePath);
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId: opts.groupId },
      uploadedBy: opts.uploaderId,
      filename: c.basename,
      mimeType: c.mimeType,
      buffer,
      index: false,
    });
    return { basename: c.basename, attachmentId: att.id };
  });

  const map = new Map<string, string>();
  for (const u of uploaded) map.set(u.basename, u.attachmentId);
  return map;
}
