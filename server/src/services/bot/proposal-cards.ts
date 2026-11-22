/**
 * Shared helpers for rendering proposal-action cards (ADR 0029).
 *
 * Used by:
 *   - `content_classifier.ts` — attaches one card per staged proposal
 *     to the bundle announcement when first posted.
 *   - `proposal-resolution-notifier.ts` — rebuilds the card list (only
 *     still-pending proposals) and updates the TG inline keyboard
 *     after a proposal resolves.
 *
 * Keep the label / button-encoding logic here so both sides agree on
 * what a "confirm proposal X" button looks like.
 */
import type { BotCard } from '@chord/kernel';

const MAX_LABEL = 40;

export function buildProposalActionCard(
  proposalId: string,
  toolName: string,
  args: unknown,
): BotCard {
  const label = proposalButtonLabel(toolName, args);
  return {
    kind: 'action',
    title: label,
    buttons: [
      {
        label: `✓ ${label}`,
        callback: { verb: 'p+', id: proposalId },
      },
      {
        label: '✗',
        callback: { verb: 'p-', id: proposalId },
      },
    ],
  };
}

/**
 * Truncate-friendly label for a TG inline button (text renders inside
 * ~30 chars of horizontal space; we cap at 40 to leave a little room
 * for the leading checkmark). Falls back to the tool name when the
 * args don't carry a recognisable title.
 */
export function proposalButtonLabel(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const candidate =
    pickString(a.title) ??
    pickString(a.name) ??
    pickString(a.listName) ??
    pickString(a.body) ??
    toolName.replace(/_/g, ' ');
  return candidate.length > MAX_LABEL
    ? `${candidate.slice(0, MAX_LABEL - 1)}…`
    : candidate;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
