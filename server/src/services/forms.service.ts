/**
 * PR-J — School-form auto-fill.
 *
 * Pipeline: extract AcroForm field schema from a PDF → gather what we know
 * about the user (memories, saved people + dates, contacts, indexed
 * attachments like vaccination records) → ask the LLM to map fields to
 * known values with provenance → persist as a draft → user fills gaps in
 * chat → write values back into the PDF and return a downloadable copy.
 *
 * AcroForm is the v1 path. Flat-scan vision-coord overlay is deferred —
 * most modern school forms expose AcroForm fields. When AcroForm is
 * absent we surface the limitation rather than guess at coordinates.
 */

import path from 'node:path';

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } from 'pdf-lib';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import {
  type Form,
  type FormField,
  type FormSchema,
  FormSchemaZ,
  type ResolvedField,
} from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { parseJsonArray } from '../utils/json-repair.js';
import { logger } from '../config/logging.js';
import { readBlob } from '../db/crypto/index.js';
import {
  absolutePathFor,
  getAttachment,
  saveFile,
} from './attachments.service.js';
import { listMemoriesForUser } from './memory.service.js';
import { labelMemorySubjects } from './memory-notices.service.js';
import { listPeopleForUser } from './people.service.js';
import { listSaves, listSavesForUser } from './saves.service.js';
import type { LlmService } from './llm/types.js';
import type { LlmMessage } from './llm/types.js';

// How many indexed records autofill may pull from, and how much text per
// record. Records are the source of truth for fields like vaccination dates
// and policy numbers, so keep the budget generous.
const FORMS_DOC_CAP = 10;
const FORMS_DOC_EXCERPT_CHARS = 6000;

// ── Schema extraction ───────────────────────────────────────────────

function inferLabel(rawName: string): string {
  // AcroForm field names are often "Student.Name" / "EmergencyContact_Phone"
  // / "p1_field_3". Try to humanize; fall back to the raw name.
  const cleaned = rawName.replace(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function inferSection(rawName: string): string | undefined {
  // Names that look like "Student.Name" or "Emergency_Contact_Phone" carry a
  // section prefix; harvest it.
  const m = rawName.match(/^([A-Za-z][A-Za-z]+)[._]/);
  return m ? m[1].replace(/([a-z])([A-Z])/g, '$1 $2') : undefined;
}

/**
 * Pull current values from any AcroForm fields that already have content
 * set — used when a user uploads a partially-filled or prior-year form
 * as a starting point. Returns a map keyed by AcroForm field name plus a
 * sibling map keyed by humanized label (so callers can cross-match
 * against other forms whose field names differ but labels overlap).
 */
export async function extractFilledValues(
  pdfBuffer: Buffer,
): Promise<{ byName: Record<string, string>; byLabel: Record<string, string> }> {
  const empty = { byName: {}, byLabel: {} };
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch {
    return empty;
  }
  const form = pdf.getForm();
  const byName: Record<string, string> = {};
  const byLabel: Record<string, string> = {};
  for (const f of form.getFields()) {
    const name = f.getName();
    let value: string | null = null;
    if (f instanceof PDFTextField) {
      value = f.getText() ?? null;
    } else if (f instanceof PDFCheckBox) {
      value = f.isChecked() ? 'yes' : null;
    } else if (f instanceof PDFDropdown) {
      const sel = f.getSelected();
      value = sel.length > 0 ? sel.join(', ') : null;
    } else if (f instanceof PDFRadioGroup) {
      value = f.getSelected() ?? null;
    }
    if (value && value.trim()) {
      byName[name] = value.trim();
      byLabel[normalizeLabel(inferLabel(name))] = value.trim();
    }
  }
  return { byName, byLabel };
}

/** Lowercase and strip non-alphanumerics so two forms with similar labels match. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function extractFormSchema(pdfBuffer: Buffer): Promise<FormSchema | null> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch (err) {
    logger.warn('forms: failed to load pdf', { err });
    return null;
  }
  const form = pdf.getForm();
  const acroFields = form.getFields();
  if (acroFields.length === 0) return null;

  const fields: FormField[] = acroFields.map((f) => {
    const name = f.getName();
    const label = inferLabel(name);
    const section = inferSection(name);
    if (f instanceof PDFCheckBox) {
      return { name, label, type: 'checkbox', section };
    }
    if (f instanceof PDFDropdown) {
      return { name, label, type: 'choice', section, options: f.getOptions() };
    }
    if (f instanceof PDFRadioGroup) {
      return { name, label, type: 'choice', section, options: f.getOptions() };
    }
    if (f instanceof PDFTextField) {
      const lower = name.toLowerCase();
      const type = /\b(dob|date_of_birth|birthdate|date)\b/.test(lower) ? 'date' : 'text';
      return { name, label, type, section };
    }
    return { name, label, type: 'text', section };
  });

  return { fields, pageCount: pdf.getPageCount(), acroform: true };
}

// ── Knowledge gathering ─────────────────────────────────────────────

/** A saved fact, with who it is about (ADR 0333). */
export interface KnowledgeFact {
  about: string;
  key: string;
  value: string;
  /** The fact is about the person this form is for. */
  formSubject: boolean;
}

export interface KnowledgeBundle {
  facts: KnowledgeFact[];
  people: {
    displayName: string;
    notes: string | null;
    importantDates: { kind: string; date: string }[];
  }[];
  contacts: { title: string; tags: string[]; note: string | null }[];
  attachmentSummaries: { filename: string; summary: string; excerpt: string | null }[];
  /**
   * Cross-form prior answers, keyed by normalized field label so a new
   * form with field "Student Date of Birth" can match an answer from a
   * prior form whose field was "Child DOB". Each entry carries the
   * source so the LLM can cite "from your 2025 immunization form".
   */
  priorAnswersByLabel: Array<{
    label: string;
    value: string;
    sourceFormTitle: string;
    sourceSubjectName?: string;
    sameSubject: boolean;
  }>;
  /** Values already present in the form the user just uploaded — treated as confirmed. */
  preFilled: Record<string, string>;
}

/**
 * Pull every plausibly-relevant fact from the user's record. We err
 * generously here — the LLM resolution pass picks what fits each
 * field. Cost is one local read; cheap.
 */
export async function gatherKnowledge(
  db: Kysely<DB>,
  opts: {
    userId: string;
    groupId: string;
    subjectPersonId?: string | null;
    /** Pre-filled values harvested from the source PDF, treated as confirmed. */
    preFilled?: Record<string, string>;
  },
): Promise<KnowledgeBundle> {
  const [userMemories, people, groupSaves, userSaves] = await Promise.all([
    listMemoriesForUser(db, opts.userId, { status: 'confirmed' }).catch(() => []),
    listPeopleForUser(db, opts.userId).catch(() => []),
    listSaves(db, opts.groupId).catch(() => []),
    listSavesForUser(db, opts.userId).catch(() => []),
  ]);

  // ADR 0333 — every fact names who it is about, and the form's own person
  // is marked, so one family member's ID or date never fills another's form.
  const [labels, subject] = await Promise.all([
    labelMemorySubjects(db, userMemories),
    opts.subjectPersonId
      ? db.selectFrom('people').select(['display_name']).where('id', '=', opts.subjectPersonId).executeTakeFirst()
      : undefined,
  ]);
  const subjectName = subject?.display_name?.trim().toLowerCase() ?? null;
  const facts: KnowledgeFact[] = userMemories.map((m) => {
    const about = labels.get(m.id) ?? 'Someone';
    return {
      about,
      key: m.key,
      value: m.value,
      formSubject:
        !!opts.subjectPersonId &&
        ((m.subjectType === 'person' && m.subjectId === opts.subjectPersonId) ||
          (subjectName !== null && about.trim().toLowerCase() === subjectName)),
    };
  });

  const contacts = [...groupSaves, ...userSaves]
    .filter((s) => s.kind === 'contact')
    .map((s) => ({ title: s.title, tags: s.tags, note: s.note ?? null }));

  // Pull text from attachments tagged or summarized as vaccination /
  // insurance / immunization records. These are the documents school
  // forms most often need values from.
  const attachmentRows = await db
    .selectFrom('attachments')
    .select(['id', 'filename', 'summary', 'extracted_text', 'scope_kind', 'scope_id'])
    .where((eb) =>
      eb.or([
        eb('scope_kind', '=', 'group').and('scope_id', '=', opts.groupId),
        eb('scope_kind', '=', 'user').and('scope_id', '=', opts.userId),
      ]),
    )
    .where('indexed_at', 'is not', null)
    .execute();
  const RELEVANCE = /(vaccin|immuniz|insurance|policy|physical|medical|health|school)/i;
  const attachmentSummaries = attachmentRows
    .filter((a) => RELEVANCE.test(a.filename) || (a.summary && RELEVANCE.test(a.summary)))
    .slice(0, FORMS_DOC_CAP)
    .map((a) => ({
      filename: a.filename,
      summary: a.summary ?? '',
      excerpt: a.extracted_text ? a.extracted_text.slice(0, FORMS_DOC_EXCERPT_CHARS) : null,
    }));

  // Prior answers from every filled form in this group (any family
  // member). Keyed by normalized field label so cross-form matching works
  // even when AcroForm field names differ. Same-subject answers are
  // tagged so the LLM can prefer them; cross-subject ones (e.g. spouse's
  // insurance for the kid) are clearly cited so the LLM knows to
  // confirm with the user before reusing.
  const priorRows = await db
    .selectFrom('forms')
    .leftJoin('people', 'people.id', 'forms.subject_person_id')
    .select([
      'forms.title as title',
      'forms.subject_person_id as subjectId',
      'forms.schema_json as schemaJson',
      'forms.answers_json as answersJson',
      'forms.updated_at as updatedAt',
      'people.display_name as subjectName',
    ])
    .where('forms.group_id', '=', opts.groupId)
    .where('forms.status', '=', 'filled')
    .orderBy('forms.updated_at', 'desc')
    .limit(10)
    .execute();
  const priorAnswersByLabel: KnowledgeBundle['priorAnswersByLabel'] = [];
  const seenLabelValue = new Set<string>();
  for (const row of priorRows) {
    let schema: FormSchema;
    let answers: Record<string, string>;
    try {
      schema = FormSchemaZ.parse(JSON.parse(row.schemaJson));
      answers = JSON.parse(row.answersJson) as Record<string, string>;
    } catch {
      continue;
    }
    const labelByName = new Map(schema.fields.map((f) => [f.name, f.label]));
    const sameSubject = !!(opts.subjectPersonId && row.subjectId === opts.subjectPersonId);
    for (const [name, value] of Object.entries(answers)) {
      const label = labelByName.get(name);
      if (!label || !value) continue;
      const key = `${normalizeLabel(label)}::${value}`;
      if (seenLabelValue.has(key)) continue;
      seenLabelValue.add(key);
      priorAnswersByLabel.push({
        label,
        value,
        sourceFormTitle: row.title,
        sourceSubjectName: row.subjectName ?? undefined,
        sameSubject,
      });
    }
  }
  // Cap to keep prompt bounded.
  priorAnswersByLabel.splice(60);

  return {
    facts,
    people: people.map((p) => ({
      displayName: p.displayName,
      notes: p.notes,
      importantDates: p.importantDates.map((d) => ({ kind: d.kind, date: d.date })),
    })),
    contacts,
    attachmentSummaries,
    priorAnswersByLabel,
    preFilled: opts.preFilled ?? {},
  };
}

// ── LLM-driven resolution ───────────────────────────────────────────

const ResolvedFieldZ = z.object({
  name: z.string(),
  value: z.union([z.string(), z.null()]),
  status: z.enum(['confirmed', 'inferred', 'unknown']),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

/**
 * Single LLM call: given the schema and the knowledge bundle, return
 * a value + provenance per field. The model is instructed never to
 * guess — unknowns must come back as `value: null, status: 'unknown'`.
 */
export async function resolveFields(
  schema: FormSchema,
  knowledge: KnowledgeBundle,
  /** Whose model fills the form (ADR 0257). */
  llm: LlmService,
): Promise<ResolvedField[]> {
  const prompt = buildResolutionPrompt(schema, knowledge);
  let raw: string;
  try {
    raw = await llm.complete(prompt, { maxTokens: 4000, temperature: 0 });
  } catch (err) {
    logger.warn('forms: llm resolution failed', { err });
    return schema.fields.map((f) => ({
      name: f.name,
      label: f.label,
      section: f.section,
      value: null,
      status: 'unknown',
      confidence: 0,
    }));
  }
  const parsed = parseJsonArray(raw);
  if (!parsed) {
    return schema.fields.map((f) => ({
      name: f.name,
      label: f.label,
      section: f.section,
      value: null,
      status: 'unknown',
      confidence: 0,
    }));
  }
  const byName = new Map<string, ResolvedField>();
  const fieldByName = new Map(schema.fields.map((f) => [f.name, f]));
  for (const row of parsed) {
    const r = ResolvedFieldZ.safeParse(row);
    if (!r.success) continue;
    const field = fieldByName.get(r.data.name);
    if (!field) continue;
    // Hard guard: never_guess. Below 0.9 confidence demotes to unknown
    // even if the LLM tagged it confirmed.
    const status =
      r.data.confidence >= 0.9
        ? r.data.status
        : r.data.confidence >= 0.6
          ? 'inferred'
          : 'unknown';
    byName.set(r.data.name, {
      name: r.data.name,
      label: field.label,
      section: field.section,
      value: status === 'unknown' ? null : r.data.value,
      status,
      source: r.data.source,
      confidence: r.data.confidence,
    });
  }
  // Backfill unknowns for any field the LLM omitted.
  return schema.fields.map(
    (f) =>
      byName.get(f.name) ?? {
        name: f.name,
        label: f.label,
        section: f.section,
        value: null,
        status: 'unknown' as const,
        confidence: 0,
      },
  );
}

function buildResolutionPrompt(schema: FormSchema, k: KnowledgeBundle): LlmMessage[] {
  const system = [
    'You fill out forms by mapping fields to a provided knowledge base.',
    'For each form field below, return the value if you can confirm it from the knowledge base. NEVER guess.',
    '',
    'Confidence calibration:',
    '  0.95+ — value is in the knowledge base verbatim or is a trivial transformation (e.g. ISO date "2017-05-12" → "05/12/2017").',
    '  0.8-0.9 — clearly inferable (e.g. compute Age from DOB + today; format Phone).',
    '  0.6-0.8 — plausible but uncertain (e.g. one of several possible parents).',
    '  Below 0.6 — DO NOT FILL. Return value=null, status="unknown".',
    '',
    'Return ONE row per field, JSON array only. Schema:',
    '  [{ "name": "<field_name>", "value": <string|null>, "status": "confirmed"|"inferred"|"unknown", "source": "<short citation>", "confidence": <0..1> }]',
    'No prose, no markdown.',
    '',
    "Examples of `source`: \"saved fact: Maya / allergy\", \"saved person: Ananya / dob\", \"contact tag: physician\", \"vaccination_record.pdf\", \"prior form: 2025 Physical\".",
    '',
    'IMPORTANT — cross-subject reuse:',
    '  - When a prior-form answer is tagged [SAME SUBJECT], reuse it freely (status=confirmed).',
    '  - When tagged [from <other person>\'s form], think about whether the value is family-shared. INSURANCE (provider, policy/group/member ID, subscriber name) is almost always shared across the household — reuse with confidence ~0.85 (status=inferred) and cite the source person ("from spouse\'s form, likely shared insurance"). PHYSICIAN, EMERGENCY CONTACT, ADDRESS, HOME PHONE are also commonly shared. Per-person fields like NAME, DOB, SCHOOL, GRADE, IMMUNIZATION DATES are NOT shared — leave those unknown rather than copying.',
    '  - When the source PDF was already partially filled (Pre-filled values block), treat those as confirmed verbatim.',
  ].join('\n');

  const knowledgeText = [
    'KNOWLEDGE BASE',
    '',
    'Saved facts (each starts with WHO it is about; a line tagged [FORM SUBJECT] is about the person this form is for). ' +
      "Fill a per-person field (name, birth date, ID or passport or Global Entry number, school, grade) ONLY from the form subject's own lines; " +
      "never from another person's line. Household lines (\"Family\") may fill shared fields such as address:",
    ...k.facts.map((f) => `  - ${f.about} · ${f.key}: ${f.value}${f.formSubject ? ' [FORM SUBJECT]' : ''}`),
    '',
    'Saved people (family / contacts the user has recorded):',
    ...k.people.map((p) => {
      const dates = p.importantDates.map((d) => `${d.kind}=${d.date}`).join(', ');
      return `  - ${p.displayName}${p.notes ? ` (${p.notes})` : ''}${dates ? ` [${dates}]` : ''}`;
    }),
    '',
    'Contacts (saved with kind=contact, may include physician / emergency / insurance):',
    ...k.contacts.map(
      (c) =>
        `  - ${c.title}${c.tags.length ? ` [${c.tags.join(', ')}]` : ''}${
          c.note ? ` — ${c.note}` : ''
        }`,
    ),
    '',
    'Indexed documents (search these for vaccination dates, policy numbers, etc.):',
    ...k.attachmentSummaries.map(
      (a) =>
        `  - ${a.filename}${a.summary ? ` — ${a.summary.slice(0, 200)}` : ''}${
          a.excerpt ? `\n    Excerpt: ${a.excerpt}` : ''
        }`,
    ),
    '',
    'Prior form answers (cross-form, keyed by humanized label — REUSE when the new form has a similar label):',
    ...k.priorAnswersByLabel.map((p) => {
      const subjTag = p.sameSubject
        ? '[SAME SUBJECT]'
        : p.sourceSubjectName
          ? `[from ${p.sourceSubjectName}'s form]`
          : '[different subject]';
      return `  - "${p.label}" = ${p.value}  ${subjTag} (source: ${p.sourceFormTitle})`;
    }),
    '',
    'Pre-filled values already on the source PDF (treat as confirmed — the user uploaded a form that already had these set):',
    ...Object.entries(k.preFilled).map(([n, v]) => `  - ${n}: ${v}`),
  ].join('\n');

  const fieldsText = [
    'FORM FIELDS',
    '',
    ...schema.fields.map((f) => {
      const meta: string[] = [];
      if (f.section) meta.push(`section: ${f.section}`);
      meta.push(`type: ${f.type}`);
      if (f.options?.length) meta.push(`options: ${f.options.join(' | ')}`);
      return `  - name: "${f.name}" — label: "${f.label}" (${meta.join(', ')})`;
    }),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${knowledgeText}\n\n${fieldsText}` },
  ];
}

// ── Persistence ─────────────────────────────────────────────────────

function rowToForm(row: {
  id: string;
  group_id: string;
  title: string;
  source_attachment_id: string;
  subject_person_id: string | null;
  schema_json: string;
  answers_json: string;
  status: 'draft' | 'filled';
  filled_attachment_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}): Form {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    sourceAttachmentId: row.source_attachment_id,
    subjectPersonId: row.subject_person_id ?? undefined,
    schema: FormSchemaZ.parse(JSON.parse(row.schema_json)),
    answers: JSON.parse(row.answers_json) as Record<string, string>,
    status: row.status,
    filledAttachmentId: row.filled_attachment_id ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createForm(
  db: Kysely<DB>,
  input: {
    groupId: string;
    title: string;
    sourceAttachmentId: string;
    subjectPersonId?: string | null;
    schema: FormSchema;
    answers: Record<string, string>;
    createdBy: string | null;
  },
): Promise<Form> {
  const id = newId('form');
  const now = new Date().toISOString();
  await db
    .insertInto('forms')
    .values({
      id,
      group_id: input.groupId,
      title: input.title,
      source_attachment_id: input.sourceAttachmentId,
      subject_person_id: input.subjectPersonId ?? null,
      schema_json: JSON.stringify(input.schema),
      answers_json: JSON.stringify(input.answers),
      status: 'draft',
      filled_attachment_id: null,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const row = await db.selectFrom('forms').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return rowToForm(row);
}

export async function getForm(db: Kysely<DB>, id: string): Promise<Form | null> {
  const row = await db.selectFrom('forms').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToForm(row) : null;
}

// ── Write-back: fill the PDF ───────────────────────────────────────

/**
 * Apply answers to the source PDF's AcroForm fields, save the result
 * as a new attachment in the same scope as the source, and mark the
 * form `filled`. Returns the updated Form.
 */
export async function finalizeForm(
  db: Kysely<DB>,
  formId: string,
  answers: Record<string, string>,
): Promise<Form | null> {
  const form = await getForm(db, formId);
  if (!form) return null;
  const source = await getAttachment(db, form.sourceAttachmentId);
  if (!source) return null;
  const sourcePath = absolutePathFor(source);
  const buffer = await readBlob(sourcePath);
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const acro = pdf.getForm();

  for (const [name, value] of Object.entries(answers)) {
    if (value === '' || value == null) continue;
    try {
      // pdf-lib raises if a field name isn't found; safe to try-each.
      const field = acro.getField(name);
      if (field instanceof PDFTextField) {
        field.setText(value);
      } else if (field instanceof PDFCheckBox) {
        const truthy = /^(y|yes|true|on|1|x|checked)$/i.test(value.trim());
        if (truthy) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown) {
        try {
          field.select(value);
        } catch {
          /* not in options — skip */
        }
      } else if (field instanceof PDFRadioGroup) {
        try {
          field.select(value);
        } catch {
          /* skip */
        }
      }
    } catch (err) {
      logger.warn(`forms: failed to set ${name}`, { err });
    }
  }

  // Do NOT flatten — keep the AcroForm intact. Modern PDF viewers
  // (Acrobat, Preview, Chrome's built-in viewer) render filled values
  // from unflattened forms fine, and keeping the form structure means
  // (a) the user can still edit the PDF if they need to, and (b)
  // next-year's start_form_fill can re-extract the values via
  // `extractFilledValues` for verbatim reuse.
  const out = await pdf.save();

  const baseName = path.parse(source.filename).name;
  const filledName = `${baseName}.filled.pdf`;
  const filled = await saveFile(db, {
    scope: source.scope,
    uploadedBy: form.createdBy ?? 'system',
    filename: filledName,
    mimeType: 'application/pdf',
    buffer: Buffer.from(out),
    index: false,
  });

  await db
    .updateTable('forms')
    .set({
      answers_json: JSON.stringify(answers),
      status: 'filled',
      filled_attachment_id: filled.id,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', formId)
    .execute();

  return getForm(db, formId);
}
