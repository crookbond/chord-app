/**
 * PR-J — form-fill pipeline. Covers:
 *  1. Schema extraction from a built PDF (text + checkbox + dropdown).
 *  2. extractFilledValues: harvesting values from a partially-filled
 *     prior-year PDF the user uploads as a starting point.
 *  3. gatherKnowledge cross-form reuse: a parent's filled form lends
 *     insurance to the kid's new form (different subject_person_id).
 *  4. End-to-end via the bot's `start_form_fill` + `complete_form_fill`
 *     tools with the mock LLM, then re-extracting the filled PDF to
 *     verify values round-trip cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { PDFDocument } from 'pdf-lib';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  extractFilledValues,
  extractFormSchema,
  gatherKnowledge,
} from '@/services/forms.service.js';
import { saveFile, getAttachment, absolutePathFor } from '@/services/attachments.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addImportantDate, createPerson } from '@/services/people.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import fs from 'node:fs/promises';

// ── PDF fixtures ────────────────────────────────────────────────────

interface SchoolFormBuilder {
  studentName?: string;
  studentDob?: string;
  studentAllergies?: string;
  parentName?: string;
  parentPhone?: string;
  emergencyContact?: string;
  insuranceProvider?: string;
  insuranceMemberId?: string;
  physicianName?: string;
  physicianPhone?: string;
  consentChecked?: boolean;
}

/**
 * Insert a placeholder attachment row so a `forms` insert can satisfy
 * the `source_attachment_id REFERENCES attachments(id)` constraint
 * without round-tripping through saveFile + the file system.
 */
async function insertStubAttachment(
  db: Kysely<DB>,
  id: string,
  groupId: string,
  uploadedBy: string,
): Promise<void> {
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: groupId,
      uploaded_by: uploadedBy,
      filename: `${id}.pdf`,
      mime_type: 'application/pdf',
      size: 1,
      path: `stub/${id}.pdf`,
      summary: null,
      extracted_text: null,
      image_meta: null,
      pinned: 0,
      indexed_at: null,
      created_at: new Date().toISOString(),
    })
    .execute();
}

async function buildSchoolFormPdf(values: SchoolFormBuilder = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 800]);
  const form = pdf.getForm();

  const text = (name: string, y: number, value?: string) => {
    const f = form.createTextField(name);
    f.setText(value ?? '');
    f.addToPage(page, { x: 50, y, width: 280, height: 16 });
  };

  text('Student.Name', 760, values.studentName);
  text('Student.DOB', 740, values.studentDob);
  text('Student.Allergies', 720, values.studentAllergies);
  text('Parent.Name', 690, values.parentName);
  text('Parent.Phone', 670, values.parentPhone);
  text('Emergency.Contact.Name', 640, values.emergencyContact);
  text('Insurance.Provider', 610, values.insuranceProvider);
  text('Insurance.MemberID', 590, values.insuranceMemberId);
  text('Physician.Name', 560, values.physicianName);
  text('Physician.Phone', 540, values.physicianPhone);

  const consent = form.createCheckBox('Consent.PhotoRelease');
  if (values.consentChecked) consent.check();
  consent.addToPage(page, { x: 50, y: 510, width: 16, height: 16 });

  return Buffer.from(await pdf.save());
}

// ── 1. Schema extraction ────────────────────────────────────────────

describe('extractFormSchema', () => {
  it('returns null for a PDF with no AcroForm fields', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([200, 200]);
    const buf = Buffer.from(await blank.save());
    expect(await extractFormSchema(buf)).toBeNull();
  });

  it('extracts text + checkbox fields with humanized labels and section hints', async () => {
    const buf = await buildSchoolFormPdf();
    const schema = await extractFormSchema(buf);
    expect(schema).not.toBeNull();
    expect(schema!.acroform).toBe(true);
    const byName = Object.fromEntries(schema!.fields.map((f) => [f.name, f]));
    expect(byName['Student.Name'].label).toBe('Student Name');
    expect(byName['Student.Name'].section).toBe('Student');
    expect(byName['Student.DOB'].type).toBe('date');
    expect(byName['Consent.PhotoRelease'].type).toBe('checkbox');
    expect(byName['Insurance.Provider'].section).toBe('Insurance');
  });
});

// ── 2. Pre-filled value harvest ─────────────────────────────────────

describe('extractFilledValues', () => {
  it('harvests text + checkbox values that the user already filled in', async () => {
    const buf = await buildSchoolFormPdf({
      studentName: 'Ananya Doe',
      studentDob: '2017-05-12',
      insuranceProvider: 'Aetna PPO',
      consentChecked: true,
    });
    const { byName, byLabel } = await extractFilledValues(buf);
    expect(byName['Student.Name']).toBe('Ananya Doe');
    expect(byName['Insurance.Provider']).toBe('Aetna PPO');
    expect(byName['Consent.PhotoRelease']).toBe('yes');
    // Labels are normalized so a sibling form with field "Student Name"
    // matches even if its AcroForm name is e.g. "studentName".
    expect(byLabel['student name']).toBe('Ananya Doe');
    expect(byLabel['insurance provider']).toBe('Aetna PPO');
  });

  it('returns empty maps for a blank form', async () => {
    const buf = await buildSchoolFormPdf();
    const { byName, byLabel } = await extractFilledValues(buf);
    expect(Object.keys(byName)).toHaveLength(0);
    expect(Object.keys(byLabel)).toHaveLength(0);
  });
});

// ── 3. Cross-form knowledge gather (family-shared insurance) ────────

describe('gatherKnowledge — cross-form prior answers', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('surfaces a parent-form answer when filling a kid form, tagged as a different subject', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });

    const ananya = await createPerson(db, {
      ownerUserId: john,
      displayName: 'Ananya Doe',
    });
    const alice = await createPerson(db, {
      ownerUserId: john,
      displayName: 'Alice Doe',
    });
    await addImportantDate(db, {
      personId: ananya.id,
      kind: 'birthday',
      date: '2017-05-12',
      recurs: true,
    });

    // Stash a filled form for Alice that includes the family insurance.
    const filledSchema = {
      fields: [
        {
          name: 'Insurance.Provider',
          label: 'Insurance Provider',
          type: 'text' as const,
          section: 'Insurance',
        },
        {
          name: 'Insurance.MemberID',
          label: 'Insurance Member ID',
          type: 'text' as const,
          section: 'Insurance',
        },
        {
          name: 'Subscriber.Name',
          label: 'Subscriber Name',
          type: 'text' as const,
        },
      ],
      pageCount: 1,
      acroform: true,
    };
    const now = new Date().toISOString();
    await insertStubAttachment(db, 'a_alice_prior', group.id, john);
    await db
      .insertInto('forms')
      .values({
        id: 'form_alice_prior',
        group_id: group.id,
        title: '2025 Alice Annual Physical',
        source_attachment_id: 'a_alice_prior',
        subject_person_id: alice.id,
        schema_json: JSON.stringify(filledSchema),
        answers_json: JSON.stringify({
          'Insurance.Provider': 'Aetna PPO',
          'Insurance.MemberID': 'AET-12345',
          'Subscriber.Name': 'John Doe',
        }),
        status: 'filled',
        filled_attachment_id: null,
        created_by: john,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Now gather knowledge for a NEW form being filled for Ananya.
    const k = await gatherKnowledge(db, {
      userId: john,
      groupId: group.id,
      subjectPersonId: ananya.id,
    });

    // Insurance answers from Alice's form must surface, tagged
    // sameSubject=false so the bot knows to confirm before reusing.
    const insurance = k.priorAnswersByLabel.find((p) => p.label === 'Insurance Provider');
    expect(insurance).toBeDefined();
    expect(insurance!.value).toBe('Aetna PPO');
    expect(insurance!.sameSubject).toBe(false);
    expect(insurance!.sourceSubjectName).toBe('Alice Doe');
    expect(insurance!.sourceFormTitle).toContain('Alice');
  });

  it('marks same-subject prior answers with sameSubject=true', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    const ananya = await createPerson(db, {
      ownerUserId: john,
      displayName: 'Ananya Doe',
    });
    const now = new Date().toISOString();
    await insertStubAttachment(db, 'a_ananya_prior', group.id, john);
    await db
      .insertInto('forms')
      .values({
        id: 'form_ananya_prior',
        group_id: group.id,
        title: '2024 Ananya School Form',
        source_attachment_id: 'a_ananya_prior',
        subject_person_id: ananya.id,
        schema_json: JSON.stringify({
          fields: [
            {
              name: 'Student.Allergies',
              label: 'Student Allergies',
              type: 'text' as const,
            },
          ],
          pageCount: 1,
          acroform: true,
        }),
        answers_json: JSON.stringify({ 'Student.Allergies': 'peanuts' }),
        status: 'filled',
        filled_attachment_id: null,
        created_by: john,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const k = await gatherKnowledge(db, {
      userId: john,
      groupId: group.id,
      subjectPersonId: ananya.id,
    });
    const allergy = k.priorAnswersByLabel.find((p) => p.label === 'Student Allergies');
    expect(allergy).toBeDefined();
    expect(allergy!.sameSubject).toBe(true);
  });
});

// ── 4. End-to-end with the bot tools (mock LLM) ─────────────────────

describe('start_form_fill + complete_form_fill — full pipeline', () => {
  let db: Kysely<DB>;
  const originalEnvProvider = process.env.LLM_PROVIDER;

  beforeEach(async () => {
    process.env.LLM_PROVIDER = 'mock';
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
    if (originalEnvProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalEnvProvider;
  });

  it('round-trips: build form → upload → fill → re-extract values from the generated PDF', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });

    // Family-shared insurance memory (group scope).
    await upsertMemory(db, {
      groupId: group.id,
      scope: 'group',
      key: 'insurance_provider',
      value: 'Aetna PPO',
      source: 'extracted',
      confidence: 0.95,
      status: 'confirmed',
    });

    // The kid + DOB.
    const ananya = await createPerson(db, {
      ownerUserId: john,
      displayName: 'Ananya Doe',
    });
    await addImportantDate(db, {
      personId: ananya.id,
      kind: 'birthday',
      date: '2017-05-12',
      recurs: true,
    });

    // User uploads a partially-filled school form (student name + insurance
    // pre-populated). These should come back as confirmed via the
    // pre-filled path, no LLM needed.
    const sourceBuf = await buildSchoolFormPdf({
      studentName: 'Ananya Doe',
      studentDob: '2017-05-12',
      insuranceProvider: 'Aetna PPO',
      insuranceMemberId: 'AET-12345',
    });
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId: group.id },
      uploadedBy: john,
      filename: 'school_form_2026.pdf',
      mimeType: 'application/pdf',
      buffer: sourceBuf,
      index: false,
    });

    // Run start_form_fill.
    const startRes = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'start_form_fill',
        args: { attachmentId: att.id, subjectPersonName: 'Ananya Doe' },
      },
    });
    expect(startRes.summary).toContain('start_form_fill');
    const startData = startRes.data as {
      formId: string;
      fields: Array<{ label: string; value: string | null; status: string; source?: string }>;
      gaps: string[];
      tip?: string;
    };

    // Pre-filled values must have come back as confirmed.
    const studentNameField = startData.fields.find((f) => f.label === 'Student Name')!;
    expect(studentNameField.value).toBe('Ananya Doe');
    expect(studentNameField.status).toBe('confirmed');
    expect(studentNameField.source).toContain('pre-filled');

    // Insurance values from the pre-filled PDF override anything else.
    const insurField = startData.fields.find((f) => f.label === 'Insurance Provider')!;
    expect(insurField.value).toBe('Aetna PPO');
    expect(insurField.status).toBe('confirmed');

    // First-time user (no prior forms) gets the upload-an-old-form tip.
    expect(startData.tip).toBeDefined();
    expect(startData.tip).toContain('filled');

    // Simulate user supplying answers to the gaps. We feed every label
    // back so complete_form_fill produces a fully-filled PDF regardless
    // of what the mock LLM resolved for the unknown fields.
    const userAnswers: Record<string, string> = {
      'Student.Name': 'Ananya Doe',
      'Student.DOB': '2017-05-12',
      'Student.Allergies': 'peanuts',
      'Parent.Name': 'John Doe',
      'Parent.Phone': '555-1010',
      'Emergency.Contact.Name': 'Alice Doe',
      'Insurance.Provider': 'Aetna PPO',
      'Insurance.MemberID': 'AET-12345',
      'Physician.Name': 'Dr. Patel',
      'Physician.Phone': '555-2020',
      'Consent.PhotoRelease': 'yes',
    };

    const completeRes = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'complete_form_fill',
        args: { formId: startData.formId, answers: userAnswers },
      },
    });
    const completeData = completeRes.data as {
      formId: string;
      filledAttachmentId: string;
    };
    expect(completeData.filledAttachmentId).toBeTruthy();
    expect(completeRes.card?.kind).toBe('action');
    expect(completeRes.card?.url).toContain(completeData.filledAttachmentId);

    // Read the filled PDF back via the same extractor used for prior-
    // cycle reuse, and confirm every answer round-trips. This is the
    // killer-feature acceptance criterion: a filled PDF written by
    // Chord must be re-readable by Chord (and by any AcroForm-aware
    // viewer) so next year's intake just works.
    const filledAtt = await getAttachment(db, completeData.filledAttachmentId);
    expect(filledAtt).not.toBeNull();
    const filledBuf = await fs.readFile(absolutePathFor(filledAtt!));
    const reExtracted = await extractFilledValues(filledBuf);
    expect(reExtracted.byName['Student.Name']).toBe('Ananya Doe');
    expect(reExtracted.byName['Student.DOB']).toBe('2017-05-12');
    expect(reExtracted.byName['Insurance.Provider']).toBe('Aetna PPO');
    expect(reExtracted.byName['Insurance.MemberID']).toBe('AET-12345');
    expect(reExtracted.byName['Physician.Phone']).toBe('555-2020');
    expect(reExtracted.byName['Consent.PhotoRelease']).toBe('yes');

    // Persisted form row marked filled, and its answers are queryable
    // for next-cycle reuse.
    const persisted = await db
      .selectFrom('forms')
      .selectAll()
      .where('id', '=', startData.formId)
      .executeTakeFirstOrThrow();
    expect(persisted.status).toBe('filled');
    const stored = JSON.parse(persisted.answers_json) as Record<string, string>;
    expect(stored['Student.Name']).toBe('Ananya Doe');
    expect(stored['Insurance.Provider']).toBe('Aetna PPO');
  });

  it('reuses prior-form answers when the same kid uploads a similar form a year later', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    const ananya = await createPerson(db, {
      ownerUserId: john,
      displayName: 'Ananya Doe',
    });

    // Year 1: complete a form with allergies recorded.
    const buf1 = await buildSchoolFormPdf({
      studentName: 'Ananya Doe',
      studentAllergies: 'peanuts',
    });
    const att1 = await saveFile(db, {
      scope: { kind: 'group', groupId: group.id },
      uploadedBy: john,
      filename: 'school_form_2025.pdf',
      mimeType: 'application/pdf',
      buffer: buf1,
      index: false,
    });
    const start1 = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'start_form_fill',
        args: { attachmentId: att1.id, subjectPersonName: 'Ananya Doe' },
      },
    });
    const start1Data = start1.data as { formId: string };
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'complete_form_fill',
        args: {
          formId: start1Data.formId,
          answers: {
            'Student.Name': 'Ananya Doe',
            'Student.Allergies': 'peanuts',
          },
        },
      },
    });

    // Year 2: upload a fresh blank form for the same kid.
    const buf2 = await buildSchoolFormPdf();
    const att2 = await saveFile(db, {
      scope: { kind: 'group', groupId: group.id },
      uploadedBy: john,
      filename: 'school_form_2026.pdf',
      mimeType: 'application/pdf',
      buffer: buf2,
      index: false,
    });
    const k = await gatherKnowledge(db, {
      userId: john,
      groupId: group.id,
      subjectPersonId: ananya.id,
    });

    // The prior allergy answer is available for the LLM to reuse, tagged
    // as same-subject so the bot knows it can fill confidently.
    const allergy = k.priorAnswersByLabel.find((p) => p.label === 'Student Allergies');
    expect(allergy).toBeDefined();
    expect(allergy!.value).toBe('peanuts');
    expect(allergy!.sameSubject).toBe(true);
    expect(att2.id).toBeTruthy(); // sanity check the second upload landed
  });
});
