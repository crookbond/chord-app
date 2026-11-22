import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * One flat config lints every TS/TSX file across server/, mobile/, kernel/,
 * and scripts. Node globals apply everywhere; React + React Hooks rules are
 * scoped to mobile/. Rules are intentionally loose — we want fast signal on
 * real bugs, not stylistic noise.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      '**/.expo-web-test/**',
      '**/web-build/**',
      // Other sessions' worktrees: linting them from the main checkout
      // multiplied the run by ~8x and reported their errors as ours.
      '.claude/**',
      'data/**',
      'logs/**',
      'client/**',
      'mobile/babel.config.js',
      'mobile/metro.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['mobile/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Purely stylistic (a literal ' / " in JSX text) — off, per this config's
      // "fast signal on real bugs, not stylistic noise" stance.
      'react/no-unescaped-entities': 'off',
    },
  },
  {
    // CommonJS Node scripts (config files, e2e harness) — the main block above
    // only covers .ts/.tsx/.mjs, so these were missing Node globals + tripped
    // no-require-imports. Declare them as the Node/browser scripts they are.
    files: ['e2e/**/*.js', '**/*.config.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
