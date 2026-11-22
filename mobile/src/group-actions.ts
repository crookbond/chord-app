/**
 * ADR 0259 - what we say before clearing, leaving or deleting a chat.
 *
 * One set of words for the two places it can be done - the Messages list and the
 * chat's own settings - so they cannot drift into promising different things. Each
 * sentence is a promise about what happens to other people's copies.
 */
import type { GroupKind } from '@chord/kernel';

export interface Prompt {
  title: string;
  message: string;
}

export function clearChatPrompt(kind: GroupKind): Prompt {
  return {
    title: 'Clear chat?',
    message:
      (kind === 'personal'
        ? 'This deletes every message in this chat. '
        : 'This removes every message in this chat for you only. Everyone else still sees them. ') +
      'It cannot be undone. Files stay in Attachments.',
  };
}

export function leavePrompt(isOwner: boolean): Prompt {
  return {
    title: 'Leave group',
    message: isOwner
      ? 'You own this group - ownership passes to the longest-standing member when you leave.'
      : 'You will stop receiving messages and need a new invite to rejoin.',
  };
}

export function deletePrompt(name: string): Prompt {
  return {
    title: 'Delete group',
    message: `Permanently delete \u201c${name}\u201d for everyone, including all messages, files, tasks, and events. This cannot be undone.`,
  };
}
