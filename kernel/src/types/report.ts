import { z } from 'zod';

/** ADR 0301 — report a message someone else posted in a shared chat. */
export const ReportMessageRequest = z.object({
  messageId: z.string().min(1).max(128),
  reason: z.string().trim().max(1000).optional(),
});
export type ReportMessageRequest = z.infer<typeof ReportMessageRequest>;

export interface ReportMessageResponse {
  reportId: string;
  /** True when this person had already reported this message. */
  alreadyReported: boolean;
}
