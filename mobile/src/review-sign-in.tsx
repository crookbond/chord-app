/**
 * ADR 0345 - "App review sign-in": the email + password store reviewers use,
 * because Google and Microsoft ask them to verify on a phone they don't have.
 * Shown only while the server has it switched on.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { SessionResponse } from '@chord/kernel';

import { authReview } from '@/api';
import { TextInput } from '@/text-input';
import { colors, themed } from '@/theme';

export function ReviewSignIn({
  disabled,
  onSignedIn,
}: {
  disabled: boolean;
  onSignedIn: (user: SessionResponse['user']) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={styles.openLink}>
        <Text style={styles.openLinkText}>App review sign-in</Text>
      </Pressable>
    );
  }

  const submit = async () => {
    if (busy || disabled || !email.trim() || !password) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await authReview({ email: email.trim(), password });
      onSignedIn(res.user);
    } catch {
      setErr('Wrong email or password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>App review sign-in</Text>
      <Text style={styles.hint}>For app store reviewers. Use the email and password from the review notes.</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="username"
        accessibilityLabel="Review email"
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={colors.muted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="password"
        autoComplete="password"
        onSubmitEditing={() => void submit()}
        accessibilityLabel="Review password"
      />
      {err && <Text style={styles.err}>{err}</Text>}
      <Pressable
        style={[styles.btn, (busy || disabled) && styles.btnDisabled]}
        disabled={busy || disabled}
        onPress={() => void submit()}
        accessibilityRole="button"
        accessibilityLabel="Sign in for app review"
      >
        {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.btnText}>Sign in</Text>}
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  openLink: { marginTop: 14, alignSelf: 'center' as const, paddingVertical: 6 },
  openLinkText: { color: colors.muted, fontSize: 12, textDecorationLine: 'underline' as const },
  box: { marginTop: 16, gap: 8 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' as const },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.card,
    fontSize: 15,
  },
  err: { color: colors.red, fontSize: 13 },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center' as const,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' as const },
}));
