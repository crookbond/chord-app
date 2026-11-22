/**
 * Compose a new message (ADR 0107). Chord answers mail, so this is the one
 * outbound surface that does not start from a thread.
 *
 * Laid out like the reply composer (ADR 0222): Cancel and Send in the header,
 * ruled field lines, a body that takes the rest of the screen, the ask bar
 * under it.
 *
 * From is one line that opens a list. It holds every address the message can
 * leave from - each connected mailbox and each verified send-as address - so
 * "which of my addresses" is one choice, not two rows of chips. With a single
 * address there is nothing to choose and the line is plain text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  BackHandler,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { useSignatureCaret } from '@/signature-caret';
import {
  bodyWithSignature,
  composeFromAccount,
  defaultComposeFormat,
  hasMarkdown,
  isOnlySignature,
  markdownToHtml,
  splitSignature,
  swapSignature,
  type EmailDraft,
  type EmailSendAsAddress,
  runExclusive,
  reviseReplyAsks,
} from '@chord/kernel';

import {
  cancelEmailSend,
  composeEmailNew,
  getEmailStatus,
  listEmailSendAs,
  queueEmailSend,
  sendEmail,
} from '@/api';
import { showAlert } from '@/alert';
import { EmailAttachments, FileDropOverlay, useEmailAttachments } from '@/email-attach';
import { EmailBody } from '@/email-body';
import {
  AskBar,
  AskWriting,
  DraftExitSheet,
  FieldRow,
  composeStyles as cs,
  type AskChip,
} from '@/email-compose-ui';
import { RecipientField } from '@/email-recipient-field';
import { useDraftAutosave } from '@/email-draft';
import { PHONE_DRAFT_NOTICE, outboxNotice, queueEmail, useEmailWaiting } from '@/email-outbox';
import { newSendId } from '@/send-queue';
import { useEmailSignature, useEmailSignatureHtml } from '@/email-signature';
import { ComposeBodyEditor, FormatSwitch, useComposeBody } from '@/compose-body';
import { OfflineError } from '@/network';
import { ActionSheet, Icon, type SheetRow } from '@/email-reader-bar';
import { UndoSendBar } from '@/email-undo';
import { OutdatedSignatureNote } from '@/outdated-signature';
import { colors } from '@/theme';
import { goBackOr } from '@/back-home';
import { ComposeFrame } from '@/compose-sheet';

/** Split on commas and semicolons; mirrors the reply composer's parsing. */
function parseRecipients(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Only whole addresses go into a draft: one half-typed name would otherwise
 *  have the server refuse the save, and the body with it. */
function wholeAddresses(s: string): string[] {
  return parseRecipients(s).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

/** One address the message can leave from. */
interface FromOption {
  key: string;
  /** null = the primary Gmail (ADR 0080). */
  accountId: string | null;
  /** A send-as address of the primary Gmail (ADR 0130); null = its own. */
  alias: string | null;
  address: string;
  hint?: string;
}

// A new message answers nothing, so no point-by-point; times stay offered (ADR 0337).
const REVISE_ASKS: AskChip[] = reviseReplyAsks({ points: 0, aboutTime: true });

export default function ComposeScreen() {
  // `?draft=<id>` resumes one from the Drafts list; absent means a blank sheet.
  // `?to=&subject=` prefill a new one (ADR 0306: writing to an event's guests).
  // `?local=<key>` reopens a draft that only exists on this phone (ADR 0311).
  const {
    draft: resumeId,
    to: prefillTo,
    subject: prefillSubject,
    local: phoneKey,
    mailbox: selectedMailbox,
  } = useLocalSearchParams<{
    draft?: string;
    to?: string;
    subject?: string;
    local?: string;
    /** The mailbox chip selected in the Email list ('primary' or an account id). */
    mailbox?: string;
  }>();

  const [options, setOptions] = useState<FromOption[]>([]);
  const [fromKey, setFromKey] = useState<string | null>(null);
  /** The mailbox a resumed draft was written from, applied once options load. */
  const [resumeAccount, setResumeAccount] = useState<string | null | undefined>(undefined);
  const [fromOpen, setFromOpen] = useState(false);
  const [to, setTo] = useState(() => (!resumeId && prefillTo ? prefillTo : ''));
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [subject, setSubject] = useState(() => (!resumeId && prefillSubject ? prefillSubject : ''));
  const [body, setBody] = useState('');
  const from = options.find((o) => o.key === fromKey) ?? options[0] ?? null;
  const fromId = from?.accountId ?? null;
  const alias = from?.alias ?? null;
  // The signature sits in the body, visible and deletable (ADR 0260 addendum),
  // and is the one of the mailbox the message leaves from.
  const signature = useEmailSignature(fromId);
  const signatureHtml = useEmailSignatureHtml(fromId);
  // ADR 0339: a new message opens Rich; a saved draft opens the way it was written.
  const bodyCompose = useComposeBody(body, setBody, signature, signatureHtml);
  const bodyLoad = bodyCompose.load;
  const bodyInit = bodyCompose.init;
  useEffect(() => {
    if (!resumeId && !phoneKey) bodyInit(defaultComposeFormat({ kind: 'new' }));
  }, [resumeId, phoneKey, bodyInit]);
  const shownSignature = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (signature === undefined) return;
    const before = shownSignature.current;
    shownSignature.current = signature;
    // The first one is put in by the open effect below; after that a From
    // change swaps an untouched signature for the new mailbox's.
    if (before !== undefined) setBody((cur) => swapSignature(cur, before, signature));
  }, [signature]);
  const bodyWritten = !isOnlySignature(body, signature);
  const bodyCaret = useSignatureCaret(body, signature);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const attach = useEmailAttachments();
  const emailWaiting = useEmailWaiting();
  const [sent, setSent] = useState(false);
  const [queued, setQueued] = useState<{ draftId: string; sendAfter: string } | null>(null);
  const [undoSeconds, setUndoSeconds] = useState(0);
  const [preview, setPreview] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);

  // On by default; the header's sparkle icon still hides it.
  const [asking, setAsking] = useState(true);
  const [aiAsk, setAiAsk] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  const restoreAttachments = attach.restore;
  const onRestore = useCallback(
    (d: EmailDraft) => {
      setTo(d.to.join(', '));
      setCc(d.cc.join(', '));
      setBcc(d.bcc.join(', '));
      if (d.cc.length || d.bcc.length) setShowMore(true);
      setSubject(d.subject);
      setBody(d.body);
      bodyLoad(d.format ?? 'plain', d.body, d.bodyHtml);
      setResumeAccount(d.accountId);
      if (d.attachments?.length) restoreAttachments(d.attachments);
      if (d.lastError) setErr(`This did not send: ${d.lastError}`);
    },
    [restoreAttachments, bodyLoad],
  );

  // Autosave stops the moment the message goes, so it cannot re-create the
  // draft the send just cleared.
  const { saveNow, discard, handOff, isSavedOnPhoneOnly } = useDraftAutosave({
    kind: 'new',
    accountId: fromId,
    initialId: resumeId ?? null,
    phoneKey: phoneKey ?? null,
    enabled: !sent,
    content: {
      to: wholeAddresses(to),
      cc: wholeAddresses(cc),
      bcc: wholeAddresses(bcc),
      subject,
      body,
      attachmentIds: attach.ids,
      ...bodyCompose.wire,
    },
    onRestore,
    onRestoreError: () => setErr('That draft could not be opened.'),
    signature,
  });

  // A new message opens with the signature under the cursor. Not over a
  // resumed draft: what it saved, signature or not, is what the user wrote.
  useEffect(() => {
    if (resumeId || phoneKey || !signature) return;
    setBody((cur) => (cur.trim() ? cur : bodyWithSignature('', signature)));
  }, [resumeId, phoneKey, signature]);

  useEffect(() => {
    void (async () => {
      const rows: FromOption[] = [];
      let defaultAccount: string | null | undefined;
      try {
        const status = await getEmailStatus();
        defaultAccount = status.defaultSendAccountId;
        setUndoSeconds(status.undoSeconds ?? 0);
        if (status.connected) {
          // ADR 0130 - only verified addresses come back, so every one listed
          // here is one Gmail will really send from.
          const aliases: EmailSendAsAddress[] = await listEmailSendAs().catch(() => []);
          const nick = status.gmailNickname?.trim() || 'Gmail';
          if (aliases.length === 0) {
            // The Gmail's own address - never the sign-in email, which for a
            // Microsoft or Apple account is a different mailbox.
            const own = status.gmailAddress ?? null;
            rows.push({
              key: 'primary',
              accountId: null,
              alias: null,
              address: own ?? nick,
              hint: own ? nick : undefined,
            });
          }
          // The mailbox's own address first, then the ones it can send as.
          for (const a of [...aliases].sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary))) {
            rows.push({
              key: a.isPrimary ? 'primary' : `alias:${a.email}`,
              accountId: null,
              alias: a.isPrimary ? null : a.email,
              address: a.email,
              hint: a.isPrimary ? nick : `Send as · ${nick}`,
            });
          }
        }
        for (const a of status.accounts ?? []) {
          rows.push({
            key: `acct:${a.id}`,
            accountId: a.id,
            alias: null,
            address: a.emailAddress,
            hint: a.nickname?.trim() || undefined,
          });
        }
      } catch {
        // A failed status read must not block composing from the default mailbox.
      }
      if (rows.length === 0) {
        rows.push({ key: 'primary', accountId: null, alias: null, address: 'Gmail' });
      }
      setOptions(rows);
      // The mailbox being looked at in the list wins over the one chosen in
      // chat (ADR 0255, 0341). A resumed draft's own mailbox (below) runs
      // after and wins over both.
      const openOn = composeFromAccount(selectedMailbox, defaultAccount);
      if (openOn !== undefined) {
        const match = rows.find((o) => o.accountId === openOn && o.alias === null);
        if (match) setFromKey(match.key);
      }
    })();
  }, [selectedMailbox]);

  // A resumed draft leaves from the mailbox it was written in.
  useEffect(() => {
    if (resumeAccount === undefined || options.length === 0) return;
    const match = options.find((o) => o.accountId === resumeAccount && o.alias === null);
    if (match) setFromKey(match.key);
    setResumeAccount(undefined);
  }, [resumeAccount, options]);

  const written =
    !!to.trim() || !!cc.trim() || !!bcc.trim() || !!subject.trim() || bodyWritten || attach.ids.length > 0;

  const ask = useCallback(
    async (instruction: string) => {
      if (!instruction.trim() || aiBusy) return;
      setAiBusy(true);
      setAiErr(null);
      try {
        // The model rewrites the message, never the signature under it.
        const { main } = splitSignature(body, signature);
        const out = await composeEmailNew({
          instruction: instruction.trim(),
          ...(main.trim() ? { draft: main } : {}),
          to: parseRecipients(to),
          ...(subject.trim() ? { subject } : {}),
        });
        setBody((cur) =>
          !cur.trim() || splitSignature(cur, signature).hadSignature
            ? bodyWithSignature(out.body, signature)
            : out.body,
        );
        setPreview(false);
        // Only into an empty line: a subject the user wrote is theirs.
        if (out.subject && !subject.trim()) setSubject(out.subject);
        setAiAsk('');
      } catch (e) {
        setAiErr((e as Error).message);
      } finally {
        setAiBusy(false);
      }
    },
    [aiBusy, body, to, subject, signature],
  );

  // A ref, not the busy state: a second tap in the same frame does not see
  // that state yet, and would send the message twice.
  const sendGate = useRef(false);
  const send = useCallback(
    () =>
      runExclusive(sendGate, async () => {
        const toList = parseRecipients(to);
        if (toList.length === 0) {
          setErr('Add at least one recipient.');
          return;
        }
        if (!bodyWritten) {
          setErr('The message is empty.');
          return;
        }
        setBusy(true);
        setErr(null);
        let savedId: string | null = null;
        // One id for this Send, used by the direct attempt and by the Outbox if it
        // falls back there, so the server sends it once (ADR 0311 addendum).
        const sendId = newSendId();
        try {
          // With an undo window the message is handed to the server's outbox
          // instead of sent, and this screen stays open holding the Undo bar. The
          // hold is the server's either way, so closing the app still sends.
          //
          // Not with a send-as address: the outbox sends from the draft's mailbox
          // and a draft does not carry one, so a queued message would leave from
          // the mailbox's own address while this screen showed another. It goes
          // now, from the address chosen, without the undo.
          //
          // Nor with an address the draft could not hold: sending directly lets
          // the server say which one is wrong instead of quietly leaving it off.
          const allWhole = [to, cc, bcc].every(
            (s) => parseRecipients(s).length === wholeAddresses(s).length,
          );
          const queueable = undoSeconds > 0 && !alias && allWhole;
          savedId = await saveNow();
          // An earlier email still waits in the Outbox: this one joins the line
          // behind it rather than overtaking it (ADR 0311 addendum).
          if (emailWaiting) throw new OfflineError();
          if (queueable && savedId) {
            const q = await queueEmailSend({ draftId: savedId });
            setSent(true);
            setQueued({ draftId: q.draftId, sendAfter: q.sendAfter });
            return;
          }
          const res = await sendEmail({
            to: toList,
            cc: parseRecipients(cc),
            bcc: parseRecipients(bcc),
            subject,
            body,
            ...bodyCompose.wire,
            ...(attach.ids.length ? { attachmentIds: attach.ids } : {}),
            ...(fromId ? { accountId: fromId } : {}),
            ...(alias ? { from: alias } : {}),
            ...(savedId ? { draftId: savedId } : {}),
          }, sendId);
          setSent(true);
          // Say which address it left from — with several mailboxes attached that
          // is the part a sender second-guesses.
          showAlert('Sent', `Your message went out from ${res.fromEmail}.`);
          goBackOr('/email');
        } catch (e) {
          // No network (ADR 0311): the message waits in the Outbox and goes,
          // through this same send, when the server answers again.
          if (e instanceof OfflineError) {
            try {
              await queueEmail({
                kind: 'new',
                accountId: fromId,
                alias,
                to: toList,
                cc: parseRecipients(cc),
                bcc: parseRecipients(bcc),
                subject,
                body,
                ...bodyCompose.wire,
                attachmentIds: attach.ids,
                draftId: savedId,
              }, sendId);
              await handOff();
              setSent(true);
              showAlert('In your Outbox', outboxNotice());
              goBackOr('/email');
              return;
            } catch (qe) {
              setErr((qe as Error).message);
              return;
            }
          }
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }),
    [to, cc, bcc, subject, body, fromId, alias, attach.ids, saveNow, undoSeconds, handOff, emailWaiting],
  );

  const undo = useCallback(async () => {
    if (!queued) return;
    try {
      await cancelEmailSend(queued.draftId);
      setQueued(null);
      setSent(false);
    } catch {
      // It went while the finger was moving. Saying so beats a screen that
      // pretends the message came back.
      setQueued(null);
      showAlert('Already sent', 'That message had already gone.');
      goBackOr('/email');
    }
  }, [queued]);

  // Cancel with nothing written just leaves. With something written it asks,
  // because leaving silently made a saved draft look like a lost one.
  const cancel = useCallback(() => {
    if (queued || sent || !written) goBackOr('/email');
    else setExitOpen(true);
  }, [queued, sent, written]);

  // Pulled down, or Escape on the web: whatever was written is kept as a
  // draft, without the Save / Delete question Cancel asks (ADR 0341).
  const swipeAway = useCallback(() => {
    if (queued || sent || !written) {
      goBackOr('/email');
      return;
    }
    void saveNow().finally(() => {
      if (isSavedOnPhoneOnly()) showAlert('Saved on this phone', PHONE_DRAFT_NOTICE);
      goBackOr('/email');
    });
  }, [queued, sent, written, saveNow, isSavedOnPhoneOnly]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancel();
      return true;
    });
    return () => sub.remove();
  }, [cancel]);

  const fromRows: SheetRow[] = useMemo(
    () =>
      options.map((o) => ({
        key: o.key,
        icon: o.key === from?.key ? 'check' : 'email-outline',
        label: o.address,
        hint: o.hint,
        onPress: () => setFromKey(o.key),
      })),
    [options, from?.key],
  );

  const canSend = !busy && !queued && !!to.trim() && bodyWritten;
  const ccVisible = showMore || !!cc.trim() || !!bcc.trim();
  const showPreview = preview && hasMarkdown(body);

  return (
    <ComposeFrame
      onSwipeAway={swipeAway}
      header={{
        title: 'New message',
        onCancel: cancel,
        actions: [
          {
            key: 'ask',
            icon: 'creation-outline',
            label: 'Ask Chord to write it',
            onPress: () => setAsking((v) => !v),
            active: asking,
          },
          {
            key: 'attach',
            icon: 'paperclip',
            label: 'Attach a file',
            onPress: () => void attach.pick(),
            busy: attach.busy,
          },
        ],
        canSend,
        sending: busy,
        onSend: () => void send(),
      }}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <FieldRow label="From">
        {options.length > 1 ? (
          <Pressable
            style={cs.fldPress}
            onPress={() => setFromOpen(true)}
            accessibilityLabel="Choose the address this is sent from"
          >
            <Text style={cs.fldStatic} numberOfLines={1}>
              {from?.address ?? ''}
            </Text>
            <Icon name="chevron-down" size={20} color={colors.muted} />
          </Pressable>
        ) : (
          <Text style={[cs.fldStatic, { color: colors.muted }]} numberOfLines={1}>
            {from?.address ?? ''}
          </Text>
        )}
      </FieldRow>

      <RecipientField
        row
        label="To"
        value={to}
        onChangeText={setTo}
        placeholder="name@example.com"
        autoFocus={!resumeId}
        trailing={
          !ccVisible ? (
            <Pressable onPress={() => setShowMore(true)} hitSlop={8}>
              <Text style={cs.fldLink}>Cc/Bcc</Text>
            </Pressable>
          ) : null
        }
      />
      {ccVisible ? (
        <>
          <RecipientField row label="Cc" value={cc} onChangeText={setCc} />
          <RecipientField row label="Bcc" value={bcc} onChangeText={setBcc} />
        </>
      ) : null}

      <FieldRow label="Subject">
        <TextInput style={cs.fldInput} value={subject} onChangeText={setSubject} />
        {hasMarkdown(body) ? (
          // Offered only when there is something to preview (ADR 0131).
          <Pressable onPress={() => setPreview((v) => !v)} hitSlop={8}>
            <Text style={[cs.fldLink, { color: colors.accent }]}>
              {showPreview ? 'Edit' : 'Preview'}
            </Text>
          </Pressable>
        ) : null}
      </FieldRow>

      {attach.files.length > 0 || attach.err || attach.busy ? (
        <View style={cs.attach}>
          <EmailAttachments
            files={attach.files}
            onPick={() => void attach.pick()}
            onRemove={attach.remove}
            busy={attach.busy}
            err={attach.err}
            hidePick
          />
        </View>
      ) : null}

      {aiBusy ? <AskWriting /> : null}

      {showPreview ? (
        <View style={cs.body}>
          <EmailBody html={markdownToHtml(body)} text={body} showRemoteImages />
        </View>
      ) : (
        <>
        <FormatSwitch value={bodyCompose.format} onChange={bodyCompose.choose} />
        <OutdatedSignatureNote body={body} signature={signature} onChange={setBody} />
        <ComposeBodyEditor
          compose={bodyCompose}
          placeholder="Write your message"
          disabled={!!queued}
          plain={
            <TextInput
              ref={bodyCaret.ref}
              onFocus={bodyCaret.onFocus}
              onBlur={bodyCaret.onBlur}
              style={cs.body}
              value={body}
              onChangeText={setBody}
              multiline
              textAlignVertical="top"
              placeholder="Write your message"
              placeholderTextColor={colors.muted}
              editable={!queued}
            />
          }
        />
        </>
      )}

      {err ? <Text style={cs.err}>{err}</Text> : null}

      {queued ? (
        <UndoSendBar
          sendAfter={queued.sendAfter}
          onUndo={() => void undo()}
          onExpired={() => goBackOr('/email')}
        />
      ) : null}

      {asking && !queued ? (
        <AskBar
          hasDraft={bodyWritten}
          chips={bodyWritten ? REVISE_ASKS : []}
          value={aiAsk}
          onChangeText={setAiAsk}
          onAsk={(q) => void ask(q)}
          busy={aiBusy}
          err={aiErr}
          placeholder={
            bodyWritten ? '"add that I\'ll bring snacks"' : '"ask Sam if Saturday dinner works"'
          }
        />
      ) : null}

      <ActionSheet open={fromOpen} rows={fromRows} onClose={() => setFromOpen(false)} />
      <DraftExitSheet
        open={exitOpen}
        onClose={() => setExitOpen(false)}
        onSave={() => {
          void saveNow().finally(() => {
            if (isSavedOnPhoneOnly()) showAlert('Saved on this phone', PHONE_DRAFT_NOTICE);
            goBackOr('/email');
          });
        }}
        onDelete={() => {
          void discard().finally(() => goBackOr('/email'));
        }}
      />
      <FileDropOverlay visible={attach.dragging} />
    </ComposeFrame>
  );
}
