// ESLint flat config for Eyes of Argus.
'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'docs/api/**', 'node_modules/**', 'server/node_modules/**', 'server/.wrangler/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Extension scripts: plain browser scripts, WebExtension globals
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Cloudflare Worker: ES module with service-worker style globals
    files: ['server/src/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.serviceworker } },
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
