/**
 * ADR 0258 - the one time Chord asks for the phone's approximate location.
 * Shown on Action Items, where a launch lands. Explains why before the system
 * prompt appears, and never again once answered either way.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  enableDeviceLocation,
  locationAsked,
  locationPermission,
  locationSupported,
} from '@/device-location';
import { themed } from '@/theme';

export function LocationAsk() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (await locationAsked()) return;
      if (!(await locationSupported())) return;
      // Someone who already allowed it (another install, an earlier build) is not asked again.
      if ((await locationPermission()) === 'granted') return;
      if (!cancelled) setShow(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  // App Store 5.1.1(iv): the explanation always goes on to the system prompt;
  // declining happens there, never on this card.
  const proceed = async () => {
    setBusy(true);
    try {
      await enableDeviceLocation();
    } finally {
      setBusy(false);
      setShow(false);
    }
  };

  return (
    <View style={s.card}>
      <Text style={s.title}>Weather where you are</Text>
      <Text style={s.body}>
        Let Chord use your phone&apos;s approximate location for the forecast in your morning briefing. It
        only ever keeps a city, never a precise position, and you can turn it off in Settings.
      </Text>
      <View style={s.row}>
        <Pressable style={[s.btn, busy && s.off]} disabled={busy} onPress={() => void proceed()}>
          <Text style={s.btnTxt}>Continue</Text>
        </Pressable>
      </View>
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
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 13, marginTop: 4, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  btnTxt: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  off: { opacity: 0.5 },
}));
