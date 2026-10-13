/* eslint-env node */
module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
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
};
