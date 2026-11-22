/**
 * ADR 0252 - the user's own AI key is out of credit or was rejected, so Chord's
 * AI passes over their mail are paused. Shown above the to-dos on the Email tab,
 * where the missing suggestions would otherwise just look like a quiet inbox.
 * The same fact is in a chat nudge (once) and on Settings → AI model (always).
 */
import { router } from 'expo-router';
import { Linking, Pressable, Text, View } from 'react-native';
import type { ByokKeyIssue } from '@chord/kernel';

import { themed } from '@/theme';

export function AiKeyBanner({ issue }: { issue: ByokKeyIssue | null | undefined }) {
  if (!issue) return null;
  return (
    <View style={s.card}>
      <Text style={s.title}>
        {issue.kind === 'credit' ? 'Your AI key is out of credit' : 'Your AI key was rejected'}
      </Text>
      <Text style={s.body}>{issue.message.replace(/^⚠️\s*/, '')}</Text>
      <View style={s.row}>
        {issue.topUpUrl ? (
          <Pressable style={s.btn} onPress={() => void Linking.openURL(issue.topUpUrl!)}>
            <Text style={s.btnTxt}>Add credits to your key</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={issue.topUpUrl ? s.ghost : s.btn}
          onPress={() => router.push({ pathname: '/settings', params: { open: 'model' } })}
        >
          <Text style={issue.topUpUrl ? s.ghostTxt : s.btnTxt}>Update key</Text>
        </Pressable>
      </View>
      {issue.fallback ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/settings', params: { open: issue.fallback === 'plan' ? 'plan' : 'model' } })
          }
        >
          <Text style={s.link}>
            {issue.fallback === 'plan' ? 'Use a Chord plan instead' : "Use Chord's AI instead"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = themed((colors) => ({
  card: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.warnBg,
  },
  title: { color: colors.warn, fontSize: 14, fontWeight: '700' },
  body: { color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnTxt: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  ghost: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  ghostTxt: { color: colors.text, fontSize: 13, fontWeight: '600' },
  link: { color: colors.text, fontSize: 13, textDecorationLine: 'underline', marginTop: 10 },
}));
