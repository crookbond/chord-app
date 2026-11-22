/**
 * Who a reply goes to — one rule, shared by the two surfaces that answer mail.
 *
 * The reply composer computes this client-side (ADR 0069) and the `reply_to_email`
 * bot tool has to compute the same thing server-side, so it lives in kernel
 * rather than twice (ADR 0094's precedent). Drift here is not cosmetic: the two
 * surfaces would disagree about who receives a message the user already sent.
 */

/** The fields of the message being replied to that decide the audience. */
export interface ReplyTarget {
  fromEmail: string | null;
  /** Where the sender asked replies to go (one bare address, ADR 0294). */
  replyTo?: string | null;
  toEmails: string[];
  ccEmails: string[];
  /** The mailbox's own message (the provider's SENT label). The address test
   *  alone misses it whenever "my address" is unknown or is the login's
   *  rather than the mailbox's. */
  sent?: boolean;
}

export interface ReplyRecipients {
  to: string[];
  cc: string[];
}

/**
 * Where an answer to someone else's message goes: its Reply-To when it names one
 * (a mailing list, an assistant, a help desk), else its sender. A Reply-To
 * that is the user's own address is ignored, or the reply would go nowhere.
 * Not for auto-replies: RFC 3834 sends those to the sender.
 */
export function replyAddressOf(
  target: Pick<ReplyTarget, 'fromEmail' | 'replyTo'> | null | undefined,
  myEmail: string | null,
): string | null {
  const replyTo = target?.replyTo?.trim();
  if (replyTo && replyTo.includes('@') && replyTo.toLowerCase() !== myEmail?.toLowerCase()) {
    return replyTo;
  }
  return target?.fromEmail ?? null;
}

/**
 * Answering someone else's message: `to` is its reply address, and `cc` is everyone
 * else who was on it - but only in reply-all; a plain reply carries no cc at
 * all, so widening the audience is always an explicit choice.
 *
 * Answering your OWN message (a follow-up to something you sent) goes to the
 * people you sent it to, never back to yourself: `to` is its To line, and
 * reply-all adds its Cc line.
 *
 * The user's own address is dropped: mailing yourself is noise, and on a
 * reply-all it is the difference between 4 recipients and 5.
 */
export function replyRecipients(
  latest: ReplyTarget | null,
  opts: { replyAll: boolean; myEmail: string | null },
): ReplyRecipients {
  const mine = opts.myEmail?.toLowerCase() ?? null;
  const from = latest?.fromEmail?.toLowerCase() ?? null;
  const own = latest?.sent === true || (mine !== null && from !== null && from === mine);
  const others = (list: string[], taken: Set<string>): string[] => [
    ...new Set(
      list.filter((e) => {
        const k = e?.toLowerCase();
        return !!k && k !== mine && k !== (own ? from : null) && !taken.has(k);
      }),
    ),
  ];
  if (own && latest) {
    const to = others(latest.toEmails ?? [], new Set());
    // A note sent only to yourself still has to go somewhere.
    if (to.length === 0) return { to: latest.fromEmail ? [latest.fromEmail] : [], cc: [] };
    if (!opts.replyAll) return { to, cc: [] };
    return { to, cc: others(latest.ccEmails ?? [], new Set(to.map((e) => e.toLowerCase()))) };
  }
  const address = replyAddressOf(latest, opts.myEmail);
  const to = address ? [address] : [];
  if (!opts.replyAll) return { to, cc: [] };
  const inTo = new Set(to.map((e) => e.toLowerCase()));
  return { to, cc: others([...(latest?.toEmails ?? []), ...(latest?.ccEmails ?? [])], inTo) };
}

/** "To: a@b · Cc: c@d, e@f" — the audience, short enough for a card. */
export function describeRecipients(r: ReplyRecipients, opts: { max?: number } = {}): string {
  const max = opts.max ?? 3;
  const part = (label: string, list: string[]): string | null => {
    if (list.length === 0) return null;
    const shown = list.slice(0, max).join(', ');
    const rest = list.length - max;
    return `${label}: ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
  };
  return [part('To', r.to), part('Cc', r.cc)].filter(Boolean).join(' · ');
}

/**
 * Which message a reply answers when the user has not picked one: the newest
 * that is NOT their own. Own means the provider's SENT label or their address.
 *
 * Naively taking the newest message means that the moment you reply, the thread's
 * latest message is your own - and the next reply is addressed to yourself. Both
 * surfaces hit this (the composer showed `To: me@example.com` on a thread I had
 * just answered), and it is worse on the bot tool, where nobody sees the address
 * until it is sent.
 *
 * Falls back to the newest message when every message is the user's own, so a
 * thread of pure self-sends still resolves to something rather than nothing.
 */
export function pickReplyTarget<T extends { fromEmail: string | null; sent?: boolean }>(
  messages: readonly T[],
  myEmail: string | null,
): T | null {
  if (messages.length === 0) return null;
  const mine = myEmail?.toLowerCase() ?? null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sent === true) continue;
    const from = messages[i].fromEmail?.toLowerCase() ?? null;
    if (!mine || !from || from !== mine) return messages[i];
  }
  return messages[messages.length - 1];
}

/**
 * Who reply-all reaches that a plain reply does not.
 *
 * Derived from `replyRecipients` rather than read off the message again, so
 * this cannot disagree with who Send actually addresses. Empty means reply-all
 * would change nothing - a one-to-one email, or one whose only other
 * recipient is you - and a control that changes nothing is worse than none.
 */
export function replyAllAdds(latest: ReplyTarget | null, myEmail: string | null): string[] {
  const plain = replyRecipients(latest, { replyAll: false, myEmail });
  const all = replyRecipients(latest, { replyAll: true, myEmail });
  const reached = new Set([...plain.to, ...plain.cc].map((e) => e.toLowerCase()));
  return [...all.to, ...all.cc].filter((e) => !reached.has(e.toLowerCase()));
}

/**
 * Turning reply-all on or off on recipients that are already in a composer.
 *
 * Exactly the people reply-all adds go into Cc, and switching back takes the
 * same people out again. It never re-derives the fields from the message,
 * because by then the user may have typed a recipient of their own - or
 * deleted one - and a switch that quietly undid that would lose work the
 * composer was holding. (Choosing Reply or Reply all from the reader's menu
 * still derives afresh: nothing has been written yet.) To is left alone: every
 * address reply-all adds is a Cc one, and the sender is already in To.
 *
 * Nobody is added who is already in either field, whoever put them there.
 */
export function applyReplyAll(
  cur: ReplyRecipients,
  latest: ReplyTarget | null,
  opts: { replyAll: boolean; myEmail: string | null },
): ReplyRecipients {
  const added = replyAllAdds(latest, opts.myEmail);
  const key = (e: string) => e.trim().toLowerCase();
  if (!opts.replyAll) {
    const drop = new Set(added.map(key));
    const keep = (list: string[]) => list.filter((e) => !drop.has(key(e)));
    return { to: keep(cur.to), cc: keep(cur.cc) };
  }
  const have = new Set([...cur.to, ...cur.cc].map(key));
  const cc = [...cur.cc];
  for (const e of added) {
    if (have.has(key(e))) continue;
    have.add(key(e));
    cc.push(e);
  }
  return { to: [...cur.to], cc };
}
