/**
 * The Findings tab's own chat about the user's mail (ADR 0277). A sample
 * question is answered here instead of being posted to the personal chat.
 * The conversation lives only in this component: each turn sends it whole,
 * the server keeps nothing, and leaving the tab ends it.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { TextInput } from '@/text-input';
import { router } from 'expo-router';

import type { FindingsChatResult } from '@chord/kernel';

import { findingsChat, postMessage } from '@/api';
import { openExternal } from '@/link-chip';
import { colors, themed } from '@/theme';

/**
 * A change drafted here waits for the user's tap. Findings reads mail, and an
 * email can carry an instruction the model copies into the hand-off, so the
 * message is shown word for word and only posted (as the user, acted on at
 * once) when they choose Send to chat.
 */
type Handoff = { message: string; state: 'pending' | 'sending' | 'cancelled' };

type Turn = {
  role: 'user' | 'assistant';
  text: string;
  cards?: FindingsChatResult['cards'];
  handoff?: Handoff;
};

/** What the server accepts: at most 40 messages of at most 4000 characters. */
const MAX_TURNS = 40;
const MAX_CHARS = 4000;

export function FindingsChat({
  questions,
  personalGroupId,
}: {
  questions: string[];
  personalGroupId: string | null;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "New chat" so an answer still in flight lands nowhere.
  const session = useRef(0);

  const ask = async (question: string) => {
    const text = question.trim().slice(0, MAX_CHARS);
    if (!text || busy) return;
    const mine = session.current;
    const next: Turn[] = [...turns, { role: 'user', text }];
    setTurns(next);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const out = await findingsChat({
        messages: next.slice(-MAX_TURNS).map((t) => ({ role: t.role, text: t.text.slice(0, MAX_CHARS) })),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (session.current !== mine) return;
      setTurns([
        ...next,
        {
          role: 'assistant',
          text: out.reply,
          cards: out.cards,
          ...(out.handoff ? { handoff: { message: out.handoff.message, state: 'pending' as const } } : {}),
        },
      ]);
    } catch (err) {
      if (session.current !== mine) return;
      // The question stays on screen so it can be sent again.
      setTurns(turns);
      setDraft(text);
      setError(err instanceof Error && err.message ? err.message : 'Could not answer that. Try again.');
    } finally {
      if (session.current === mine) setBusy(false);
    }
  };

  const reset = () => {
    session.current += 1;
    setTurns([]);
    setDraft('');
    setBusy(false);
    setError(null);
  };

  const setHandoff = (index: number, state: Handoff['state']) =>
    setTurns((all) =>
      all.map((t, i) => (i === index && t.handoff ? { ...t, handoff: { ...t.handoff, state } } : t)),
    );

  // Posted only on the user's tap: as their own message, which the bot in the
  // personal chat acts on at once.
  const sendHandoff = async (index: number) => {
    const h = turns[index]?.handoff;
    if (!h || h.state !== 'pending') return;
    if (!personalGroupId) {
      setError('Could not open your chat. Ask there instead.');
      return;
    }
    const mine = session.current;
    setHandoff(index, 'sending');
    setError(null);
    try {
      await postMessage(personalGroupId, {
        body: h.message,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (session.current !== mine) return;
      router.push(`/groups/${personalGroupId}`);
    } catch (err) {
      if (session.current !== mine) return;
      setHandoff(index, 'pending');
      setError(err instanceof Error && err.message ? err.message : 'Could not send that. Try again.');
    }
  };

  const openCard = (c: FindingsChatResult['cards'][number]) => {
    if (c.href) router.push(c.href as never);
    else if (c.url) openExternal(c.url);
  };

  return (
    <View>
      <Text style={s.note}>
        Tap one or type your own. Answers stay here; a change is shown to you first and sent to your chat only if you tap Send.
      </Text>
      <View style={s.chips}>
        {questions.map((q) => (
          <Pressable
            key={q}
            style={[s.chip, busy && s.chipBusy]}
            disabled={busy}
            onPress={() => void ask(q)}
          >
            <Text style={s.chipTxt}>{q}</Text>
          </Pressable>
        ))}
      </View>

      {turns.length > 0 && (
        <View style={s.convo}>
          {turns.map((t, i) => (
            <View key={i} style={[s.bubble, t.role === 'user' ? s.mine : s.theirs]}>
              <Text style={s.bubbleTxt} selectable>
                {t.text}
              </Text>
              {t.cards?.map((c, j) => (
                <Pressable key={j} style={s.card} onPress={() => openCard(c)}>
                  <Text style={s.cardTitle} numberOfLines={1}>
                    {c.title}
                  </Text>
                  {c.subtitle || c.meta ? (
                    <Text style={s.cardSub} numberOfLines={1}>
                      {[c.subtitle, c.meta].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              {t.handoff && (
                <View style={s.handoff}>
                  <Text style={s.cardSub}>
                    {t.handoff.state === 'cancelled' ? 'Not sent' : 'Send this to your chat as you?'}
                  </Text>
                  <Text style={s.handoffTxt} selectable>
                    {t.handoff.message}
                  </Text>
                  {t.handoff.state !== 'cancelled' && (
                    <View style={s.handoffRow}>
                      <Pressable
                        style={[s.handoffSend, t.handoff.state === 'sending' && s.chipBusy]}
                        disabled={t.handoff.state === 'sending'}
                        onPress={() => void sendHandoff(i)}
                      >
                        <Text style={s.sendTxt}>{t.handoff.state === 'sending' ? 'Sending…' : 'Send to chat'}</Text>
                      </Pressable>
                      <Pressable
                        style={s.handoffCancel}
                        disabled={t.handoff.state === 'sending'}
                        onPress={() => setHandoff(i, 'cancelled')}
                      >
                        <Text style={s.cardTitle}>Cancel</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )}
            </View>
          ))}
          {busy && (
            <View style={[s.bubble, s.theirs, s.thinking]}>
              <ActivityIndicator size="small" />
              <Text style={s.cardSub}>Looking through your mail…</Text>
            </View>
          )}
        </View>
      )}

      {error ? <Text style={s.error}>{error}</Text> : null}

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={turns.length ? 'Ask a follow-up…' : 'Ask about your mail…'}
          placeholderTextColor={colors.muted}
          editable={!busy}
          returnKeyType="send"
          onSubmitEditing={() => void ask(draft)}
          maxLength={MAX_CHARS}
        />
        <Pressable
          style={[s.send, (!draft.trim() || busy) && s.chipBusy]}
          disabled={!draft.trim() || busy}
          onPress={() => void ask(draft)}
        >
          <Text style={s.sendTxt}>Ask</Text>
        </Pressable>
      </View>
      {turns.length > 0 && !busy && (
        <Pressable onPress={reset} style={s.reset}>
          <Text style={s.resetTxt}>New chat</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = themed((colors) => ({
  note: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 8, paddingBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.card,
  },
  chipBusy: { opacity: 0.5 },
  chipTxt: { fontSize: 13, color: colors.text },
  convo: { gap: 8, paddingHorizontal: 8, paddingBottom: 8 },
  bubble: { maxWidth: '88%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.rightBubble },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.chordBubble },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bubbleTxt: { fontSize: 14, lineHeight: 20, color: colors.text },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.card,
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  cardSub: { fontSize: 12, color: colors.muted },
  handoff: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    gap: 6,
    backgroundColor: colors.card,
  },
  handoffTxt: { fontSize: 14, lineHeight: 20, color: colors.text },
  handoffRow: { flexDirection: 'row', gap: 8 },
  handoffSend: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.accent,
  },
  handoffCancel: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  error: { color: colors.red, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 },
  inputRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingBottom: 6 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.card,
  },
  send: {
    borderRadius: 18,
    paddingHorizontal: 16,
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendTxt: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  reset: { alignSelf: 'flex-end', paddingHorizontal: 12, paddingBottom: 8 },
  resetTxt: { fontSize: 12, color: colors.muted },
}));
