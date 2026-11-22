/**
 * ADR 0335 — the consent page an AI app (Claude, ChatGPT) sends the user to
 * when it asks to connect to Chord. It names the app, what it may do, and
 * where the browser goes next; Allow hands the app a one-time code, Deny tells
 * it no. Signed out, it sends the user to sign in (which creates an account
 * for someone new) and comes back here. Signed in, it walks them through
 * three steps - account, mailboxes, allow - then things to ask (ADR 0335
 * addendum).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AI_APP_SCOPE_TEXT,
  AI_APP_TRY_ASKING,
  hasAnyMailbox,
  type AiAppRequestView,
  type EmailStatus,
} from '@chord/kernel';

import { answerAiAppRequest, getAiAppRequest, getEmailStatus } from '@/api';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';

function leaveTo(url: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.assign(url);
    return;
  }
  void Linking.openURL(url);
}

const MAILBOXES_PATH = '/settings?open=mailboxes';

/** Settings' mailbox card: a new tab on the web so this page (and its request) stays open. */
function openMailboxes(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(MAILBOXES_PATH, '_blank', 'noopener');
    return;
  }
  router.push(MAILBOXES_PATH);
}

function mailboxAddresses(status: EmailStatus): string[] {
  const out: string[] = [];
  if (status.connected) out.push('Gmail');
  for (const a of status.accounts ?? []) out.push(a.emailAddress);
  return out;
}

export default function ConnectScreen() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  const user = useApp((st) => st.user);
  const [view, setView] = useState<AiAppRequestView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // undefined = loading; null = unknown (mail off, or the check failed).
  const [mail, setMail] = useState<EmailStatus | null | undefined>(undefined);

  useEffect(() => {
    if (!request || !user) return;
    getAiAppRequest(request).then(setView, (e: Error) => setErr(e.message));
  }, [request, user]);

  // Re-read the mailboxes whenever the person comes back from connecting one.
  const refreshMail = useCallback(() => {
    if (!user) return;
    getEmailStatus().then(setMail, () => setMail((m) => (m === undefined ? null : m)));
  }, [user]);
  useFocusEffect(refreshMail);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState === 'visible') refreshMail();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') refreshMail();
    });
    return () => sub.remove();
  }, [refreshMail]);

  if (!request) return <Redirect href="/" />;
  if (!user) {
    return <Redirect href={{ pathname: '/', params: { next: `/connect?request=${encodeURIComponent(request)}` } }} />;
  }

  const answer = async (allow: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await answerAiAppRequest(request, allow);
      setDone(true);
      leaveTo(out.redirectTo);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (err && !view) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.scroll}>
          <Text style={s.title}>Could not connect</Text>
          <Text style={s.p}>{err}</Text>
          <Text style={s.p}>Go back to the app you were connecting and try again.</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (!view || done) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom', 'left', 'right']}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>Connect {view.clientName} to Chord?</Text>

        <Text style={s.step}>1 · Your Chord account ✓</Text>
        <Text style={s.p}>Signed in as {user.displayName || user.username}.</Text>

        <Text style={s.step}>2 · Your mailboxes{mail && hasAnyMailbox(mail) ? ' ✓' : ''}</Text>
        {mail === undefined ? (
          <Text style={s.note}>Checking…</Text>
        ) : mail === null ? (
          <Text style={s.p}>
            Could not check your mailboxes.{' '}
            <Text style={s.link} onPress={openMailboxes} accessibilityRole="link">
              See them in Settings
            </Text>
          </Text>
        ) : hasAnyMailbox(mail) ? (
          <Text style={s.p}>
            Connected: {mailboxAddresses(mail).join(', ')}.{' '}
            <Text style={s.link} onPress={openMailboxes} accessibilityRole="link">
              Add another
            </Text>
          </Text>
        ) : (
          <>
            <Text style={s.p}>
              {view.clientName} reads your email through Chord, so connect Gmail, Outlook, Yahoo or iCloud mail first.
              You can also do it later; {view.clientName} will remind you.
            </Text>
            <Pressable style={s.ghost} onPress={openMailboxes} accessibilityRole="button">
              <Text style={s.ghostTxt}>Connect a mailbox</Text>
            </Pressable>
            {Platform.OS === 'web' ? (
              <Text style={s.note}>Opens in a new tab. Come back to this tab when you are done.</Text>
            ) : null}
          </>
        )}

        <Text style={s.step}>3 · Allow {view.clientName}</Text>
        <Text style={s.p}>{view.clientName} is asking to use your Chord account. It will be able to:</Text>
        {view.scopes.map((scope) => (
          <Text key={scope} style={s.bullet}>
            • {AI_APP_SCOPE_TEXT[scope]}
          </Text>
        ))}
        <Text style={s.p}>
          What it reads is sent to {view.clientName} and handled under its own terms, not Chord&rsquo;s. You can
          disconnect it any time in Settings → Connected AI apps, or by telling Chord &ldquo;disconnect{' '}
          {view.clientName}&rdquo;.{' '}
          <Link href="/privacy" style={s.link}>
            Privacy policy
          </Link>
        </Text>
        <Text style={s.note}>After you answer, you go back to {view.redirectHost}.</Text>

        {err ? <Text style={s.err}>{err}</Text> : null}

        <Pressable
          style={[s.btn, busy && s.off]}
          disabled={busy}
          onPress={() => void answer(true)}
          accessibilityRole="button"
        >
          <Text style={s.btnTxt}>Allow</Text>
        </Pressable>
        <Pressable
          style={[s.ghost, busy && s.off]}
          disabled={busy}
          onPress={() => void answer(false)}
          accessibilityRole="button"
        >
          <Text style={s.ghostTxt}>Deny</Text>
        </Pressable>

        <Text style={s.step}>Then try asking {view.clientName}</Text>
        {AI_APP_TRY_ASKING.filter((t) => view.scopes.includes(t.scope)).map((t) => (
          <Text key={t.ask} style={s.bullet}>
            • &ldquo;{t.ask}&rdquo;
          </Text>
        ))}
        <Text style={s.note}>
          Anything {view.clientName} suggests waits in Chord → To Do&rsquo;s → Action Items until you confirm it.
        </Text>
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
  step: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 22 },
  bullet: { color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 6, paddingLeft: 4 },
  link: { color: colors.text, textDecorationLine: 'underline' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 14 },
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
