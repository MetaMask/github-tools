import base, { createConfig } from '@metamask/oxlint-config';
import commonjs from '@metamask/oxlint-config-commonjs';
import nodejs from '@metamask/oxlint-config-nodejs';
import typescript from '@metamask/oxlint-config-typescript';
import vitest from '@metamask/oxlint-config-vitest';

export default createConfig({
  extends: [base],

  ignorePatterns: ['**/coverage/**', '**/dist/**', '.yarn/**'],

  options: {
    typeAware: true,
  },

  overrides: [
    {
      files: ['**/*.ts', '**/*.mts', '**/*.cts'],
      extends: [typescript],
    },

    {
      files: ['**/*.js', '**/*.cjs', '**/*.ts', '**/*.cts'],
      extends: [nodejs, commonjs],
      rules: {
        'import/extensions': 'off',
      },
    },

    {
      files: ['**/*.mjs', '**/*.mts'],
      extends: [nodejs],
      rules: {
        'import/extensions': 'off',
      },
    },

    {
      files: [
        'src/**/*.test.ts',
        '.github/**/*.test.{mjs,mts}',
        '.github/scripts/tests/**',
      ],
      extends: [nodejs, vitest],
      rules: {
        'node/no-process-env': 'off',
        'node/no-sync': 'off',
      },
    },

    {
      // The workflow scripts are command line programs: they read their inputs
      // from the environment and can use synchronous APIs.
      files: ['.github/**/*.{js,mjs,mts,ts}'],
      extends: [nodejs],
      rules: {
        'node/no-process-env': 'off',
        'node/no-sync': 'off',
      },
    },
  ],
});
