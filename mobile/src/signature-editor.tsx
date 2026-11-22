/**
 * ADR 0260 addendum (2026-11-13) - a rich signature edited as it looks. The
 * signature is drawn in a page of its own (sandboxed iframe on web, WebView on
 * a phone) whose body is editable; the page reports the new HTML and which
 * link was tapped (kernel `parseSignatureEditorMessage`). Nothing it says is
 * trusted: the server cleans the HTML on save.
 *
 * The page is built once per `resetKey`, not on every change, so typing does
 * not reload it and lose the caret. Bump the key when the HTML changes from
 * outside (a paste, a picture, a link edit, another mailbox).
 */
import * as Crypto from 'expo-crypto';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';

import {
  SIGNATURE_EDITOR_SANDBOX,
  SIGNATURE_EDITOR_SCRIPT,
  parseSignatureEditorMessage,
  signatureEditorDocument,
  type SignatureEditorMessage,
} from '@chord/kernel';

import { API_BASE } from '@/api';
import { colors } from '@/theme';

const MIN_HEIGHT = 60;

function nonce(): string {
  const bytes = Crypto.getRandomBytes(18);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/[^A-Za-z0-9]/g, 'x');
}

export function RichSignatureEditor({
  html,
  resetKey,
  onChange,
  onLink,
}: {
  html: string;
  resetKey: number;
  onChange: (html: string) => void;
  onLink: (index: number, href: string, text: string) => void;
}) {
  const [height, setHeight] = useState(MIN_HEIGHT);
  // The HTML the page was built from: read only when the key changes.
  const latest = useRef(html);
  latest.current = html;
  const handlers = useRef({ onChange, onLink });
  handlers.current = { onChange, onLink };

  const handle = (m: SignatureEditorMessage | null) => {
    if (!m) return;
    if (m.kind === 'height') setHeight(Math.max(MIN_HEIGHT, m.height));
    else if (m.kind === 'html') handlers.current.onChange(m.html);
    else handlers.current.onLink(m.index, m.href, m.text);
  };

  const frame = Platform.OS === 'web' ? (
    <WebEditorFrame resetKey={resetKey} html={latest} height={height} onMessage={handle} />
  ) : (
    <NativeEditor resetKey={resetKey} html={latest} height={height} onMessage={handle} />
  );
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' }}>
      {frame}
    </View>
  );
}

type FrameProps = {
  resetKey: number;
  html: { current: string };
  height: number;
  onMessage: (m: SignatureEditorMessage | null) => void;
};

function WebEditorFrame({ resetKey, html, height, onMessage }: FrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doc = useMemo(() => signatureEditorDocument(html.current, { nonce: nonce(), apiOrigin: API_BASE }), [resetKey]);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      const win = ref.current?.contentWindow;
      if (!win || e.source !== win) return;
      handler.current(parseSignatureEditorMessage(e.data));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  return createElement('iframe', {
    ref,
    srcDoc: doc,
    sandbox: SIGNATURE_EDITOR_SANDBOX,
    referrerPolicy: 'no-referrer',
    title: 'Signature',
    style: { display: 'block', width: '100%', height, border: 0, background: '#fff' },
  });
}

function NativeEditor({ resetKey, html, height, onMessage }: FrameProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => ({ html: signatureEditorDocument(html.current, { apiOrigin: API_BASE }) }), [resetKey]);
  // The WebView's own outer box is flex: 1, which sizes it from 0 in a
  // parent with no height of its own; the height has to be on a wrapper.
  return (
    <View style={{ height }}>
    <WebView
      key={resetKey}
      originWhitelist={['*']}
      source={source}
      javaScriptEnabled
      domStorageEnabled={false}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      injectedJavaScript={SIGNATURE_EDITOR_SCRIPT}
      onShouldStartLoadWithRequest={(req) =>
        req.url === 'about:blank' || req.url.startsWith('data:') || req.url.startsWith('about:srcdoc')
      }
      onMessage={(e) => onMessage(parseSignatureEditorMessage(e.nativeEvent.data))}
      style={{ flex: 1, backgroundColor: '#fff' }}
    />
    </View>
  );
}
