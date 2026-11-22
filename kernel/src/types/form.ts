import { z } from 'zod';
import type { AttachmentId, GroupId, IsoDateTime, UserId } from './ids';

/**
 * A field detected in an uploaded form PDF. AcroForm fields carry a
 * stable `name` (used to write the value back via pdf-lib); fields
 * detected via vision over a flat scan use a synthetic `name` derived
 * from the label.
 */
export type FormFieldType = 'text' | 'checkbox' | 'date' | 'choice' | 'signature';

export interface FormField {
  /** AcroForm field name (or synthetic) — used for write-back. */
  name: string;
  /** Human label as shown on the form. */
  label: string;
  type: FormFieldType;
  /** Optional grouping hint, e.g. "Student Information", "Emergency Contact". */
  section?: string;
  /** For choice/checkbox fields: the allowed options. */
  options?: string[];
  /** Whether the field is marked required on the form. */
  required?: boolean;
}

export interface FormSchema {
  fields: FormField[];
  pageCount: number;
  /** True when fields came from an AcroForm; false when derived from vision. */
  acroform: boolean;
}

/**
 * Provenance for a single resolved field — tells the user *why* the
 * value was filled, so they can sanity-check before submitting.
 */
export type ResolutionStatus = 'confirmed' | 'inferred' | 'unknown';

export interface ResolvedField {
  name: string;
  label: string;
  section?: string;
  value: string | null;
  status: ResolutionStatus;
  /** Short human-readable source: e.g. "saved person Ananya", "persona memory: allergy", "vaccination_record.pdf". */
  source?: string;
  /** 0..1 — only fields >= 0.9 are auto-filled; lower or null fall to gap-fill. */
  confidence: number;
}

export interface Form {
  id: string;
  groupId: GroupId;
  title: string;
  sourceAttachmentId: AttachmentId;
  subjectPersonId?: string;
  schema: FormSchema;
  answers: Record<string, string>;
  status: 'draft' | 'filled';
  filledAttachmentId?: AttachmentId;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const FormFieldZ = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'checkbox', 'date', 'choice', 'signature']),
  section: z.string().optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

export const FormSchemaZ = z.object({
  fields: z.array(FormFieldZ),
  pageCount: z.number().int().positive(),
  acroform: z.boolean(),
});
