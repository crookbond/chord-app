import { forwardRef, useImperativeHandle, useRef } from 'react';
import { TextInput as RNTextInput, type TextInputProps } from 'react-native';

import { useRevealOnFocus } from '@/keyboard';
import { colors } from '@/theme';

/**
 * React Native's TextInput draws its text black unless told otherwise, which
 * is unreadable on the dark palette (ADR 0282). This one starts from the
 * theme's text and placeholder colours; a caller's own style or
 * placeholderTextColor still wins. Inside a `KeyboardScrollView` it also
 * scrolls itself above the keyboard when focused (ADR 0297).
 */
export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(
  { style, placeholderTextColor, onFocus, ...rest },
  ref,
) {
  const inner = useRef<RNTextInput>(null);
  useImperativeHandle(ref, () => inner.current as RNTextInput);
  const reveal = useRevealOnFocus();
  return (
    <RNTextInput
      ref={inner}
      style={[{ color: colors.text }, style]}
      placeholderTextColor={placeholderTextColor ?? colors.muted}
      onFocus={(e) => {
        if (reveal && inner.current) reveal(inner.current);
        onFocus?.(e);
      }}
      {...rest}
    />
  );
});

export type TextInput = RNTextInput;
