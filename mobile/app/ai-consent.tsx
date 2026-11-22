/**
 * ADR 0283 — Apple 5.1.2(i): before any of a user's data goes to an AI
 * provider, say who receives what and ask. Shown once, after sign-in, before
 * the app opens; Settings → AI model changes the answer later.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { bootReturnPath } from '@chord/kernel';

import { getAiConsentStatus, setAiConsent } from '@/api';
import { launchTab } from '@/group-nav';
import { colors, themed } from '@/theme';

const SENT = [
  'Messages you send to Chord, in the app, WhatsApp or Telegram',
  'Email in the mailboxes you connect: sender, subject, text and attachments',
  'Your calendar events',
  'Files and photos you share with Chord',
  'Names, dates and notes you save about people',
];

export default function AiConsentScreen() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [recipient, setRecipient] = useState<string | null>(null);
  const [age, setAge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getAiConsentStatus()
      .then((s) => {
        setRecipient(s.recipient);
        if (s.consent?.ageConfirmed) setAge(true);
      })
      .catch(() => setRecipient('Chord’s AI provider'));
  }, []);

  const leave = () => {
    const to = bootReturnPath(next, launchTab());
    router.replace(to as never);
  };

  const answer = async (decision: 'granted' | 'declined') => {
    setBusy(true);
    setErr(null);
    try {
      await setAiConsent({ decision, ageConfirmed: age || undefined });
      leave();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!recipient) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>Chord’s AI and your data</Text>
        <Text style={s.p}>
          To answer your questions, sort your email, suggest to-dos and events, and write your morning
          briefing, Chord sends some of your data to this AI service:
        </Text>
        <Text style={s.recipient}>{recipient}</Text>
        <Text style={s.p}>What is sent, only when a feature needs it:</Text>
        {SENT.map((line) => (
          <Text key={line} style={s.bullet}>
            • {line}
          </Text>
        ))}
        <Text style={s.p}>
          It is used only to run Chord for you. It is not sold, and not used for advertising. Nothing is sent
          until you tap Allow, and you can change your answer any time in Settings → AI model.{' '}
          <Link href="/privacy" style={s.link}>
            Privacy policy
          </Link>
        </Text>
        <Text style={s.note}>
          If you choose Not now, your mail, calendar, lists and chats with people still work, but Chord will not
          answer, suggest or summarize anything.
        </Text>

        <Pressable
          style={s.check}
          onPress={() => setAge((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: age }}
        >
          <Text style={s.box}>{age ? '☑' : '☐'}</Text>
          <Text style={s.checkTxt}>I’m 18 or older, or my parent or guardian has agreed to let me use Chord.</Text>
        </Pressable>

        {err ? <Text style={s.err}>{err}</Text> : null}

        <Pressable
          style={[s.btn, (!age || busy) && s.off]}
          disabled={!age || busy}
          onPress={() => void answer('granted')}
          accessibilityRole="button"
        >
          <Text style={s.btnTxt}>Allow</Text>
        </Pressable>
        <Pressable
          style={[s.ghost, busy && s.off]}
          disabled={busy}
          onPress={() => void answer('declined')}
          accessibilityRole="button"
        >
          <Text style={s.ghostTxt}>Not now</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = themed((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 20, paddingBottom: 40, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 12 },
  p: { color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 10 },
  recipient: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  bullet: { color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 4, paddingLeft: 4 },
  link: { color: colors.text, textDecorationLine: 'underline' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 14 },
  check: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 20, paddingVertical: 6 },
  box: { color: colors.text, fontSize: 20, lineHeight: 22 },
  checkTxt: { color: colors.text, fontSize: 15, lineHeight: 22, flex: 1 },
  err: { color: colors.red, marginTop: 10 },
  btn: {
    marginTop: 18,
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnTxt: { color: colors.onAccent, fontSize: 16, fontWeight: '700' },
  ghost: {
    marginTop: 10,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostTxt: { color: colors.text, fontSize: 16, fontWeight: '600' },
  off: { opacity: 0.4 },
}));
