import type { Kysely } from 'kysely';
import { z } from 'zod';

import { SSE, type BotCard, type ImageMeta } from '@chord/kernel';

import { env } from '../../config/env.js';
import { readBlob } from '../../db/crypto/index.js';
import { logger } from '../../config/logging.js';
import { debugSnippet } from '../../utils/prompt-log.js';
import type { DB, MessagesTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { parseJsonObject } from '../../utils/json-repair.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { getLlmForUser } from '../llm/factory.js';
import type { LlmContentPart, LlmMessage } from '../llm/types.js';
import { rowToMessage } from '../messages.service.js';
import { sseHub } from '../sse.hub.js';
import { createProposal } from '../proposals.service.js';
import { buildProposalActionCard } from './proposal-cards.js';

const isoDateTime = z.string().min(10).max(40);

const ContentPlan = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        details: z.string().max(2000).optional(),
        assigneeName: z.string().max(80).optional(),
        dueAt: isoDateTime.optional(),
        remindAt: isoDateTime.optional(),
        remindCue: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .default([]),
  listAdds: z
    .array(
      z.object({
        listName: z.string().min(1).max(80),
        items: z.array(z.string().min(1).max(200)).min(1).max(20),
      }),
    )
    .max(10)
    .default([]),
  events: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        startsAt: isoDateTime,
        location: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .default([]),
  saves: z
    .array(
      z.object({
        kind: z.enum(['link', 'place', 'media', 'contact']),
        title: z.string().min(1).max(200),
        url: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
        // For kind=media:
        mediaKind: z.enum(['book', 'podcast', 'show', 'movie', 'article']).optional(),
      }),
    )
    .max(10)
    .default([]),
});

const SKIP_CAPTION_RE =
  /\b(selfie|portrait|baby|toddler|kid|pet|cat|dog|sunset|sunrise|landscape|scenery|meme|painting|drawing)\b/i;

const SYSTEM = [
  'You analyse a screenshot the user uploaded to a family/group chat.',
  'Identify ACTIONABLE items AND SAVE-WORTHY content: tasks, list adds, events, and bookmarks the user likely wants to remember.',
  'Reply with ONLY a single JSON object (no prose, no code fences) with these exact keys:',
  '{ "tasks": [...], "listAdds": [...], "events": [...], "saves": [...] }',
  '',
  'Schema:',
  '  tasks[]: { "title": string, "details"?: string, "assigneeName"?: string,',
  '             "dueAt"?: ISO-8601 datetime, "remindAt"?: ISO-8601 datetime, "remindCue"?: string }',
  '    Use remindAt for time-bound reminders ("pick up Sam at 3pm Friday" → task with remindAt).',
  '  listAdds[]: { "listName": string, "items": string[] }',
  '    Use for shopping/grocery/packing items. Pick a sensible existing list name when obvious (e.g. "Costco", "Groceries").',
  '  events[]: { "title": string, "startsAt": ISO-8601 datetime, "location"?: string }',
  '    Use for invitations, meetings, appointments, parent-teacher conferences, school events.',
  '  saves[]: { "kind": "link"|"place"|"media"|"contact", "title": string, "url"?: string,',
  '            "note"?: string, "tags"?: string[], "mediaKind"?: "book"|"podcast"|"show"|"movie"|"article" }',
  '    kind=link: a tweet, article, blog post, product page — set url if visible.',
  '    kind=place: a restaurant, bar, cafe, park, shop, landmark the user might want to visit/remember. INCLUDE a cuisine tag (italian, thai, indian, etc.) for restaurants.',
  '    kind=media: a book cover, movie/show poster, podcast page, recipe — set mediaKind appropriately.',
  '    kind=contact: a SINGLE person\'s contact card / business card / "scan to add" snippet — name in title; a real phone/email/org in note.',
  '    NOT a contact: a roster or table of frequent-flyer, loyalty, rewards, membership, account, or confirmation numbers. Those numbers are NOT phone numbers — never store them as contacts. Leave such a file unsaved; it stays indexed and answerable from its contents.',
  '    Be conservative: only emit a save when the user clearly screenshotted the item to remember it. Personal photos, memes, and chat screenshots are NOT saves.',
  '',
  'Use ISO-8601 datetimes with timezone offset where derivable; otherwise YYYY-MM-DDTHH:MM:SS.',
  'Empty arrays for sections with nothing actionable. Be conservative — if unsure, omit. Never invent dates, times, or URLs.',
  'If the screenshot is a travel booking confirmation, leave events[] and saves[] empty (handled separately).',
].join('\n');

/**
 * Insert the bundle announcement row, *without* broadcasting yet. The
 * row has to exist before proposals can FK to it, but we don't want
 * Chord clients to render it until cards are attached (otherwise the
 * mobile pills + TG buttons land in a second beat after the bubble).
 */
async function insertBundleAnnouncement(
  db: Kysely<DB>,
  opts: {
    id: string;
    groupId: string;
    body: string;
    attachmentId: string;
  },
): Promise<MessagesTable> {
  const row: MessagesTable = {
    id: opts.id,
    group_id: opts.groupId,
    sender_id: null,
    kind: 'bot',
    body: opts.body,
    attachment_id: opts.attachmentId,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 0,
  };
  await db.insertInto('messages').values(row).execute();
  return row;
}

async function finalizeBundleAnnouncement(
  db: Kysely<DB>,
  row: MessagesTable,
  cards: BotCard[],
): Promise<void> {
  // ADR 0029 — cards must persist *before* the SSE.message broadcast so
  // the outbound publisher's async forward reads them when mirroring to
  // bound bridges. Skip the insert entirely on an empty card list to
  // keep the query out of hot path.
  if (cards.length > 0) {
    await db
      .insertInto('message_cards')
      .values({
        message_id: row.id,
        cards_json: JSON.stringify(cards),
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  sseHub.broadcast(row.group_id, SSE.message, rowToMessage(row));
}

/**
 * Auto-extract actionable items (tasks, list adds, events) from an uploaded
 * image and stage them as proposals (ADR 0009) under one bundle so the user
 * confirms or rejects as a unit.
 *
 * Sibling to `trip_classifier.classifyAndAutoFileAttachment`, which handles
 * travel/restaurant/movie/recipe/calendar-grid extraction in commit mode. This
 * one focuses on day-to-day actionables that screenshots commonly capture
 * (emails, school notices, todo lists) — gated by user confirmation because
 * OCR-derived dates and titles need a sanity check.
 */
export async function classifyAndProposeContent(
  db: Kysely<DB>,
  opts: {
    attachmentId: string;
    groupId: string;
    uploadedBy: string;
    filename: string;
    mimeType: string;
    imagePath: string;
    imageMeta: ImageMeta | null;
  },
): Promise<void> {
  const m = opts.imageMeta;
  if (m) {
    if (m.ocrChars < 30 && m.keyFacts.length === 0) {
      logger.info(`content_classifier: skip (low signal) ${opts.filename}`);
      return;
    }
    if (m.caption && SKIP_CAPTION_RE.test(m.caption)) {
      logger.info(`content_classifier: skip (personal photo) ${opts.filename}`);
      return;
    }
  }

  let buf: Buffer;
  try {
    buf = await readBlob(opts.imagePath);
  } catch (err) {
    logger.warn('content_classifier: read failed', { err, path: opts.imagePath });
    return;
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `File: ${opts.filename}` },
        { type: 'image', mimeType: opts.mimeType, base64: buf.toString('base64') },
      ] satisfies LlmContentPart[],
    },
  ];

  const llm = await getLlmForUser(db, opts.uploadedBy, 'content_classify');
  let raw: string;
  try {
    raw = await llm.complete(messages, { maxTokens: 1500, temperature: 0 });
  } catch (err) {
    logger.warn('content_classifier llm failed', { err, filename: opts.filename });
    return;
  }
  const json = parseJsonObject(raw);
  if (!json) {
    logger.warn('content_classifier: unparseable JSON', { raw: debugSnippet(raw, 200, env.NODE_ENV) });
    return;
  }
  const v = ContentPlan.safeParse(json);
  if (!v.success) {
    logger.warn('content_classifier: invalid shape', {
      issues: v.error.issues.map((i) => `${i.path.join('.')}:${i.message}`),
    });
    return;
  }
  const plan = v.data;
  const total =
    plan.tasks.length + plan.listAdds.length + plan.events.length + plan.saves.length;
  if (total === 0) return;

  const bundleId = newId('bundle');
  const provenance = `attachment:${opts.attachmentId}`;

  const summary = [
    plan.tasks.length ? `${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}` : null,
    plan.listAdds.length ? `${plan.listAdds.length} list update${plan.listAdds.length === 1 ? '' : 's'}` : null,
    plan.events.length ? `${plan.events.length} event${plan.events.length === 1 ? '' : 's'}` : null,
    plan.saves.length ? `${plan.saves.length} save${plan.saves.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  // Insert the announcement row first so proposals can FK to it via
  // `proposed_by_message_id`. We defer the SSE broadcast until cards
  // are attached (ADR 0029) — clients should see the bubble + buttons
  // in one beat, not the bubble first and the buttons later.
  const announcementId = newId('m');
  const announcementRow = await insertBundleAnnouncement(db, {
    id: announcementId,
    groupId: opts.groupId,
    // No "tap": on WhatsApp this may arrive as text with a typed YES / NO.
    body: `📎 I see ${summary} in this screenshot. Want me to add ${total === 1 ? 'it' : 'them'}?`,
    attachmentId: opts.attachmentId,
  });
  const stagedProposals: Array<{ id: string; toolName: string; args: unknown }> = [];

  const stage = async (
    toolName:
      | 'create_task'
      | 'add_list_item'
      | 'create_event'
      | 'save_link'
      | 'save_place'
      | 'save_media'
      | 'save_contact',
    args: unknown,
  ) => {
    const p = await createProposal(db, {
      groupId: opts.groupId,
      proposedByUserId: opts.uploadedBy,
      proposedByMessageId: announcementId,
      toolName,
      args,
      provenance,
      bundleId,
    });
    stagedProposals.push({ id: p.id, toolName, args });
    sseHub.broadcast(opts.groupId, SSE.proposalCreated, p);
  };

  for (const t of plan.tasks) await stage('create_task', t);
  for (const l of plan.listAdds) await stage('add_list_item', l);
  for (const e of plan.events) await stage('create_event', e);
  for (const s of plan.saves) {
    // Map our internal `saves[]` shape to the corresponding bot tool's
    // arg schema. save_link, save_place, save_media, save_contact all
    // share { title, tags?, note? } and diverge on the kind-specific
    // fields (url for link, mediaKind for media, etc.).
    if (s.kind === 'link') {
      // save_link requires a real URL (zod .url()). When the screenshot
      // doesn't expose one, downgrade to a media/article save so the
      // user still gets a record.
      if (s.url && /^https?:\/\//i.test(s.url)) {
        await stage('save_link', {
          title: s.title,
          url: s.url,
          tags: s.tags,
          note: s.note,
        });
      } else {
        await stage('save_media', {
          kind: 'article',
          title: s.title,
          note: s.note,
        });
      }
    } else if (s.kind === 'place') {
      await stage('save_place', {
        name: s.title,
        tags: s.tags,
        note: s.note,
      });
    } else if (s.kind === 'media') {
      await stage('save_media', {
        kind: s.mediaKind ?? 'article',
        title: s.title,
        note: s.note,
      });
    } else if (s.kind === 'contact') {
      await stage('save_contact', {
        name: s.title,
        note: s.note,
        tags: s.tags,
      });
    }
  }
  // Now that every proposal is staged, attach a per-proposal action
  // card with [confirm, reject] buttons to the announcement. The
  // mobile app ignores these cards (proposal pills cover the same
  // surface); TG renders each card as a 2-button inline-keyboard row.
  const cards: BotCard[] = stagedProposals.map((p) =>
    buildProposalActionCard(p.id, p.toolName, p.args),
  );
  await finalizeBundleAnnouncement(db, announcementRow, cards);
  logger.info(
    `content_classifier: proposed ${total} actions from ${opts.filename} bundle=${bundleId}`,
  );
}

