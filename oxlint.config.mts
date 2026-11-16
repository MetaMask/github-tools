import base, { createConfig } from '@metamask/oxlint-config';
import commonjs from '@metamask/oxlint-config-commonjs';
import nodejs from '@metamask/oxlint-config-nodejs';
import typescript from '@metamask/oxlint-config-typescript';
import vitest from '@metamask/oxlint-config-vitest';

type Override = NonNullable<
  Parameters<typeof createConfig>[0]['overrides']
>[number];

const nodeTestOverride: Override = {
  files: ['.github/scripts/**/*.test.mts'],
  extends: [nodejs, vitest],
  rules: {
    // The top level `test()` calls of the `node:test` tests return promises
    // that the test runner tracks, so they are not floating.
    'typescript/no-floating-promises': 'off',
  },
};

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
      // The workflow scripts read their inputs from the environment.
      files: ['.github/**'],
      rules: {
        'node/no-process-env': 'off',
      },
    },

    {
      files: ['src/**/*.test.ts'],
      extends: [nodejs, vitest],
    },

    nodeTestOverride,
  ],
});
