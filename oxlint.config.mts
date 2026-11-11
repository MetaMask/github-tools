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
      // These are command-line scripts that read their inputs from the
      // environment.
      files: [
        '.github/**',
        'src/**/cli.ts',
        'oxlint.config.ts',
        'vitest.config.mts',
        'yarn.config.cjs',
      ],
      rules: {
        'node/no-process-env': 'off',
      },
    },

    {
      files: ['src/**/*.test.ts', '.github/scripts/**/*.test.mts'],
      extends: [nodejs, vitest],
    },
  ],
});
