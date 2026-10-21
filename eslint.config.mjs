// JS/TS lint for everything except the Reporter app: the Worker, the launcher, tests and
// orchestration scripts. The app keeps the WordPress configuration in plugin/app/eslint.config.cjs.
// TypeScript (`tsc -b` in the Worker and app) already checks types; this catches what it cannot.
//   pnpm lint:js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'plugin/app/**',
      'plugin/assets/dist/**',
      'plugin/vendor/**',
      // Vendored agent skills and research notebooks are not part of the product or its CI.
      '.agents/**',
      '.claude/**',
      'docs/**',
      // Build, test and CI output.
      'package-dist/**',
      '.test-site/**',
      '.bench-base/**',
      'test-results/**',
      'playwright-report/**',
      'benchmark-results/**',
      'runtime-results/**',
      'audit-results/**',
      'worker/.alchemy/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    // Explicit, because a process that also loads the app's configuration (scripts/lint-gate.test.mjs)
    // otherwise finds two candidate roots and refuses to parse TypeScript.
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      // `_`-prefixed bindings are deliberately unused, such as a destructured field left out.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['scripts/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['worker/**'],
    languageOptions: { globals: globals.node },
    // Effect's tagged errors take `{}` for an error without fields.
    rules: { '@typescript-eslint/no-empty-object-type': ['error', { allowObjectTypes: 'always' }] },
  },
  {
    // Browser and timing tests run in Node and pass callbacks that evaluate in the page.
    files: ['plugin/tests/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The launcher runs in the WordPress admin before the app loads.
    files: ['plugin/assets/**'],
    languageOptions: { globals: { ...globals.browser, wp: 'readonly' } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
