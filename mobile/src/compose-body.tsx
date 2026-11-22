/**
 * ADR 0339 - an email is written Plain or Rich, and shows as it will go.
 *
 * Plain: the composer's text box, the signature as plain text, sent as text.
 * Rich: a page of its own whose body is editable (sandboxed iframe on web,
 * WebView on a phone), a toolbar above it, and the rich signature at the
 * bottom drawn as it will be sent.
 *
 * `useComposeBody` keeps the composer's text body (what drafts, "is it empty",
 * the AI ask and the offline outbox already work on) in step with the editor's
 * HTML. A text change the editor did not make (an AI draft, a restored draft,
 * another signature) rebuilds the page from the text; typing in the page does
 * not rebuild it, so the caret stays put.
 */
import * as Crypto from 'expo-crypto';
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';

import {
  COMPOSE_EDITOR_SANDBOX,
  COMPOSE_EDITOR_SCRIPT,
  composeCommandPayload,
  composeEditorDocument,
  hasSignatureBlock,
  parseComposeEditorMessage,
  plainToRich,
  richToPlain,
  signatureLinkInput,
  type ComposeCommand,
  type ComposeEditorMessage,
  type ComposeFormat,
} from '@chord/kernel';

import { API_BASE } from '@/api';
import { colors, themed } from '@/theme';

export interface ComposeBody {
  /** Null until the composer has decided (see `init`). */
  format: ComposeFormat | null;
  html: string | null;
  editorKey: number;
  /** Set the opening format once; a later call is ignored. */
  init: (f: ComposeFormat) => void;
  /** A saved draft: its own format, and for rich its HTML. */
  load: (f: ComposeFormat | undefined, text: string, html?: string | null) => void;
  choose: (f: ComposeFormat) => void;
  onEditorChange: (html: string, text: string, mainText: string) => void;
  /** What a draft save or a send carries. */
  wire: { format?: ComposeFormat; bodyHtml: string | null };
}

export function useComposeBody(
  body: string,
  setBody: (next: string) => void,
  signature: string | null | undefined,
  signatureHtml: string | null,
): ComposeBody {
  const [format, setFormat] = useState<ComposeFormat | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  // The text the editor's HTML stands for. A body that differs came from
  // somewhere else, and the page is rebuilt from it.
  const synced = useRef<string | null>(null);
  const builtWithSig = useRef<string | null>(null);

  useEffect(() => {
    if (format !== 'rich') return;
    const sigArrived = !!signatureHtml && builtWithSig.current !== signatureHtml && html !== null && !hasSignatureBlock(html);
    if (body === synced.current && !sigArrived) return;
    synced.current = body;
    builtWithSig.current = signatureHtml;
    setHtml(plainToRich(body, signature, signatureHtml));
    setEditorKey((k) => k + 1);
  }, [format, body, signature, signatureHtml, html]);

  const init = useCallback((f: ComposeFormat) => setFormat((cur) => cur ?? f), []);
  const load = useCallback((f: ComposeFormat | undefined, text: string, saved?: string | null) => {
    if (!f) return;
    if (f === 'rich' && saved?.trim()) {
      synced.current = text;
      builtWithSig.current = null;
      setHtml(saved);
      setEditorKey((k) => k + 1);
    }
    setFormat(f);
  }, []);
  const choose = useCallback((f: ComposeFormat) => {
    if (f === 'rich') synced.current = null;
    setFormat(f);
  }, []);
  const onEditorChange = useCallback(
    (nextHtml: string, text: string, mainText: string) => {
      const t = richToPlain({ text, mainText, hasSignature: hasSignatureBlock(nextHtml) }, signature);
      synced.current = t;
      setHtml(nextHtml);
      setBody(t);
    },
    [signature, setBody],
  );

  return {
    format,
    html,
    editorKey,
    init,
    load,
    choose,
    onEditorChange,
    wire: format ? { format, bodyHtml: format === 'rich' ? html : null } : { bodyHtml: null },
  };
}

/** The Plain / Rich switch. */
export function FormatSwitch({ value, onChange }: { value: ComposeFormat | null; onChange: (f: ComposeFormat) => void }) {
  return (
    <View style={styles.switchRow} accessibilityRole="radiogroup">
      {(['plain', 'rich'] as const).map((f) => (
        <Pressable
          key={f}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === f, selected: value === f }}
          onPress={() => onChange(f)}
          style={[styles.switchBtn, value === f && styles.switchOn]}
        >
          <Text style={[styles.switchTxt, value === f && styles.switchTxtOn]}>{f === 'plain' ? 'Plain' : 'Rich'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The body: the caller's text box in Plain, the rich editor in Rich. */
export function ComposeBodyEditor({
  compose,
  plain,
  placeholder,
  disabled,
}: {
  compose: ComposeBody;
  plain: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  if (compose.format !== 'rich' || compose.html === null) return <>{plain}</>;
  return (
    <RichComposeEditor
      html={compose.html}
      resetKey={compose.editorKey}
      onChange={compose.onEditorChange}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

const MIN_HEIGHT = 160;

function nonce(): string {
  const bytes = Crypto.getRandomBytes(18);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/[^A-Za-z0-9]/g, 'x');
}

type Sender = (c: ComposeCommand) => void;

function RichComposeEditor({
  html,
  resetKey,
  onChange,
  placeholder,
  disabled,
}: {
  html: string;
  resetKey: number;
  onChange: (html: string, text: string, mainText: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const latest = useRef(html);
  latest.current = html;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const sender = useRef<Sender>(() => {});

  const handle = (m: ComposeEditorMessage | null) => {
    if (!m) return;
    if (m.kind === 'height') setHeight(Math.max(MIN_HEIGHT, m.height));
    else if (m.kind === 'change') onChangeRef.current(m.html, m.text, m.mainText);
    else setActive({ bold: m.bold, italic: m.italic, underline: m.underline, ul: m.ul, ol: m.ol, link: m.link });
  };

  const props: FrameProps = { resetKey, html: latest, height, onMessage: handle, sender, placeholder };
  const frame = Platform.OS === 'web' ? <WebFrame {...props} /> : <NativeFrame {...props} />;
  const send = (c: ComposeCommand) => sender.current(c);
  const tools: Array<{ key: string; label: string; cmd: ComposeCommand['cmd']; a11y: string; style?: object }> = [
    { key: 'bold', label: 'B', cmd: 'bold', a11y: 'Bold', style: { fontWeight: '700' } },
    { key: 'italic', label: 'I', cmd: 'italic', a11y: 'Italic', style: { fontStyle: 'italic' } },
    { key: 'underline', label: 'U', cmd: 'underline', a11y: 'Underline', style: { textDecorationLine: 'underline' } },
    { key: 'ul', label: '•', cmd: 'ul', a11y: 'Bulleted list' },
    { key: 'ol', label: '1.', cmd: 'ol', a11y: 'Numbered list' },
  ];
  const addLink = () => {
    const href = signatureLinkInput(linkText);
    if (!href) return;
    send({ cmd: 'link', href });
    setLinkOpen(false);
    setLinkText('');
  };

  return (
    <View style={styles.wrap} pointerEvents={disabled ? 'none' : 'auto'}>
      <View style={styles.toolbar}>
        {tools.map((t) => (
          <Pressable
            key={t.key}
            accessibilityRole="button"
            accessibilityLabel={t.a11y}
            accessibilityState={{ selected: !!active[t.key] }}
            onPress={() => send({ cmd: t.cmd } as ComposeCommand)}
            style={[styles.tool, active[t.key] && styles.toolOn]}
          >
            <Text style={[styles.toolTxt, t.style]}>{t.label}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a link"
          onPress={() => setLinkOpen((v) => !v)}
          style={[styles.tool, (active.link || linkOpen) && styles.toolOn]}
        >
          <Text style={styles.toolTxt}>Link</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Clear formatting" onPress={() => send({ cmd: 'clear' })} style={styles.tool}>
          <Text style={styles.toolTxt}>Clear</Text>
        </Pressable>
      </View>
      {linkOpen ? (
        <View style={styles.linkRow}>
          <TextInput
            value={linkText}
            onChangeText={setLinkText}
            onSubmitEditing={addLink}
            placeholder="Web address, email or phone"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.linkInput}
          />
          <Pressable accessibilityRole="button" onPress={addLink} style={styles.linkBtn}>
            <Text style={styles.linkBtnTxt}>Add</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.page}>{frame}</View>
    </View>
  );
}

type FrameProps = {
  resetKey: number;
  html: { current: string };
  height: number;
  onMessage: (m: ComposeEditorMessage | null) => void;
  sender: { current: Sender };
  placeholder?: string;
};

function WebFrame({ resetKey, html, height, onMessage, sender, placeholder }: FrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const doc = useMemo(
    () => composeEditorDocument(html.current, { nonce: nonce(), apiOrigin: API_BASE, placeholder, minHeight: MIN_HEIGHT - 2 }),
    // Rebuilt only when the key moves, so typing keeps the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  );
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      const win = ref.current?.contentWindow;
      if (!win || e.source !== win) return;
      handler.current(parseComposeEditorMessage(e.data));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  sender.current = (c) => {
    const payload = composeCommandPayload(c);
    if (payload) ref.current?.contentWindow?.postMessage(JSON.parse(payload), '*');
  };
  return createElement('iframe', {
    ref,
    srcDoc: doc,
    sandbox: COMPOSE_EDITOR_SANDBOX,
    referrerPolicy: 'no-referrer',
    title: 'Message',
    style: { display: 'block', width: '100%', height, border: 0, background: '#fff' },
  });
}

function NativeFrame({ resetKey, html, height, onMessage, sender, placeholder }: FrameProps) {
  const ref = useRef<WebView>(null);
  const source = useMemo(
    () => ({ html: composeEditorDocument(html.current, { apiOrigin: API_BASE, placeholder, minHeight: MIN_HEIGHT - 2 }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  );
  sender.current = (c) => {
    const payload = composeCommandPayload(c);
    if (payload) ref.current?.injectJavaScript(`window.chordComposeRun && window.chordComposeRun(${JSON.stringify(payload)}); true;`);
  };
  // The WebView's own outer box is flex: 1, which sizes it from 0 in a
  // parent with no height of its own; the height has to be on a wrapper.
  return (
    <View style={{ height }}>
    <WebView
      ref={ref}
      key={resetKey}
      originWhitelist={['*']}
      source={source}
      javaScriptEnabled
      domStorageEnabled={false}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      injectedJavaScript={COMPOSE_EDITOR_SCRIPT}
      onShouldStartLoadWithRequest={(req) =>
        req.url === 'about:blank' || req.url.startsWith('data:') || req.url.startsWith('about:srcdoc')
      }
      onMessage={(e) => onMessage(parseComposeEditorMessage(e.nativeEvent.data))}
      style={{ flex: 1, backgroundColor: '#fff' }}
    />
    </View>
  );
}

const styles = themed((c) => ({
  wrap: { marginHorizontal: 12, marginBottom: 8 },
  toolbar: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, paddingBottom: 6 },
  tool: {
    minWidth: 34,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  toolOn: { backgroundColor: c.border },
  toolTxt: { color: c.text, fontSize: 14 },
  linkRow: { flexDirection: 'row' as const, gap: 8, paddingBottom: 6, alignItems: 'center' as const },
  linkInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: c.text,
  },
  linkBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  linkBtnTxt: { color: c.accent, fontWeight: '600' as const },
  page: { borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: 'hidden' as const, backgroundColor: '#fff' },
  switchRow: { flexDirection: 'row' as const, alignSelf: 'flex-start' as const, marginHorizontal: 12, marginBottom: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, overflow: 'hidden' as const },
  switchBtn: { paddingHorizontal: 14, paddingVertical: 5 },
  switchOn: { backgroundColor: c.border },
  switchTxt: { color: c.muted, fontSize: 13 },
  switchTxtOn: { color: c.text, fontWeight: '600' as const },
}));
