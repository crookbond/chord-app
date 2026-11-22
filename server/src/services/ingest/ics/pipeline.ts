/**
 * .ics ingest pipeline (ADR 0013).
 *
 * Persists the uploaded file as an attachment for provenance, parses VEVENTs
 * via `node-ical`, and runs each one through `applyToolCall` as a
 * `create_event` with `externalUid` set for dedup. Per-event proactive
 * nudges (ADR 0012) are suppressed; we post a single batch summary to chat
 * at the end.
 */
import AdmZip from 'adm-zip';
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';

import { logger } from '../../../config/logging.js';
import type { DB } from '../../../db/schema.js';
import { mapConcurrent } from '../../../utils/concurrency.js';
import { newId } from '../../../utils/ids.js';
import { saveFile } from '../../attachments.service.js';
import { getDefaultPersona } from '../../bot-personas.service.js';
import { applyToolCall } from '../../bot/executor.js';
import { sseHub } from '../../sse.hub.js';

import { parseIcsBuffer, type ParseIcsResult } from './parse.js';

export interface ImportIcsInput {
  groupId: string;
  uploaderId: string;
  filename: string;
  /** Raw .ics text or a .zip containing one or more .ics files (Google
   * Takeout Calendar export shape). Branch is decided on filename + magic. */
  buffer: Buffer;
  /**
   * Post the 📅 batch-summary bot message to the group's chat. Default true
   * (the upload auto-ingest path). The `import_calendar` bot tool passes false
   * so the bot's own turn reply is the single user-visible confirmation
   * instead of a duplicate (ADR 0050). Per-event `event.created` SSE fires
   * either way.
   */
  postSummary?: boolean;
}

/** PK\03\04 magic — matches a zip header. */
function looksLikeZip(filename: string, buf: Buffer): boolean {
  if (filename.toLowerCase().endsWith('.zip')) return true;
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** Extract every `.ics` member from a zip into [{name, buffer}]. */
function extractIcsFromZip(buf: Buffer): { name: string; data: Buffer }[] {
  const zip = new AdmZip(buf);
  const out: { name: string; data: Buffer }[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.toLowerCase().endsWith('.ics')) continue;
    out.push({ name: entry.entryName, data: entry.getData() });
  }
  return out;
}

export interface ImportIcsResult {
  attachmentId: string;
  totalVEvents: number;
  eventsCreated: number;
  eventsDeduped: number;
  skippedRecurring: number;
  skippedCancelled: number;
  skippedMalformed: number;
  skippedOverCap: number;
}

export async function importIcs(
  db: Kysely<DB>,
  input: ImportIcsInput,
): Promise<ImportIcsResult> {
  const startedAt = Date.now();
  const postSummary = input.postSummary ?? true;

  // Persist the original file so the "Why this entity?" drill-down can point
  // back to it later. Skip indexing — neither .ics nor zip is useful for retrieval.
  const isZip = looksLikeZip(input.filename, input.buffer);
  const attachment = await saveFile(db, {
    scope: { kind: 'group', groupId: input.groupId },
    uploadedBy: input.uploaderId,
    filename: input.filename,
    mimeType: isZip ? 'application/zip' : 'text/calendar',
    buffer: input.buffer,
    index: false,
  });

  // Build the list of (sourceLabel, parsed) we'll iterate. A zip becomes one
  // entry per .ics member (Google Takeout: usually one .ics per calendar).
  const parsedSources: { sourceLabel: string; parsed: ParseIcsResult }[] = [];
  if (isZip) {
    const members = extractIcsFromZip(input.buffer);
    if (members.length === 0) {
      const summary = `📅 \`${input.filename}\`: zip contained no .ics files.`;
      if (postSummary) await postBotMessage(db, input.groupId, summary);
      sseHub.broadcast(input.groupId, SSE.ingestDone, {
        entitiesExtracted: 0,
        durationMs: Date.now() - startedAt,
      });
      return {
        attachmentId: attachment.id,
        totalVEvents: 0,
        eventsCreated: 0,
        eventsDeduped: 0,
        skippedRecurring: 0,
        skippedCancelled: 0,
        skippedMalformed: 0,
        skippedOverCap: 0,
      };
    }
    for (const m of members) {
      parsedSources.push({ sourceLabel: m.name, parsed: parseIcsBuffer(m.data) });
    }
  } else {
    parsedSources.push({ sourceLabel: input.filename, parsed: parseIcsBuffer(input.buffer) });
  }

  let eventsCreated = 0;
  let eventsDeduped = 0;
  const aggregate: ParseIcsResult = {
    events: [],
    method: null,
    cancelledUids: [],
    replies: [],
    totalVEvents: 0,
    skippedRecurring: 0,
    skippedCancelled: 0,
    skippedMalformed: 0,
    skippedOverCap: 0,
  };

  for (const { sourceLabel, parsed } of parsedSources) {
    aggregate.totalVEvents += parsed.totalVEvents;
    aggregate.skippedRecurring += parsed.skippedRecurring;
    aggregate.skippedCancelled += parsed.skippedCancelled;
    aggregate.skippedMalformed += parsed.skippedMalformed;
    aggregate.skippedOverCap += parsed.skippedOverCap;

    // Each VEVENT dedups (externalUid, then title/time fuzzy match) and
    // inserts independently — no ordering dependency between one event and
    // the next, and a duplicate externalUid within the same import is caught
    // by the DB's own `events_external_uid_per_group` unique index even if
    // two concurrent calls race past the dedup SELECT. Bounded modestly since
    // each call does several DB round trips of its own.
    const outcomes = await mapConcurrent(parsed.events, 5, async (ev) => {
      try {
        const result = await applyToolCall(db, {
          groupId: input.groupId,
          actorUserId: input.uploaderId,
          provenance: `Imported from ${sourceLabel} (UID ${ev.uid})`,
          suppressEventNudges: true,
          call: {
            name: 'create_event',
            args: {
              title: ev.title,
              startsAt: ev.startsAt,
              ...(ev.endsAt ? { endsAt: ev.endsAt } : {}),
              ...(ev.allDay ? { allDay: true } : {}),
              location: ev.location,
              externalUid: ev.uid,
            },
          },
        });
        const data = result?.data as { deduped?: boolean } | undefined;
        return data?.deduped ? ('deduped' as const) : ('created' as const);
      } catch (err) {
        logger.warn('ics ingest: applyToolCall failed', {
          err,
          filename: input.filename,
          source: sourceLabel,
          uid: ev.uid,
        });
        return 'error' as const;
      }
    });
    for (const outcome of outcomes) {
      if (outcome === 'created') eventsCreated++;
      else if (outcome === 'deduped') eventsDeduped++;
    }
  }

  // One summary message in the target group's chat. Acts as the user-visible
  // confirmation that the import landed; SSE listeners will already have seen
  // each event.created event individually.
  const summary = formatSummary(input.filename, eventsCreated, eventsDeduped, aggregate, parsedSources.length);
  if (postSummary) await postBotMessage(db, input.groupId, summary);

  sseHub.broadcast(input.groupId, SSE.ingestDone, {
    entitiesExtracted: eventsCreated,
    durationMs: Date.now() - startedAt,
  });

  logger.info(
    `ics ingest: file=${input.filename} sources=${parsedSources.length} created=${eventsCreated} deduped=${eventsDeduped} ` +
      `recurring=${aggregate.skippedRecurring} cancelled=${aggregate.skippedCancelled} ` +
      `malformed=${aggregate.skippedMalformed}`,
  );

  return {
    attachmentId: attachment.id,
    totalVEvents: aggregate.totalVEvents,
    eventsCreated,
    eventsDeduped,
    skippedRecurring: aggregate.skippedRecurring,
    skippedCancelled: aggregate.skippedCancelled,
    skippedMalformed: aggregate.skippedMalformed,
    skippedOverCap: aggregate.skippedOverCap,
  };
}

function formatSummary(
  filename: string,
  created: number,
  deduped: number,
  parsed: { skippedRecurring: number; skippedCancelled: number; skippedMalformed: number; skippedOverCap: number },
  sourceCount: number,
): string {
  const parts: string[] = [];
  const fromBit =
    sourceCount > 1
      ? `\`${filename}\` (${sourceCount} calendars)`
      : `\`${filename}\``;
  parts.push(
    `📅 Imported **${created}** event${created === 1 ? '' : 's'} from ${fromBit}.`,
  );
  if (deduped > 0) {
    parts.push(`Skipped ${deduped} already on the calendar.`);
  }
  const otherSkips =
    parsed.skippedRecurring + parsed.skippedCancelled + parsed.skippedMalformed;
  if (otherSkips > 0) {
    const bits: string[] = [];
    if (parsed.skippedRecurring) bits.push(`${parsed.skippedRecurring} recurring overrides`);
    if (parsed.skippedCancelled) bits.push(`${parsed.skippedCancelled} cancelled`);
    if (parsed.skippedMalformed) bits.push(`${parsed.skippedMalformed} malformed`);
    parts.push(`Also skipped: ${bits.join(', ')}.`);
  }
  if (parsed.skippedOverCap > 0) {
    parts.push(
      `Hit the per-import cap — ${parsed.skippedOverCap} more events were not imported. Upload again to continue.`,
    );
  }
  return parts.join(' ');
}

async function postBotMessage(
  db: Kysely<DB>,
  groupId: string,
  body: string,
): Promise<void> {
  const id = newId('m');
  const createdAt = new Date().toISOString();
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: createdAt,
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: getDefaultPersona().id,
      is_proactive: 0,
    })
    .execute();
  sseHub.broadcast(groupId, SSE.message, {
    id,
    groupId,
    senderId: null,
    kind: 'bot',
    body,
    createdAt,
    mentionsBot: false,
  });
}
