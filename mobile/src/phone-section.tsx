/**
 * Phone-number verification card (ADR 0064) for Settings.
 *
 * Three states: no number (entry → send code), code entry (verify / resend /
 * change), verified (number + badge + find-friends entry). Server errors are
 * typed reasons (`invalid_code`, `taken`, …) surfaced as plain-language copy -
 * the I1 onboarding rule: never show a raw error string to a relative.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { useRouter } from 'expo-router';

import type { PhoneStatus } from '@chord/kernel';
import { getPhoneStatus, releasePhone, startPhoneVerification, verifyPhone } from '@/api';
import { deviceRegion, normalizeDeviceNumber } from '@/contact-hash';
import { colors, themed } from '@/theme';

const RESEND_SECONDS = 30;

const ERROR_COPY: Record<string, string> = {
  invalid_phone:
    "That doesn't look like a full number - include your country code, like +1 555 123 4567.",
  taken: 'That number is already verified on another Chord account.',
  invalid_code: "That code didn't match. Try again.",
  expired: 'That code expired. Tap Resend for a fresh one.',
  too_many_attempts: 'Too many tries. Wait a few minutes, then resend a fresh code.',
  not_found: 'No active code for this number - tap Resend.',
  unavailable: "Phone verification isn't available right now. Try again later.",
};

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return ERROR_COPY[msg] ?? "Something went wrong. Check your connection and try again.";
}

export function PhoneSection({ whatsappNumber }: { whatsappNumber?: string | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState<'view' | 'edit' | 'code'>('view');
  const [phoneInput, setPhoneInput] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'verify' | 'remove'>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPhoneStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startResendTimer = useCallback(() => {
    setResendIn(RESEND_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1 && timerRef.current) clearInterval(timerRef.current);
        return Math.max(0, s - 1);
      });
    }, 1000);
  }, []);

  const sendCode = useCallback(async () => {
    setErr(null);
    // Pre-normalize with the device region so a national-format entry
    // ("555 123 4567") works; fall back to the raw input and let the server
    // be the final judge.
    const normalized = normalizeDeviceNumber(phoneInput, deviceRegion()) ?? phoneInput.trim();
    setBusy('send');
    try {
      const res = await startPhoneVerification({ phone: normalized });
      setSentTo(res.phone);
      setCodeInput('');
      setStage('code');
      startResendTimer();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(null);
    }
  }, [phoneInput, startResendTimer]);

  const submitCode = useCallback(async () => {
    setErr(null);
    setBusy('verify');
    try {
      const s = await verifyPhone({ phone: sentTo, code: codeInput.trim() });
      setStatus(s);
      setStage('view');
      setPhoneInput('');
      setCodeInput('');
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(null);
    }
  }, [sentTo, codeInput]);

  const removeNumber = useCallback(async () => {
    setErr(null);
    setBusy('remove');
    try {
      const st = await releasePhone();
      setStatus(st);
      setConfirmRemove(false);
      setStage('view');
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(null);
    }
  }, []);

  if (!loaded) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (stage === 'code') {
    return (
      <View>
        <Text style={s.muted}>Enter the code we texted to {sentTo}.</Text>
        <TextInput
          style={s.input}
          value={codeInput}
          onChangeText={setCodeInput}
          placeholder="123456"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
          maxLength={10}
          autoFocus
        />
        {err && <Text style={s.err}>{err}</Text>}
        <Pressable
          style={[s.btn, (busy !== null || codeInput.trim().length < 4) && s.btnDisabled]}
          disabled={busy !== null || codeInput.trim().length < 4}
          onPress={() => void submitCode()}
        >
          {busy === 'verify' ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={s.btnText}>Verify</Text>
          )}
        </Pressable>
        <View style={s.row}>
          <Pressable disabled={resendIn > 0 || busy !== null} onPress={() => void sendCode()}>
            <Text style={[s.link, (resendIn > 0 || busy !== null) && s.linkDisabled]}>
              {resendIn > 0 ? `Resend in 0:${String(resendIn).padStart(2, '0')}` : 'Resend code'}
            </Text>
          </Pressable>
          <Pressable
            disabled={busy !== null}
            onPress={() => {
              setStage('edit');
              setErr(null);
            }}
          >
            <Text style={s.link}>Change number</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (stage === 'edit' || !status?.verified) {
    return (
      <View>
        <Text style={s.muted}>
          Verify your number so friends who have you in their contacts can find you on Chord.
          {whatsappNumber ? ' It also lets you chat with Chord on WhatsApp.' : ''}
        </Text>
        <TextInput
          style={s.input}
          value={phoneInput}
          onChangeText={setPhoneInput}
          placeholder="+1 555 123 4567"
          placeholderTextColor={colors.muted}
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        {err && <Text style={s.err}>{err}</Text>}
        <Pressable
          style={[s.btn, (busy !== null || phoneInput.trim().length < 3) && s.btnDisabled]}
          disabled={busy !== null || phoneInput.trim().length < 3}
          onPress={() => void sendCode()}
        >
          {busy === 'send' ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={s.btnText}>Send code</Text>
          )}
        </Pressable>
        {stage === 'edit' && status?.verified && (
          <Pressable
            onPress={() => {
              setStage('view');
              setErr(null);
            }}
          >
            <Text style={s.link}>Keep {status.phone}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View>
      <View style={s.verifiedRow}>
        <Text style={s.number}>{status.phone}</Text>
        <View style={s.badge}>
          <Text style={s.badgeTxt}>✓ Verified</Text>
        </View>
      </View>
      <Pressable style={s.btnGhost} onPress={() => router.push('/find-friends')}>
        <Text style={s.btnGhostTxt}>Find friends on Chord</Text>
      </Pressable>
      {err && <Text style={s.err}>{err}</Text>}
      <View style={s.row}>
        <Pressable
          disabled={busy !== null}
          onPress={() => {
            setStage('edit');
            setPhoneInput('');
            setErr(null);
          }}
        >
          <Text style={s.link}>Change number</Text>
        </Pressable>
        <Pressable disabled={busy !== null} onPress={() => setConfirmRemove(true)}>
          <Text style={s.linkDanger}>Remove</Text>
        </Pressable>
      </View>
      {confirmRemove && (
        <View style={s.confirm}>
          <Text style={s.muted}>
            Remove {status.phone}? Friends with this number in their contacts will stop
            finding you, and its WhatsApp chat will unlink. You can verify it again later.
          </Text>
          <View style={s.row}>
            <Pressable disabled={busy !== null} onPress={() => void removeNumber()}>
              {busy === 'remove' ? (
                <ActivityIndicator color={colors.red} />
              ) : (
                <Text style={s.linkDanger}>Yes, remove</Text>
              )}
            </Pressable>
            <Pressable disabled={busy !== null} onPress={() => setConfirmRemove(false)}>
              <Text style={s.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const s = themed((colors) => ({
  center: { paddingVertical: 12, alignItems: 'flex-start' },
  muted: { color: colors.muted, fontSize: 13, marginTop: 4 },
  err: { color: colors.red, fontSize: 13, marginTop: 8 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
    marginTop: 10,
  },
  btn: {
    backgroundColor: colors.accent,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: colors.onAccent, fontWeight: '600' },
  btnGhost: {
    borderColor: colors.accent,
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  btnGhostTxt: { color: colors.accent, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', marginTop: 10 },
  linkDisabled: { color: colors.muted },
  linkDanger: { color: colors.red, fontSize: 14, fontWeight: '600', marginTop: 10 },
  confirm: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  verifiedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  number: { color: colors.text, fontSize: 18, fontWeight: '600' },
  badge: {
    backgroundColor: colors.greenBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeTxt: { color: colors.green, fontSize: 12, fontWeight: '600' },
}));
