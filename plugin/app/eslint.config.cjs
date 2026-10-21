// The WordPress lint configuration that `wp-scripts lint-js` uses by default, for the Reporter app.
// Every WordPress rule stays an error except these style rules, so the app keeps its existing
// layout: Prettier formatting and the `curly` rule that comes with it, nested ternaries, and
// `@param` tags that would only repeat the TypeScript signature. React hooks, accessibility,
// translation and import rules all still apply.
//   pnpm --filter gq-support-app lint
const defaults = require('@wordpress/scripts/config/eslint.config.cjs');

module.exports = [
  ...defaults,
  {
    // The oldest React that WordPress registers (WordPress 6.5), not the npm devDependency.
    settings: { react: { version: '18.2' } },
    // See eslint.config.mjs: needed once both configurations load in one process.
    languageOptions: { parserOptions: { tsconfigRootDir: __dirname } },
    rules: {
      'prettier/prettier': 'off',
      curly: 'off',
      'no-nested-ternary': 'off',
      'jsdoc/require-param': 'off',
      // The classic-runtime pragmas of ADR 0011.
      'jsdoc/check-tag-names': ['error', { definedTags: ['jsx', 'jsxRuntime'] }],
      '@wordpress/i18n-text-domain': ['error', { allowedTextDomain: 'gq-support' }],
    },
  },
];
