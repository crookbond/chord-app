import { z } from 'zod';

export const WaitlistSignupRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});
export type WaitlistSignupRequest = z.infer<typeof WaitlistSignupRequest>;

export interface WaitlistSignupResponse {
  ok: true;
  alreadyOnList: boolean;
}
