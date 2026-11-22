/**
 * Docked email-magic card (ADR 0068): one ADR 0063 suggestion with one-tap
 * confirm/dismiss through the standard proposal routes. `wide` is the
 * thread-view variant (full-width, actions on the right); default is the
 * narrow column beside a list row.
 *
 * ADR 0187 — `magic.status === 'confirmed'` seeds the SAME "added" state a
 * fresh confirm produces in this session, so re-opening a thread whose
 * suggestion you already acted on shows "✓ Added" with no buttons instead of
 * a live Confirm/Dismiss pair inviting a duplicate.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { recommendedRsvp, SUGGEST_ANOTHER_TIME, suggestionWhen, type EmailMagicSuggestion } from '@chord/kernel';

import { rejectProposal, rsvpProposal, waitForInvite } from '@/api';
import { answerProposal } from '@/proposal-answers';
import { CalendarFitNote } from '@/calendar-fit-note';
import { openDraftedReply } from '@/reply-draft';
import { PutAwayButton } from '@/email-put-away-button';
import { InviteChoice } from '@/invite-choice';
import { putAwayErrorText, putEmailAway, useEmailRemoveAction } from '@/email-remove-action';
import { rsvpErrorText } from '@/rsvp-error';
import { themed } from '@/theme';

export function MagicCard({
  magic,
  wide,
  threadId,
  onDismissed,
  onConfirmed,
}: {
  magic: EmailMagicSuggestion;
  wide?: boolean;
  /**
   * Source thread to open when the card is read away from its email — decide
   * on a lifted-out line alone and the context is gone. Omitted in the thread
   * view, which is already the email.
   */
  threadId?: string | null;
  onDismissed?: (proposalId: string) => void;
  /** Fired after a successful confirm (decisions sheet refreshes counts). */
  onConfirmed?: (proposalId: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'added' | 'queued' | 'failed'>(
    magic.status === 'confirmed' ? 'added' : 'idle',
  );
  const [answered, setAnswered] = useState<'accepted' | 'tentative' | null>(null);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const [needsCalendar, setNeedsCalendar] = useState(false);
  const removeAction = useEmailRemoveAction();
  const isEvent = magic.kind === 'event';
  const isInvite = isEvent && magic.isInvite === true;
  // ADR 0132 - a task's detail is a due date when it has one, and often it
  // has none: an obligation without a deadline is still an obligation.
  const isTask = magic.kind === 'task';
  // ADR 0248 - the email changes something already there (a booking
  // cancelled or moved, a bill paid); the title says what.
  const isChange = magic.kind === 'change';
  const when = (iso: string) => suggestionWhen(iso, { weekday: !!wide, withTime: !isTask }) ?? '';
  const detail = isEvent || isChange
    ? [magic.detail ? when(magic.detail) : '', isChange ? (magic.changeNote ?? '') : '']
        .filter(Boolean)
        .join(' · ')
    : isTask
      ? magic.detail && when(magic.detail)
        ? `Due ${when(magic.detail)}`
        : ''
      : magic.detail
        ? `→ ${magic.detail}`
        : '';

  // ADR 0343 — this may be an event the user already has, moved.
  const replaces = isEvent && !isInvite && magic.status !== 'confirmed' ? magic.replaces : undefined;
  const [moved, setMoved] = useState(false);
  // ADR 0348 — ✓ adds the meeting; this box is the only way to invite.
  const [sendInvites, setSendInvites] = useState(false);
  const canInvite = isEvent && !isInvite && magic.status !== 'confirmed' && !!magic.invitees?.length;
  const accept = async (replaceEventId?: string) => {
    setState('busy');
    try {
      const res = await answerProposal({
        proposalId: magic.proposalId,
        memberIds: [magic.proposalId],
        action: 'confirm',
        ...(replaceEventId ? { replaceEventId } : {}),
        ...(sendInvites && canInvite && !replaceEventId ? { sendInvites: true } : {}),
        label: magic.title,
      });
      setMoved(!!replaceEventId);
      setState(res.queued ? 'queued' : 'added');
      onConfirmed?.(magic.proposalId);
    } catch (err) {
      // ADR 0312 — this mailbox has no calendar of its own; the picker is on
      // the Action Items card.
      setNeedsCalendar(String(err).includes('calendar_required'));
      setState('failed');
    }
  };
  // ADR 0104 - an invitation is answered, and the organizer hears it before
  // anything is recorded. A failure leaves the card live with the reason, so
  // an unanswered invitation keeps looking like one.
  const answer = async (response: 'accepted' | 'tentative' | 'declined') => {
    setState('busy');
    setReplyErr(null);
    try {
      await rsvpProposal(magic.proposalId, response);
      if (response === 'declined') {
        onDismissed?.(magic.proposalId);
        return;
      }
      setAnswered(response);
      setState('added');
      onConfirmed?.(magic.proposalId);
    } catch (err) {
      setReplyErr(rsvpErrorText(err));
      setState('idle');
    }
  };
  // ADR 0346 phase 5 - nobody said who sends the invite; "wait" holds the
  // slot until theirs arrives, and the card goes.
  const waitForTheirs = async () => {
    setState('busy');
    setReplyErr(null);
    try {
      await waitForInvite(magic.proposalId);
      onDismissed?.(magic.proposalId);
    } catch (err) {
      setReplyErr(String((err as Error).message ?? err));
      setState('idle');
    }
  };
  const dismiss = async () => {
    setState('busy');
    try {
      await answerProposal({
        proposalId: magic.proposalId,
        memberIds: [magic.proposalId],
        action: 'reject',
        label: magic.title,
      });
      onDismissed?.(magic.proposalId);
    } catch {
      setState('failed');
    }
  };

  // Away from its email the card can also put that email away: archive or
  // Trash per the swipe setting, and this suggestion goes with it.
  const putAway = async () => {
    if (!threadId) return;
    setState('busy');
    setReplyErr(null);
    try {
      await putEmailAway(threadId, removeAction);
      await rejectProposal(magic.proposalId).catch(() => {});
      onDismissed?.(magic.proposalId);
    } catch {
      setReplyErr(putAwayErrorText(removeAction));
      setState('idle');
    }
  };

  const bodyLines = (
    <>
      <Text style={[styles.kind, state === 'added' && styles.kindDone]}>
        ✨ {isChange ? 'CHANGE' : isEvent ? 'EVENT FOUND' : isTask ? 'TO DO' : 'LIST ITEM'}
      </Text>
      <Text style={[styles.title, wide && styles.titleWide]} numberOfLines={2}>
        {magic.title}
      </Text>
      {detail ? (
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {replaces ? (
        <Text style={styles.detail} numberOfLines={2}>
          ↻ Replaces {replaces.title}, {when(replaces.startsAt)}?
        </Text>
      ) : null}
      {magic.note ? (
        <Text style={styles.detail} numberOfLines={2}>
          {magic.note}
        </Text>
      ) : null}
      {magic.whoSends === 'ask' && magic.status !== 'confirmed' ? (
        <Text style={styles.detail} numberOfLines={2}>
          Nobody said who sends the invite: add it, or wait for theirs?
        </Text>
      ) : null}
      {canInvite ? (
        <InviteChoice
          invitees={magic.invitees!}
          checked={sendInvites}
          onChange={setSendInvites}
          disabled={state === 'busy'}
        />
      ) : null}
      {isEvent && magic.status !== 'confirmed' ? (
        <CalendarFitNote
          fit={magic.fit}
          proposalId={magic.proposalId}
          onSuggestTime={
            threadId && isInvite
              ? () => {
                  openDraftedReply(threadId, SUGGEST_ANOTHER_TIME).catch((e: Error) => setReplyErr(e.message));
                }
              : undefined
          }
        />
      ) : null}
      {magic.targetGroupName ? (
        // ADR 0077 - confirm fans out to this group; say so before the tap.
        <Text style={styles.groupChip} numberOfLines={1}>
          → {magic.targetGroupName}
        </Text>
      ) : null}
      {threadId ? <Text style={styles.open}>Read the email ›</Text> : null}
    </>
  );

  const body = threadId ? (
    <Pressable
      style={wide ? styles.wideBody : undefined}
      onPress={() => router.push(`/email/${threadId}`)}
    >
      {bodyLines}
    </Pressable>
  ) : (
    <View style={wide ? styles.wideBody : undefined}>{bodyLines}</View>
  );

  const status =
    state === 'queued' ? (
      <Text style={styles.ok}>✓ Will be added when you're back online</Text>
    ) : state === 'added' ? (
      <Text style={styles.ok}>
        {isChange
          ? '✓ Updated'
          : moved
            ? '✓ Moved to the new time'
          : isInvite && answered
            ? answered === 'accepted'
              ? '✓ Accepted - organizer told'
              : '✓ Maybe - organizer told'
            : `✓ Added${isEvent ? ' to calendar' : isTask ? ' to your to-dos' : ' to list'}`}
      </Text>
    ) : state === 'failed' ? (
      <Text style={styles.err}>
        {needsCalendar ? 'Pick a calendar for it in Action Items' : 'Failed - see Catchup'}
      </Text>
    ) : null;

  const actions =
    status === null && isInvite ? (
      <View style={[styles.acts, wide && styles.actsWide]}>
        {(
          [
            ['accepted', 'Yes'],
            ['tentative', 'Maybe'],
            ['declined', 'No'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            style={[
              styles.add,
              wide ? styles.addWide : styles.addNarrow,
              value === 'declined' && styles.addNo,
              recommendedRsvp(magic.fit) === value && styles.addPick,
            ]}
            disabled={state === 'busy'}
            onPress={() => void answer(value)}
          >
            <Text style={styles.addTxt}>{state === 'busy' ? '…' : label}</Text>
          </Pressable>
        ))}
      </View>
    ) : status === null ? (
      <View style={[styles.acts, wide && styles.actsWide]}>
        {replaces ? (
          <Pressable
            style={[styles.add, wide ? styles.addWide : styles.addNarrow]}
            disabled={state === 'busy'}
            onPress={() => void accept(replaces.eventId)}
          >
            <Text style={styles.addTxt}>{state === 'busy' ? '…' : 'Move it'}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.add, wide ? styles.addWide : styles.addNarrow]}
          disabled={state === 'busy'}
          onPress={() => void accept()}
        >
          <Text style={styles.addTxt}>
            {state === 'busy'
              ? '…'
              : canInvite && sendInvites
                ? 'Add and invite'
              : replaces
                ? 'Add as new'
                : isChange
                ? 'Apply'
                : wide
                ? isEvent
                  ? 'Add to calendar'
                  : isTask
                    ? 'Add to-do'
                    : 'Add to list'
                : 'Add'}
          </Text>
        </Pressable>
        {magic.whoSends === 'ask' ? (
          <Pressable
            style={[styles.add, wide ? styles.addWide : styles.addNarrow]}
            disabled={state === 'busy'}
            onPress={() => void waitForTheirs()}
          >
            <Text style={styles.addTxt}>Wait for theirs</Text>
          </Pressable>
        ) : null}
        {threadId ? (
          <PutAwayButton
            action={removeAction}
            busy={state === 'busy'}
            onPress={() => void putAway()}
            style={wide ? undefined : styles.putAwayNarrow}
          />
        ) : null}
        <Pressable style={styles.dis} disabled={state === 'busy'} onPress={() => void dismiss()}>
          <Text style={styles.disTxt}>✕</Text>
        </Pressable>
      </View>
    ) : null;

  return (
    <View style={[styles.card, wide && styles.cardWide, state === 'added' && styles.cardDone]}>
      {body}
      {replyErr ? <Text style={styles.err}>{replyErr}</Text> : null}
      {status}
      {actions}
    </View>
  );
}

const styles = themed((colors) => ({
  card: {
    backgroundColor: colors.accentLight,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  cardWide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  cardDone: { borderColor: colors.green, backgroundColor: colors.greenBg },
  wideBody: { flex: 1, minWidth: 0 },
  kind: { color: colors.accent, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  kindDone: { color: colors.green },
  title: { color: colors.text, fontSize: 12, fontWeight: '600', marginTop: 3, lineHeight: 15 },
  titleWide: { fontSize: 13.5, lineHeight: 18 },
  detail: { color: colors.muted, fontSize: 11, marginTop: 1 },
  groupChip: { color: colors.accent, fontSize: 10.5, fontWeight: '700', marginTop: 2 },
  open: { color: colors.accent, fontSize: 10.5, fontWeight: '600', marginTop: 3 },
  ok: { color: colors.green, fontSize: 11, fontWeight: '700', marginTop: 5 },
  err: { color: colors.red, fontSize: 11, fontWeight: '600', marginTop: 5 },
  acts: { flexDirection: 'row', gap: 5, marginTop: 6 },
  actsWide: { marginTop: 0, flexShrink: 0 },
  add: {
    backgroundColor: colors.accent,
    borderRadius: 7,
    paddingVertical: 4,
    alignItems: 'center',
  },
  // Narrow variant fills its column; wide variant is left with no flex props so
  // it sizes to its label. `flex: 0` is not the way to say that — RN-Web expands
  // it to `flexBasis: 0%` (collapses to "Add to\ncalendar") and on native the
  // mix with the base `flex: 1` dropped the label entirely.
  addNarrow: { flex: 1 },
  addWide: { paddingHorizontal: 12, paddingVertical: 7 },
  addNo: { backgroundColor: colors.red },
  // ADR 0346 - the answer the calendar points to.
  addPick: { borderWidth: 2, borderColor: colors.text },
  addTxt: { color: colors.onAccent, fontSize: 11, fontWeight: '700' },
  dis: {
    width: 26,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disTxt: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  putAwayNarrow: { width: 26, height: undefined },
}));
