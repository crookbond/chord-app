/**
 * The undo bar (ADR 0115).
 *
 * The countdown is cosmetic: the deadline lives on the server, and this only
 * renders it. That matters because the alternative — a client timer that fires
 * the send — is the design this ADR rejected, and a bar that looks like it is
 * driving would invite someone to make it drive later.
 *
 * The bar dismisses itself when the window closes, because an Undo button for
 * a message already gone is a button that lies.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { themed } from '@/theme';

export function UndoSendBar({
  sendAfter,
  onUndo,
  onExpired,
}: {
  /** ISO time the server will actually send. */
  sendAfter: string;
  onUndo: () => void;
  onExpired: () => void;
}) {
  const [left, setLeft] = useState(() =>
    Math.max(0, Math.ceil((new Date(sendAfter).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const t = setInterval(() => {
      const secs = Math.max(0, Math.ceil((new Date(sendAfter).getTime() - Date.now()) / 1000));
      setLeft(secs);
      if (secs <= 0) {
        clearInterval(t);
        onExpired();
      }
    }, 250);
    return () => clearInterval(t);
  }, [sendAfter, onExpired]);

  return (
    <View style={styles.bar}>
      <Text style={styles.txt}>Sending{left > 0 ? ` in ${left}s` : '…'}</Text>
      <Pressable onPress={onUndo} hitSlop={8}>
        <Text style={styles.undo}>Undo</Text>
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  txt: { color: colors.text, fontSize: 14 },
  undo: { color: colors.accent, fontSize: 14, fontWeight: '700' },
}));
