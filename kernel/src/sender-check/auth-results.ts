/**
 * What the RECEIVING mail server concluded about a message (RFC 8601
 * `Authentication-Results`), reduced to the three verdicts people mean by
 * "was it really sent by them" (ADR 0294).
 *
 * Only the topmost header is read: every relay prepends its own, so the top
 * one is the user's provider (Gmail, Outlook, Yahoo), while a lower one may
 * have been written by the sender and says whatever the sender wants.
 */

export type AuthVerdict = 'pass' | 'fail' | 'softfail' | 'none' | 'neutral' | 'temperror' | 'permerror' | 'policy' | 'bestguesspass';

export interface SenderAuth {
  spf?: AuthVerdict;
  dkim?: AuthVerdict;
  dmarc?: AuthVerdict;
  /** The domain DMARC checked (`header.from=`). */
  dmarcFrom?: string;
  /** The domain that signed it (`header.d=` / `header.i=@`). */
  dkimDomain?: string;
}

const VERDICTS = new Set<AuthVerdict>(['pass', 'fail', 'softfail', 'none', 'neutral', 'temperror', 'permerror', 'policy', 'bestguesspass']);

function verdict(raw: string | undefined): AuthVerdict | undefined {
  const v = raw?.toLowerCase() as AuthVerdict | undefined;
  return v && VERDICTS.has(v) ? v : undefined;
}

/** Parse one `Authentication-Results` value. Null when it carries no verdict. */
export function parseAuthenticationResults(value: string | null | undefined): SenderAuth | null {
  if (!value) return null;
  const text = value.replace(/\([^)]*\)/g, ' ');
  const out: SenderAuth = {};
  const spf = /\bspf=(\w+)/i.exec(text);
  const dkim = /\bdkim=(\w+)/i.exec(text);
  const dmarc = /\bdmarc=(\w+)/i.exec(text);
  if (spf) out.spf = verdict(spf[1]);
  if (dkim) out.dkim = verdict(dkim[1]);
  if (dmarc) out.dmarc = verdict(dmarc[1]);
  const from = /\bheader\.from=([^\s;]+)/i.exec(text);
  if (from) out.dmarcFrom = from[1]!.toLowerCase().replace(/^@/, '');
  const d = /\bheader\.d=([^\s;]+)/i.exec(text) ?? /\bheader\.i=@?([^\s;]+)/i.exec(text);
  if (d) out.dkimDomain = d[1]!.toLowerCase().replace(/^.*@/, '');
  for (const k of Object.keys(out) as (keyof SenderAuth)[]) if (out[k] === undefined) delete out[k];
  return out.spf || out.dkim || out.dmarc ? out : null;
}
