/**
 * ADR 0157 addendum — guests in the event editor.
 *
 * The list is read from the calendar event (ADR 0295: Chord keeps none) and a
 * change is the same calendar write as the bot's `update_event` invitees, so
 * the calendar mails the invitation. The box suggests from mail, People and,
 * on a phone, this phone's contacts (matched on the device). Only addresses
 * are sent; a typed name that was not picked is pointed out, not guessed.
 *
 * ADR 0306: "Reply all" opens the composer addressed to the organizer and
 * every guest, the event's title as the subject.
 *
 * ADR 0319/0323: the video-call button is named by what this event's calendar
 * hosts - "Add Google Meet" on a Google-driven calendar, "Add Teams meeting"
 * on an Outlook / 365 one - and is drawn only when there is one. On a phone
 * calendar there is no button, rather than one that can only fail.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  eventComposeHref,
  eventReplyAllRecipients,
  parseGuestAddresses,
  videoCallLabel,
  type EventGuestsResponse,
  type EventAnswerResponse,
  type EventVideoCallResponse,
  type GuestAnswer,
  type GuestResponse,
} from '@chord/kernel';

import { addEventVideoCall, answerEventInvite, changeEventGuests, getEventGuests } from '@/api';
import { RecipientField } from '@/email-recipient-field';
import { useApp } from '@/store';
import { themed } from '@/theme';

const REFUSED: Record<NonNullable<EventGuestsResponse['reason']>, string> = {
  not_found: 'This event is gone.',
  not_organizer: 'Only the person who organizes this event can change its guests.',
  not_on_calendar: 'This event is not on a connected calendar yet, so nobody can be invited.',
  provider_error: 'The calendar could not be reached. Nobody was invited; try again.',
};

const MEET_REFUSED: Record<NonNullable<EventVideoCallResponse['reason']>, string> = {
  not_found: 'This event is gone.',
  not_organizer: 'Only the person who organizes this event can add a video call.',
  not_on_calendar: 'This event is not on a connected calendar yet, so no video call was added.',
  no_video_call:
    'Chord only reads this event’s calendar, so it cannot add a video call to it.',
  teams_unavailable:
    'This Outlook calendar does not offer Teams meetings. A personal Outlook account has no Teams for Business, and a work account needs the licence. Nothing was added.',
  provider_error: 'The calendar could not be reached. No video call was added; try again.',
};

/** ADR 0328 — a guest's answer as a short word beside their address. */
const ANSWER: Record<GuestResponse, string> = {
  accepted: 'Yes',
  tentative: 'Maybe',
  declined: 'No',
  needsAction: 'Not answered',
};

const ANSWER_REFUSED: Record<NonNullable<EventAnswerResponse['reason']>, string> = {
  not_found: 'This invitation is gone.',
  not_invited: 'This event is not an invitation to you.',
  no_route:
    'Your answer could not be sent: connect the calendar or mailbox this invitation went to (Settings), or answer from the invitation email.',
  send_failed: 'Your calendar or mail refused the answer. Nothing was sent; try again.',
};

/** A reason this build does not know is still a refusal: say so plainly
 *  rather than show nothing, which would read as having worked. */
const refusedText = (reason: NonNullable<EventVideoCallResponse['reason']>): string =>
  MEET_REFUSED[reason] ?? 'No video call was added.';

export function EventGuests({
  eventId,
  title,
  onLeave,
  hasVideoCall,
}: {
  eventId: string;
  title: string;
  /** The event already has a call to join (its own, or one in its text): no "Add" button. */
  hasVideoCall?: boolean;
  /** Close whatever holds this before the composer opens. */
  onLeave?: () => void;
}) {
  const [guests, setGuests] = useState<string[] | null>(null);
  const [organizer, setOrganizer] = useState<string | null>(null);
  const [answers, setAnswers] = useState<GuestAnswer[]>([]);
  // ADR 0328 — set when the viewer was invited: their answer, changeable here.
  const [myInvite, setMyInvite] = useState<EventGuestsResponse['myInvite']>(undefined);
  const answerOf = useMemo(() => new Map(answers.map((a) => [a.email.toLowerCase(), a])), [answers]);
  const myEmail = useApp((s) => s.user?.email) ?? null;
  const replyAll = useMemo(
    () => eventReplyAllRecipients(guests, organizer, [myEmail]),
    [guests, organizer, myEmail],
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [meetLink, setMeetLink] = useState<string | null>(null);
  // ADR 0319/0323 — what this event's calendar can be given, which also names
  // the button. Null = nothing, so none is drawn: a button that can only fail
  // is worse than its absence. Undefined until the guests read answers.
  const [videoCall, setVideoCall] = useState<EventGuestsResponse['videoCall']>(undefined);

  useEffect(() => {
    let live = true;
    setGuests(null);
    setMeetLink(null);
    setVideoCall(undefined);
    setOrganizer(null);
    setAnswers([]);
    setMyInvite(undefined);
    setNote(null);
    setDraft('');
    void getEventGuests(eventId)
      .then((r) => {
        if (!live) return;
        setGuests(r.guests ?? []);
        setOrganizer(r.organizer ?? null);
        setAnswers(r.answers ?? []);
        setMyInvite(r.myInvite);
        setVideoCall(r.videoCall ?? null);
        // An event that already has a call shows its link, not an Add button.
        setMeetLink(r.videoCallLink ?? null);
      })
      .catch(() => live && setGuests([]));
    return () => {
      live = false;
    };
  }, [eventId]);

  const apply = useCallback(
    async (change: { add?: string[]; remove?: string[] }) => {
      setBusy(true);
      setNote(null);
      try {
        const r = await changeEventGuests(eventId, change);
        if (r.guests) setGuests(r.guests);
        if (r.reason) setNote(REFUSED[r.reason]);
        else if (r.added?.length) setNote(`Invited ${r.added.join(', ')}. The calendar sends the invitation.`);
        return !r.reason;
      } catch (e) {
        setNote((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [eventId],
  );

  const addMeet = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await addEventVideoCall(eventId);
      if (r.reason) setNote(refusedText(r.reason));
      else if (r.link) setMeetLink(r.link);
      // Accepted with no link yet can only be a Meet: Graph returns a Teams
      // join URL with the write, so there is nothing to wait for there.
      else setNote(`${videoCallLabel(r.kind ?? 'google_meet')} was requested; the link will show on the event shortly.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [eventId]);

  const answer = useCallback(
    async (response: 'accepted' | 'tentative' | 'declined') => {
      setBusy(true);
      setNote(null);
      try {
        const r = await answerEventInvite(eventId, response);
        if (!r.ok) {
          setNote(ANSWER_REFUSED[r.reason ?? 'send_failed'] ?? 'Your answer was not sent.');
          return;
        }
        setMyInvite({ response });
        const sent = r.via === 'calendar' ? 'through your calendar' : 'by email to the organizer';
        setNote(
          r.removed
            ? `You said no (${sent}). It is off your calendar.`
            : `You said ${ANSWER[response].toLowerCase()} (${sent}).`,
        );
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [eventId],
  );

  const invite = useCallback(async () => {
    const { emails, invalid } = parseGuestAddresses(draft);
    if (invalid.length > 0) {
      setNote(`Not an email address: ${invalid.join(', ')}. Pick the person from the suggestions or type their email.`);
      return;
    }
    if (emails.length === 0) return;
    if (await apply({ add: emails })) setDraft('');
  }, [draft, apply]);

  return (
    <View>
      {myInvite ? (
        <>
          <Text style={styles.label}>Going?</Text>
          <View style={styles.answerRow}>
            {(['accepted', 'tentative', 'declined'] as const).map((r) => (
              <Pressable
                key={r}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: myInvite.response === r }}
                style={[styles.answerBtn, myInvite.response === r && styles.answerBtnOn, busy && { opacity: 0.5 }]}
                onPress={() => void answer(r)}
              >
                <Text style={[styles.answerBtnTxt, myInvite.response === r && styles.answerBtnTxtOn]}>
                  {ANSWER[r]}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <Text style={styles.label}>Guests</Text>
      {guests === null ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : guests.length === 0 && answers.length > 0 ? (
        // A member's own copy: the guest list lives on the organizer's
        // calendar, so show who was invited and their answers, read only.
        answers.map((a) => (
          <View key={a.email} style={styles.guest}>
            <Text style={styles.guestText} numberOfLines={1}>
              {a.name ?? a.email}
            </Text>
            <Text style={[styles.answer, styles[a.response]]}>{ANSWER[a.response]}</Text>
          </View>
        ))
      ) : guests.length === 0 ? (
        <Text style={styles.muted}>No guests.</Text>
      ) : (
        guests.map((g) => (
          <View key={g} style={styles.guest}>
            <Text style={styles.guestText} numberOfLines={1}>
              {answerOf.get(g.toLowerCase())?.name ?? g}
            </Text>
            {answerOf.get(g.toLowerCase()) ? (
              <Text style={[styles.answer, styles[answerOf.get(g.toLowerCase())!.response]]}>
                {ANSWER[answerOf.get(g.toLowerCase())!.response]}
              </Text>
            ) : null}
            <Pressable
              disabled={busy}
              hitSlop={8}
              accessibilityLabel={`Remove ${g}`}
              onPress={() => void apply({ remove: [g] })}
            >
              <Text style={styles.remove}>✕</Text>
            </Pressable>
          </View>
        ))
      )}
      <RecipientField label="Add guests" value={draft} onChangeText={setDraft} placeholder="Name or email" />
      <Pressable
        style={[styles.inviteBtn, (busy || !draft.trim()) && { opacity: 0.5 }]}
        disabled={busy || !draft.trim()}
        onPress={() => void invite()}
      >
        <Text style={styles.inviteTxt}>{busy ? '…' : 'Invite'}</Text>
      </Pressable>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {meetLink ? (
        <Pressable onPress={() => void Linking.openURL(meetLink)} accessibilityRole="link">
          <Text style={styles.meetLink}>📹 {meetLink}</Text>
        </Pressable>
      ) : videoCall && !hasVideoCall ? (
        <Pressable
          style={[styles.replyAllBtn, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={() => void addMeet()}
        >
          <Text style={styles.replyAllTxt}>📹 Add {videoCallLabel(videoCall)}</Text>
        </Pressable>
      ) : null}
      {replyAll.length > 0 ? (
        <Pressable
          style={styles.replyAllBtn}
          accessibilityLabel={`Email everyone on this event: ${replyAll.join(', ')}`}
          onPress={() => {
            onLeave?.();
            router.push(eventComposeHref(replyAll, title) as never);
          }}
        >
          <Text style={styles.replyAllTxt}>
            ✉ Reply all ({replyAll.length})
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = themed((colors) => ({
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  muted: { color: colors.muted, fontSize: 13 },
  guest: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  guestText: { flex: 1, color: colors.text, fontSize: 14 },
  remove: { color: colors.muted, fontSize: 14 },
  answer: { fontSize: 12, fontWeight: '600' },
  answerRow: { flexDirection: 'row', gap: 8 },
  answerBtn: {
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  answerBtnOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  answerBtnTxt: { color: colors.text, fontWeight: '600' },
  answerBtnTxtOn: { color: colors.onAccent },
  accepted: { color: colors.green },
  tentative: { color: colors.warn },
  declined: { color: colors.red },
  needsAction: { color: colors.muted },
  inviteBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: colors.accent,
  },
  inviteTxt: { color: colors.onAccent, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 12, marginTop: 6 },
  replyAllBtn: {
    alignSelf: 'flex-start',
    marginTop: 10,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  replyAllTxt: { color: colors.accent, fontWeight: '600' },
  meetLink: { color: colors.accent, fontSize: 13, marginTop: 10, textDecorationLine: 'underline' },
}));
