// ADR 0318 - invite someone to chat by typing their email. Used on the
// Messages screen (a direct chat) and in a group's settings (that group).
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { inviteOutcomeText, type InviteByEmailResponse } from '@chord/kernel';

import { inviteByEmail } from '@/api';
import { TextInput } from '@/text-input';
import { colors, themed } from '@/theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteByEmail({
  groupId,
  openChat,
  autoFocus,
  onSent,
}: {
  /** Called after any invite, so the caller can reload its chat list. */
  onSent?: () => void;
  /** Omit for a direct chat. */
  groupId?: string;
  /** Open the chat once someone is in it (the Messages screen does). */
  openChat?: boolean;
  autoFocus?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ res: InviteByEmailResponse; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const valid = EMAIL_RE.test(email.trim());

  const send = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    setCopied(false);
    const to = email.trim();
    try {
      const res = await inviteByEmail({ email: to, groupId, message: message.trim() || undefined });
      setDone({ res, email: to });
      setEmail('');
      setMessage('');
      onSent?.();
      // Stay put when the email did not go, so the link to share is on screen.
      const reached = res.status === 'added' || (res.status === 'emailed' && res.email === 'queued');
      if (openChat && res.groupId && reached) router.push(`/groups/${res.groupId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [email, groupId, message, onSent, openChat]);

  const link = done?.res.status === 'emailed' && done.res.email !== 'queued' ? done.res.link : null;

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.input}
        placeholder="Their email address"
        value={email}
        onChangeText={setEmail}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoFocus={autoFocus}
      />
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder={groupId ? 'Add a note (optional)' : 'Say something (optional)'}
          value={message}
          onChangeText={setMessage}
          placeholderTextColor={colors.muted}
          multiline
        />
        <Pressable style={[styles.submit, (!valid || busy) && { opacity: 0.5 }]} disabled={!valid || busy} onPress={send}>
          {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitText}>Send</Text>}
        </Pressable>
      </View>
      {err && <Text style={styles.err}>{err}</Text>}
      {done && <Text style={styles.note}>{inviteOutcomeText(done.res, done.email)}</Text>}
      {link && (
        <Pressable
          style={styles.copyBtn}
          onPress={() => void Clipboard.setStringAsync(link).then(() => setCopied(true))}
        >
          <Text style={styles.copyTxt}>{copied ? 'Link copied' : 'Copy invite link'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = themed((colors) => ({
  wrap: { gap: 8, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    backgroundColor: colors.card,
    color: colors.text,
  },
  submit: {
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: colors.onAccent, fontWeight: '600' },
  err: { color: colors.red },
  note: { color: colors.muted, fontSize: 13 },
  copyBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copyTxt: { color: colors.accent, fontWeight: '600', fontSize: 13 },
}));
