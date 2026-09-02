import { defineConfig } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  {
    // Generated output — never our code to lint.
    ignores: ['coverage/', 'dist/'],
  },
  {
    // `@typescript-eslint` doesn't support TypeScript 7 yet (both the parser
    // and the plugin hard-throw on load against it), so `.ts` sources are
    // unparseable by ESLint for now. Prettier still formats/checks them via
    // its own independent TS parser. See tracking issue for when to restore
    // this. https://github.com/typescript-eslint/typescript-eslint/issues/10940
    ignores: ['**/*.ts'],
  },
  {
    extends: compat.extends('plugin:prettier/recommended'),

    languageOptions: {
      globals: {
        ...globals.node,
      },

      ecmaVersion: 2020,
      sourceType: 'module',
    },

    rules: {
      'no-console': 'error',
      'no-plusplus': 'off',
      'no-await-in-loop': 'off',
      'no-constant-condition': 'off',
      'no-restricted-syntax': 'off',
    },
  },
]);
