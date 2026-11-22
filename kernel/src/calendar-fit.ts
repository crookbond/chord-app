/**
 * ADR 0346 - what an email event card does with its calendar verdict.
 */
import type { ProposalCalendarFit } from './types/proposal';

export type RsvpAnswer = 'accepted' | 'tentative' | 'declined';

/** The answer the invite card highlights, or none while a question is open. */
export function recommendedRsvp(fit: ProposalCalendarFit | undefined): RsvpAnswer | null {
  if (!fit) return null;
  if (fit.verdict === 'already' || fit.verdict === 'free') return fit.outsideWorkHours ? null : 'accepted';
  if (fit.verdict === 'conflict') return 'declined';
  return null;
}

/**
 * The instruction behind "Suggest another time". It says there is a conflict
 * and never what it is: the drafter is told about free and busy time only,
 * and the reply goes to someone who has no business knowing the rest.
 */
export const SUGGEST_ANOTHER_TIME =
  "Reply that I can't make that time (say only that I have a conflict, not what it is) and offer 2-3 other times I am free in work hours";
