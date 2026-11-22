import type { BotCard, MemoryNoticeStatus } from './sse';

export type MemoryCardAction = 'keep' | 'reject' | 'forget';

/**
 * ADR 0281 — which buttons a memory card shows. Only the person whose message
 * taught the fact gets any; a fact that was replaced or removed has none.
 */
export function memoryCardActions(
  card: Pick<BotCard, 'memoryStatus' | 'memoryForUserId'>,
  viewerId: string | null | undefined,
): MemoryCardAction[] {
  if (!viewerId || card.memoryForUserId !== viewerId) return [];
  const status: MemoryNoticeStatus | undefined = card.memoryStatus;
  if (status === 'proposed') return ['keep', 'reject'];
  if (status === 'saved') return ['forget'];
  return [];
}

/** The card's status after a button press, shown until the server's rewrite arrives. */
export function memoryStatusAfter(action: MemoryCardAction): MemoryNoticeStatus {
  return action === 'keep' ? 'saved' : 'removed';
}

export const MEMORY_ACTION_LABEL: Record<MemoryCardAction, string> = {
  keep: 'Keep',
  reject: 'Not right',
  forget: 'Forget',
};
