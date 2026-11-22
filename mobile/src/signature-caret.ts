/**
 * A composer box opens with the signature in it (ADR 0260 addendum), and both
 * a browser and the phone put the caret at the END of a box's text when it is
 * focused or when its text is set while focused - under the signature. This
 * puts it at the top while nothing has been written yet (`signatureCaret`),
 * and leaves it alone once the person has typed.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { TextInput as RNTextInput } from 'react-native';
import { findSignature, signatureCaret } from '@chord/kernel';

type CaretTarget = {
  /** The web: the ref is the DOM textarea. */
  setSelectionRange?: (start: number, end: number) => void;
  scrollTop?: number;
  /** iOS / Android. */
  setSelection?: (start: number, end: number) => void;
};

export function useSignatureCaret(value: string, signature: string | null | undefined) {
  const ref = useRef<RNTextInput>(null);
  const focused = useRef(false);
  const prev = useRef(value);

  const toTop = useCallback(() => {
    // After the browser / OS has placed its own caret (focus, a click, a
    // value set while focused).
    setTimeout(() => {
      const n = ref.current as unknown as CaretTarget | null;
      if (!n) return;
      if (typeof n.setSelectionRange === 'function') {
        n.setSelectionRange(0, 0);
        n.scrollTop = 0;
      } else {
        n.setSelection?.(0, 0);
      }
    }, 0);
  }, []);

  // The signature usually loads after the box is focused: it arriving is a
  // value set by code, not typing, so the caret goes back to the top.
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (!focused.current) return;
    if (findSignature(before, signature) < 0 && signatureCaret(value, signature) === 0) toTop();
  }, [value, signature, toTop]);

  const onFocus = useCallback(() => {
    focused.current = true;
    if (signatureCaret(prev.current, signature) === 0) toTop();
  }, [signature, toTop]);
  const onBlur = useCallback(() => {
    focused.current = false;
  }, []);

  return { ref, onFocus, onBlur };
}
