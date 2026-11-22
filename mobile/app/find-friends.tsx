/**
 * Find friends on Chord (ADR 0065 - deterministic contact discovery).
 *
 * Flow: verified-phone gate → in-app rationale BEFORE the OS contacts prompt
 * (I1 rule: the scary system dialog is never the first thing a user sees) →
 * read device contacts → normalize + hash client-side → upload hashes →
 * render the resolved matches. Raw names/numbers never leave the phone;
 * previously-resolved links load instantly from the server.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Contacts from 'expo-contacts';

import type { PhoneStatus, ResolvedContact } from '@chord/kernel';
import { getPhoneStatus, listContactLinks, resolveContacts } from '@/api';
import { backHomeHeaderLeft, goBackOr } from '@/back-home';
import { buildContactUpload, type DeviceContactInput } from '@/contact-hash';
import { avatarFor, colors, themed } from '@/theme';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

type Phase =
  | 'loading'
  | 'unsupported'
  | 'needsPhone'
  | 'rationale'
  | 'denied'
  | 'scanning'
  | 'done'
  | 'error';

export default function FindFriendsScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [matches, setMatches] = useState<ResolvedContact[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (Platform.OS === 'web') {
        setPhase('unsupported');
        return;
      }
      try {
        const status = await getPhoneStatus();
        if (cancelled) return;
        setPhone(status);
        if (!status.verified) {
          setPhase('needsPhone');
          return;
        }
        // Show any previously-resolved links immediately.
        const existing = await listContactLinks().catch(() => null);
        if (cancelled) return;
        if (existing && existing.resolved.length > 0) setMatches(existing.resolved);

        const perm = await Contacts.getPermissionsAsync();
        if (cancelled) return;
        if (perm.status === 'granted') {
          setPhase('scanning');
        } else if (perm.status === 'denied' && !perm.canAskAgain) {
          setPhase('denied');
        } else {
          setPhase('rationale');
        }
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scan = useCallback(async () => {
    if (!phone?.contactHashPepper) return;
    setPhase('scanning');
    setErrMsg(null);
    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });
      const inputs: DeviceContactInput[] = data
        .map((c) => ({
          name: c.name ?? '',
          phoneNumbers: (c.phoneNumbers ?? [])
            .map((p) => p.number ?? '')
            .filter((n) => n.length > 0),
        }))
        .filter((c) => c.name && c.phoneNumbers.length > 0);
      const upload = buildContactUpload(inputs, phone.contactHashPepper);
      if (upload.length === 0) {
        setMatches([]);
        setScannedAt(new Date().toISOString());
        setPhase('done');
        return;
      }
      const res = await resolveContacts({ contacts: upload });
      setMatches(res.resolved);
      setScannedAt(new Date().toISOString());
      setPhase('done');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'scan failed');
      setPhase('error');
    }
  }, [phone]);

  // Once permission is granted (either pre-existing or just now), run the scan.
  useEffect(() => {
    if (phase === 'scanning') void scan();
  }, [phase, scan]);

  const requestPermission = useCallback(async () => {
    const perm = await Contacts.requestPermissionsAsync();
    if (perm.status === 'granted') {
      setPhase('scanning');
    } else if (!perm.canAskAgain) {
      setPhase('denied');
    }
    // Dismissed but can ask again → stay on the rationale.
  }, []);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Find friends', headerLeft: backHomeHeaderLeft('Settings', '/settings') }} />

      {phase === 'loading' && (
        <View style={s.centerFill}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {phase === 'unsupported' && (
        <Card title="Use your phone for this">
          <Text style={s.muted}>
            Contact matching reads your phone&rsquo;s address book, so it only works in the
            iOS and Android apps.
          </Text>
        </Card>
      )}

      {phase === 'needsPhone' && (
        <Card title="Verify your number first">
          <Text style={s.muted}>
            Friends find you by phone number, so yours needs to be verified before Chord can
            match your contacts.
          </Text>
          <Pressable style={s.btn} onPress={() => goBackOr('/settings')}>
            <Text style={s.btnText}>Add your number in Settings</Text>
          </Pressable>
        </Card>
      )}

      {phase === 'rationale' && (
        <Card title="Find friends on Chord">
          <Text style={s.muted}>
            Chord matches scrambled versions of your contacts&rsquo; numbers against Chord
            accounts. Names and numbers never leave your phone, and nothing is shared with
            your contacts.
          </Text>
          {/* App Store 5.1.1(iv): the explanation only goes on to the system prompt. */}
          <Pressable style={s.btn} onPress={() => void requestPermission()}>
            <Text style={s.btnText}>Continue</Text>
          </Pressable>
        </Card>
      )}

      {phase === 'denied' && (
        <Card title="Contacts access is off">
          <Text style={s.muted}>
            Turn on contact access for Chord in your device settings to find friends.
          </Text>
          <Pressable style={s.btn} onPress={() => void Linking.openSettings()}>
            <Text style={s.btnText}>Open settings</Text>
          </Pressable>
        </Card>
      )}

      {phase === 'scanning' && (
        <View style={s.centerFill}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[s.muted, { marginTop: 12 }]}>Matching your contacts…</Text>
        </View>
      )}

      {phase === 'error' && (
        <Card title="Couldn't match contacts">
          <Text style={s.muted}>{errMsg ?? 'Check your connection and try again.'}</Text>
          <Pressable style={s.btn} onPress={() => void scan()}>
            <Text style={s.btnText}>Try again</Text>
          </Pressable>
        </Card>
      )}

      {phase === 'done' &&
        (matches.length === 0 ? (
          <Card title="No matches yet">
            <Text style={s.muted}>
              None of your contacts are on Chord yet. Invite someone with a join link from
              any group&rsquo;s settings.
            </Text>
            <Pressable style={s.btnGhost} onPress={() => void scan()}>
              <Text style={s.btnGhostTxt}>Scan again</Text>
            </Pressable>
          </Card>
        ) : (
          <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
            data={matches}
            keyExtractor={(m) => m.chordUserId}
            contentContainerStyle={s.listContent}
            ListHeaderComponent={
              <Text style={s.countLine}>
                {matches.length === 1
                  ? '1 of your contacts is on Chord'
                  : `${matches.length} of your contacts are on Chord`}
              </Text>
            }
            renderItem={({ item }) => {
              const av = avatarFor(item.displayName);
              return (
                <View style={s.rowCard}>
                  <View style={[s.avatar, { backgroundColor: av.bg }]}>
                    <Text style={[s.avatarTxt, { color: av.fg }]}>{av.initials}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.name}>{item.displayName}</Text>
                    {item.name.trim().toLowerCase() !==
                      item.displayName.trim().toLowerCase() && (
                      <Text style={s.sub}>In your contacts as “{item.name}”</Text>
                    )}
                  </View>
                </View>
              );
            }}
            ListFooterComponent={
              <View style={{ alignItems: 'center', marginTop: 12 }}>
                {scannedAt && (
                  <Text style={s.sub}>
                    Last matched {new Date(scannedAt).toLocaleTimeString()}
                  </Text>
                )}
                <Pressable onPress={() => void scan()}>
                  <Text style={s.link}>Refresh</Text>
                </Pressable>
              </View>
            }
          />
        ))}
    </View>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

const s = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 13, marginTop: 6, lineHeight: 19 },
  btn: {
    backgroundColor: colors.accent,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 14,
  },
  btnText: { color: colors.onAccent, fontWeight: '600' },
  btnGhost: {
    borderColor: colors.accent,
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  btnGhostTxt: { color: colors.accent, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', marginTop: 8 },
  listContent: { paddingBottom: 24 },
  countLine: { color: colors.muted, fontSize: 13, marginBottom: 8 },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 8,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { fontSize: 14, fontWeight: '600' },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
}));
