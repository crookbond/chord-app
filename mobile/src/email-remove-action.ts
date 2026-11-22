/**
 * What putting an email away means for this user (ADR 0215): archive or
 * Trash, the same choice the list's swipe uses. Read once per app run and
 * shared, so a screen that offers the button does not re-ask the server;
 * Settings writes it back when it changes.
 */
import { useEffect, useState } from 'react';
import type { EmailSwipeAction } from '@chord/kernel';

import { getSettingsCached, modifyEmailThread } from '@/api';
import { useEmailThreadNav } from '@/email-thread-nav';
import { onSignOut } from '@/sign-out';

let cached: EmailSwipeAction | null = null;
const listeners = new Set<(a: EmailSwipeAction) => void>();
onSignOut(() => {
  cached = null;
});

export function setEmailRemoveAction(action: EmailSwipeAction): void {
  cached = action;
  for (const l of listeners) l(action);
}

export function useEmailRemoveAction(): EmailSwipeAction {
  const [action, setAction] = useState<EmailSwipeAction>(cached ?? 'archive');
  useEffect(() => {
    listeners.add(setAction);
    if (cached === null) {
      void getSettingsCached()
        .then((s) => setEmailRemoveAction(s.emailSwipeAction ?? 'archive'))
        .catch(() => {});
    }
    return () => {
      listeners.delete(setAction);
    };
  }, []);
  return action;
}

/**
 * Archive or trash one email, hiding it from every mail list while the
 * mailbox answers (the same shared `removing` set the reader and swipe use).
 * Throws when the mailbox refuses, so the caller can say so.
 */
export async function putEmailAway(threadId: string, action: EmailSwipeAction): Promise<void> {
  const nav = useEmailThreadNav.getState();
  nav.startRemoving([threadId]);
  try {
    await modifyEmailThread(threadId, action === 'trash' ? { trash: true } : { archive: true });
  } catch (e) {
    // Refused: release the row so every list shows it again, then say so.
    useEmailThreadNav.getState().doneRemoving([threadId], [threadId]);
    throw e;
  }
  useEmailThreadNav.getState().doneRemoving([threadId]);
}

export function putAwayErrorText(action: EmailSwipeAction): string {
  return action === 'trash' ? "Couldn't move the email to Trash." : "Couldn't archive the email.";
}

/** The local thread id an email-sourced suggestion links to, if any. */
export function emailThreadIdOf(sourceHref: string | null | undefined): string | null {
  const m = /^\/email\/([^/?#]+)$/.exec(sourceHref ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}
