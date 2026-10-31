import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      // new in eslint 10 (eslint:recommended), off per upgrade design
      'no-useless-assignment': 'off',
      // ponytail: off, not fixed. The validators' OCR regexes escape '-' and '/' inside
      // character classes by habit; removing one in the middle of a class turns it into a
      // range and silently changes what matches. Re-enable with a regex test per pattern.
      'no-useless-escape': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      // `declare global { namespace Express }` is how Express request typing is extended.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
);
