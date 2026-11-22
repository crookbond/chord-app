/**
 * ADR 0260 addendum (2026-11-13) - a signature in the box that is not the
 * saved one. The send uses the rich signature only for an exact match, so an
 * older copy (a draft saved before the signature changed, or a box opened
 * before the new one arrived) went out as typed text with nothing said.
 *
 * `useSignatureFollow` swaps an untouched copy when the saved signature
 * changes while the box is open; `OutdatedSignatureNote` says so when the box
 * holds some other signature block, with one tap to use the saved one.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { hasOutdatedSignature, replaceOutdatedSignature, swapSignature } from '@chord/kernel';

import { themed } from '@/theme';

/** Keep the box's signature in step with the saved one while it is unchanged. */
export function useSignatureFollow(
  signature: string | null | undefined,
  setBody: (update: (cur: string) => string) => void,
): void {
  const shown = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (signature === undefined) return;
    const before = shown.current;
    shown.current = signature;
    if (before !== undefined && before !== signature) setBody((cur) => swapSignature(cur, before, signature));
  }, [signature, setBody]);
}

export function OutdatedSignatureNote({
  body,
  signature,
  onChange,
}: {
  body: string;
  signature: string | null | undefined;
  onChange: (next: string) => void;
}) {
  const [kept, setKept] = useState(false);
  useEffect(() => setKept(false), [signature]);
  if (kept || !hasOutdatedSignature(body, signature)) return null;
  return (
    <View style={styles.note}>
      <Text style={styles.text}>
        The signature below is not your saved one, so it will go as plain text without its formatting.
      </Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onChange(replaceOutdatedSignature(body, signature))}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Use saved signature</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setKept(true)} style={styles.button}>
          <Text style={styles.keepText}>Keep this one</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  note: { backgroundColor: colors.warnBg, borderRadius: 8, padding: 10, marginHorizontal: 12, marginBottom: 8, gap: 6 },
  text: { color: colors.text, fontSize: 13 },
  row: { flexDirection: 'row' as const, gap: 16 },
  button: { paddingVertical: 4 },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '600' as const },
  keepText: { color: colors.muted, fontSize: 13 },
}));
