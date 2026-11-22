/**
 * Invite-link landing route: `/join/<CODE>`.
 *
 * Signed in  → join the group and drop the user straight into the chat.
 * Signed out → stash the code (survives Google's full-page OAuth redirect,
 *              same AsyncStorage trick as the Telegram `?ref=` referrer in
 *              app/index.tsx - see ADR 0047) and bounce to the landing page
 *              to sign in. The welcome screen consumes the code afterward and
 *              redirects back here, where `user` is now set.
 */
import { Link, Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { isFamilyInviteCode } from '@chord/kernel';

import { acceptFamilyInvite, getGroup, joinGroup } from '@/api';
import { clearPendingJoinCode, writePendingJoinCode } from '@/join-code';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';

export default function JoinScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const user = useApp((s) => s.user);
  const upsertGroup = useApp((s) => s.upsertGroup);
  const [error, setError] = useState<string | null>(null);
  const [familyOwner, setFamilyOwner] = useState<string | null>(null);
  const [familyGroupId, setFamilyGroupId] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void (async () => {
      if (!user) {
        // Persist the code BEFORE navigating so the landing page is
        // guaranteed to see it after sign-in (incl. the OAuth round-trip).
        await writePendingJoinCode(code);
        if (!cancelled) router.replace('/');
        return;
      }
      try {
        // ADR 0231 — a family-plan invite rides the same link shape as a group
        // invite (so the verified universal-link route covers it); the prefix
        // says which it is.
        if (isFamilyInviteCode(code)) {
          const out = await acceptFamilyInvite(code);
          await clearPendingJoinCode();
          // The chat screen reads the group from the store; this one did not
          // exist a moment ago, so put it there before offering the link.
          await getGroup(out.groupId).then(upsertGroup).catch(() => {});
          if (!cancelled) {
            setFamilyGroupId(out.groupId);
            setFamilyOwner(out.ownerName);
          }
          return;
        }
        const g = await joinGroup({ inviteCode: code });
        await clearPendingJoinCode();
        if (cancelled) return;
        upsertGroup(g);
        router.replace(`/groups/${g.id}`);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, user, upsertGroup]);

  if (!code) return <Redirect href="/groups" />;

  if (familyOwner) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>You&rsquo;re in</Text>
        <Text style={styles.body}>
          You&rsquo;re now on {familyOwner}&rsquo;s family plan, so your Chord is covered. You share one pool
          of tokens with the rest of the family. Your family chat is ready.
        </Text>
        <Link href={familyGroupId ? `/groups/${familyGroupId}` : '/groups'} style={styles.link}>
          <Text style={styles.linkText}>{familyGroupId ? 'Open the family chat' : 'Open Chord'}</Text>
        </Link>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {error ? (
        <>
          <Text style={styles.title}>Couldn&rsquo;t join</Text>
          <Text style={styles.body}>
            {error === 'invite not found' || error === 'not_found'
              ? 'That invite link is invalid or has already been used. Ask for a fresh link.'
              : error === 'already_in_family'
                ? 'You are already on a family plan. Leave it in Settings first if you want to switch.'
                : error === 'owns_family'
                  ? 'You have your own family plan, so you cannot also join another.'
                  : error === 'own_invite'
                    ? 'That is your own invite - send it to the person you are inviting.'
                    : error}
          </Text>
          <Link href="/groups" style={styles.link}>
            <Text style={styles.linkText}>Back to chats</Text>
          </Link>
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.body}>Joining…</Text>
        </>
      )}
    </View>
  );
}

const styles = themed((colors) => ({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: colors.bg,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  body: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  link: { marginTop: 8 },
  linkText: { color: colors.accent, fontWeight: '600' },
}));
