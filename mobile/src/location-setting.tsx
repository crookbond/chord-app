/**
 * ADR 0258 - the always-available switch for using the phone's location, in
 * Settings under Daily briefing. The ask on Action Items is a one-time nudge;
 * this is where it is turned on later, and off.
 */
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import {
  disableDeviceLocation,
  enableDeviceLocation,
  locationEnabled,
  locationPermission,
  locationSupported,
  type LocationPermission,
} from '@/device-location';
import { themed } from '@/theme';

export function LocationSetting({ onChanged }: { onChanged: () => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [perm, setPerm] = useState<LocationPermission>('undetermined');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSupported(await locationSupported());
    setPerm(await locationPermission());
    setOn(await locationEnabled());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!supported) return null; // an older build, or a browser without location: nothing to offer

  const active = on && perm === 'granted';
  const toggle = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (active) {
        await disableDeviceLocation();
      } else {
        const result = await enableDeviceLocation();
        if (result === 'denied') {
          setNote("Location is off for Chord in your phone's settings.");
        }
      }
    } finally {
      await load();
      setBusy(false);
      onChanged();
    }
  };

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={s.title}>Use my location</Text>
          <Text style={s.muted}>
            {active
              ? "Your forecast follows your phone's approximate location - a city, never a precise position."
              : 'Off. Chord estimates a city from your network and time zone instead.'}
          </Text>
        </View>
        <Pressable
          onPress={() => void toggle()}
          disabled={busy}
          style={[s.track, active && s.trackOn, busy && s.off]}
        >
          <View style={[s.thumb, active && s.thumbOn]} />
        </Pressable>
      </View>
      {note ? (
        <Pressable onPress={() => void Linking.openSettings()}>
          <Text style={s.note}>{note} Open settings</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = themed((colors) => ({
  wrap: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 12, marginTop: 2 },
  note: { color: colors.warn, fontSize: 12, marginTop: 6, textDecorationLine: 'underline' },
  track: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.border,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  trackOn: { backgroundColor: colors.accent },
  thumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  thumbOn: { alignSelf: 'flex-end' },
  off: { opacity: 0.5 },
}));
