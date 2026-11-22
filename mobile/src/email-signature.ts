/**
 * The signature for the composers (ADR 0260 addendum): the box opens with it
 * already under the cursor, so what is seen is what is sent. Each mailbox may
 * have its own; one without uses the shared signature. `accountId` is the
 * mailbox the mail leaves from (null = the primary Gmail).
 *
 * `undefined` while loading, `null` when there is none. Read fresh each time a
 * composer opens (a signature changed in Settings shows up in the next email),
 * with the last value shown meanwhile.
 */
import { useEffect, useState } from 'react';

import { signatureForMailbox, signatureHtmlForMailbox, type MeSettings } from '@chord/kernel';

import { getSettingsCached } from '@/api';

type Sigs = Pick<MeSettings, 'emailSignature' | 'emailSignatureHtml' | 'mailboxSignatures'>;

let last: Sigs | undefined;

function useSigs(): Sigs | null | undefined {
  const [sigs, setSigs] = useState<Sigs | null | undefined>(last);
  useEffect(() => {
    let cancelled = false;
    getSettingsCached()
      .then((s) => {
        last = {
          emailSignature: s.emailSignature,
          emailSignatureHtml: s.emailSignatureHtml,
          mailboxSignatures: s.mailboxSignatures,
        };
        if (!cancelled) setSigs(last);
      })
      .catch(() => {
        // Unknown is not "none": keep what we had, or settle on none so the
        // composer is not left waiting.
        if (!cancelled) setSigs(last ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return sigs;
}

export function useEmailSignature(accountId?: string | null): string | null | undefined {
  const sigs = useSigs();
  if (sigs === undefined) return undefined;
  return signatureForMailbox(sigs?.emailSignature, sigs?.mailboxSignatures, accountId ?? null);
}

/** The rich version of the same signature, or null (ADR 0338). */
export function useEmailSignatureHtml(accountId?: string | null): string | null {
  const sigs = useSigs();
  return sigs ? signatureHtmlForMailbox(sigs.emailSignatureHtml, sigs.mailboxSignatures, accountId ?? null) : null;
}
