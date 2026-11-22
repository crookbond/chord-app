/**
 * ADR 0231 — your family: the people on your plan, who has been invited, and
 * who may put tasks and events on your plate (a "Chordinator"). A child with
 * no phone or email is just a profile and costs no seat; inviting someone
 * holds one of the plan's four seats (you are the first).
 *
 * Invites are shared through the system share sheet rather than sent by
 * Chord: it works for text and email alike, comes from the person the
 * invitee knows, and needs no SMS or mail sender of ours.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Share, Switch, Text, View } from 'react-native';
import { TextInput } from '@/text-input';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';

import type { FamilyInviteResult, FamilyMember, FamilyOverview } from '@chord/kernel';

import {
  addFamilyMember,
  getFamily,
  getGroup,
  inviteFamilyMember,
  leaveFamily,
  removeFamilyMember,
  updateFamilyMember,
} from '@/api';
import { confirmDestructive } from '@/confirm';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';

const ERROR_TEXT: Record<string, string> = {
  invalid_email: "That email address doesn't look right.",
  need_contact: 'Add an email or phone number first, so there is a way to send the invite.',
  no_seats: 'All 4 seats are taken. Remove someone to free one.',
  already_active: 'They have already joined.',
  not_found: 'That person is no longer on the list.',
};
const errorText = (e: unknown): string => ERROR_TEXT[(e as Error).message] ?? (e as Error).message;

async function shareInvite(invite: FamilyInviteResult): Promise<string | null> {
  if (Platform.OS === 'web') {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { share?: (d: { text: string }) => Promise<void> })
        : undefined;
    if (nav?.share) {
      await nav.share({ text: invite.message }).catch(() => {});
      return null;
    }
    await Clipboard.setStringAsync(invite.message);
    return 'Invite copied - paste it into a message.';
  }
  await Share.share({ message: invite.message }).catch(() => {});
  return null;
}

/**
 * ADR 0237 - what to do after an invite, and what to tell the owner. Someone who
 * is already on Chord is simply covered; otherwise Chord emails the invite from
 * the owner's own mailbox, and the share sheet is for the text (Chord has no SMS
 * sender) or for when that email could not go.
 */
async function afterInvite(out: FamilyInviteResult): Promise<string | null> {
  const name = out.member.name;
  const emailed = out.delivery?.email === 'queued';
  if (out.joined) {
    return `${name} is on Chord already, so your plan covers them now. We told them in the app${
      emailed ? ' and emailed them' : ''
    }.`;
  }
  if (emailed && !out.member.phone) return `Invite emailed to ${out.member.email} from your mailbox.`;
  const shared = await shareInvite(out);
  if (emailed) return `Invite emailed to ${out.member.email}.${shared ? ` ${shared}` : ''}`;
  const couldNot = out.delivery?.email === 'no_mailbox' || out.delivery?.email === 'failed';
  return couldNot
    ? `Couldn't email from your account, so share the invite instead.${shared ? ` ${shared}` : ''}`
    : shared;
}

const STATUS_LABEL: Record<FamilyMember['status'], string> = {
  profile: 'Profile',
  invited: 'Invited',
  active: 'Joined',
};

/** ADR 0234 - the family's shared chat, one tap from the plan screen. */
function FamilyChatButton({ groupId }: { groupId: string }) {
  const upsertGroup = useApp((st) => st.upsertGroup);
  const open = async () => {
    // The chat screen reads the group from the store, and a chat created since
    // the list was last loaded is not in it yet.
    await getGroup(groupId).then(upsertGroup).catch(() => {});
    router.push(`/groups/${groupId}`);
  };
  return (
    <Pressable style={s.ghost} onPress={() => void open()}>
      <Text style={s.ghostText}>Open family chat</Text>
    </Pressable>
  );
}

interface Props {
  /** Bumps when billing changes, so seats/plan state refreshes. */
  reloadKey?: unknown;
}

export function FamilyCard({ reloadKey }: Props) {
  const [family, setFamily] = useState<FamilyOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [invite, setInvite] = useState(true);
  const [chordinator, setChordinator] = useState(false);

  const load = useCallback(async () => {
    setFamily(await getFamily().catch(() => null));
  }, []);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      setErr(null);
      setNote(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const canInvite = !!(email.trim() || phone.trim());
  const add = () =>
    run('add', async () => {
      const out = await addFamilyMember({
        name,
        email: email || undefined,
        phone: phone || undefined,
        relationship: relationship || undefined,
        chordinator,
        invite: invite && canInvite,
      });
      if ('inviteLink' in out) setNote(await afterInvite(out));
      setName('');
      setRelationship('');
      setEmail('');
      setPhone('');
      setChordinator(false);
      setAdding(false);
    });

  if (!family) return null;

  // "1 of 4 seats used" means something only once there is a family plan. A
  // person with no plan has no seats to count, so the card stays out of the way
  // until they buy one - or have already started a roster (added people in chat
  // before buying, or let a plan lapse), which must stay reachable.
  if (family.role === 'none') return null;
  if (family.role === 'owner' && !family.planActive && family.members.length === 0) return null;

  if (family.role === 'member') {
    return (
      <View style={s.card}>
        <Text style={s.label}>Family</Text>
        <Text style={s.title}>You&apos;re on {family.ownerName ?? 'a family member'}&apos;s family plan</Text>
        <Text style={s.muted}>
          {family.planActive
            ? 'Your Chord is paid for. You share one pool of tokens with the rest of the family.'
            : "Their plan isn't active right now, so you are not covered until it is renewed."}
        </Text>
        {family.groupId ? <FamilyChatButton groupId={family.groupId} /> : null}
        <Pressable
          style={s.ghost}
          disabled={busy !== null}
          onPress={() =>
            confirmDestructive(
              'Leave this family plan?',
              'You will stop sharing their plan and will need your own to keep using Chord after your trial.',
              () => void run('leave', () => leaveFamily()),
              { confirmLabel: 'Leave' },
            )
          }
        >
          <Text style={s.ghostText}>Leave family plan</Text>
        </Pressable>
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
    );
  }

  return (
    <View style={s.card}>
      <Text style={s.label}>Family</Text>
      <Text style={s.title}>
        {family.seatsUsed} of {family.seats} seats used
      </Text>
      <Text style={s.muted}>
        The family plan covers {family.seats} people with one shared pool of tokens. Add children
        and others as profiles for free; invite the ones who will use Chord themselves.
        {family.planActive ? '' : ' Invited people are covered once you are on the family plan.'}
      </Text>
      {family.groupId ? <FamilyChatButton groupId={family.groupId} /> : null}

      {family.members.map((m) => (
        <View key={m.id} style={s.member}>
          <View style={s.memberHead}>
            <View style={s.flex}>
              <Text style={s.memberName}>
                {m.name}
                {m.relationship ? <Text style={s.muted}>{`  ·  ${m.relationship}`}</Text> : null}
              </Text>
              <Text style={s.muted}>
                {[m.email, m.phone].filter(Boolean).join('  ·  ') || 'No email or phone yet'}
              </Text>
            </View>
            <View style={[s.pill, m.status === 'active' && s.pillOn]}>
              <Text style={[s.pillText, m.status === 'active' && s.pillTextOn]}>{STATUS_LABEL[m.status]}</Text>
            </View>
          </View>
          <View style={s.switchRow}>
            <Text style={s.switchLabel}>Can add tasks and events for me</Text>
            <Switch
              value={m.chordinator}
              disabled={busy !== null}
              onValueChange={(v) => void run(`c-${m.id}`, async () => void (await updateFamilyMember(m.id, { chordinator: v })))}
            />
          </View>
          <View style={s.actions}>
            {m.status !== 'active' && (m.email || m.phone) ? (
              <Pressable
                disabled={busy !== null}
                onPress={() =>
                  void run(`i-${m.id}`, async () => {
                    setNote(await afterInvite(await inviteFamilyMember(m.id)));
                  })
                }
              >
                <Text style={s.link}>{m.status === 'invited' ? 'Share invite again' : 'Invite'}</Text>
              </Pressable>
            ) : null}
            <Pressable
              disabled={busy !== null}
              onPress={() =>
                confirmDestructive(
                  `Remove ${m.name}?`,
                  m.status === 'active'
                    ? `${m.name} will stop being covered by your plan right away.`
                    : `${m.name} will be taken off your family list.`,
                  () => void run(`r-${m.id}`, () => removeFamilyMember(m.id)),
                  { confirmLabel: 'Remove' },
                )
              }
            >
              <Text style={[s.link, s.linkDanger]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {adding ? (
        <View style={s.form}>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.muted} />
          <TextInput
            style={s.input}
            value={relationship}
            onChangeText={setRelationship}
            placeholder="Relationship (wife, son, mom...)"
            placeholderTextColor={colors.muted}
          />
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email (to invite them)"
            placeholderTextColor={colors.muted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={s.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="Phone (to invite them)"
            placeholderTextColor={colors.muted}
            keyboardType="phone-pad"
          />
          {canInvite ? (
            <>
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Invite them to share my plan</Text>
                <Switch value={invite} onValueChange={setInvite} />
              </View>
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Let them add tasks and events for me</Text>
                <Switch value={chordinator} onValueChange={setChordinator} />
              </View>
            </>
          ) : (
            <Text style={s.muted}>Without an email or phone this is just a profile - no invite, no seat.</Text>
          )}
          <View style={s.row}>
            <Pressable style={[s.ghost, s.inRow]} onPress={() => setAdding(false)}>
              <Text style={s.ghostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[s.btn, (!name.trim() || busy !== null) && s.disabled]}
              disabled={!name.trim() || busy !== null}
              onPress={() => void add()}
            >
              {busy === 'add' ? <ActivityIndicator color={colors.onAccent} /> : <Text style={s.btnText}>Add</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={s.ghost} onPress={() => setAdding(true)}>
          <Text style={s.ghostText}>Add a family member</Text>
        </Pressable>
      )}
      {note ? <Text style={s.muted}>{note}</Text> : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </View>
  );
}

const s = themed((colors) => ({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  flex: { flex: 1 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 6 },
  muted: { color: colors.muted, fontSize: 13, marginTop: 4 },
  member: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 12, paddingTop: 12 },
  memberHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  memberName: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  pill: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 3 },
  pillOn: { borderColor: colors.green },
  pillText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  pillTextOn: { color: colors.green },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 12 },
  switchLabel: { color: colors.text, fontSize: 13.5, flex: 1 },
  actions: { flexDirection: 'row', gap: 18, marginTop: 10 },
  link: { color: colors.accent, fontSize: 13.5, fontWeight: '600' },
  linkDanger: { color: colors.red },
  form: { marginTop: 14, gap: 8 },
  row: { flexDirection: 'row', gap: 8, marginTop: 6 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  // Content-width pills, not full-width bars (same as the plan card and Settings).
  btn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 16,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  btnText: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  ghost: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  // A ghost button already inside a row takes the row's spacing, not its own.
  inRow: { marginTop: 0 },
  ghostText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  err: { color: colors.red, fontSize: 13, marginTop: 10 },
}));
