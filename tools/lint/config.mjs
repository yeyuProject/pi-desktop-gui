import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const lintTypeScript = pathToFileURL(require.resolve('typescript')).href;
const repository = new URL('../../', import.meta.url).href;
// npm may hoist ts-api-utils because its peer range also accepts TS 7, whose native
// package no longer exposes the JS compiler API. Only this lint dependency uses TS 6.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'typescript' &&
      context.parentURL?.startsWith(repository) &&
      context.parentURL.includes('/ts-api-utils/')
    )
      return { url: lintTypeScript, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { default: tseslint } = await import('typescript-eslint');
import globals from 'globals';

// The parser has its own supported TypeScript runtime. Application builds retain TypeScript 7.
export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'work/**',
      'test-results/**',
      'output/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' },
      ],
      // Protocol delimiters and filesystem validation intentionally match control bytes.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      // Pi extension/RPC payloads are dynamic; tsc remains the authoritative type checker.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unreachable': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' },
      ],
    },
  },
);
