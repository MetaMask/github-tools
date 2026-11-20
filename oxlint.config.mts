import base, { createConfig } from '@metamask/oxlint-config';
import commonjs from '@metamask/oxlint-config-commonjs';
import nodejs from '@metamask/oxlint-config-nodejs';
import typescript from '@metamask/oxlint-config-typescript';
import vitest from '@metamask/oxlint-config-vitest';
import type { OxlintConfig } from 'oxlint';

// Tests and workflow scripts read the environment and use synchronous APIs.
const relaxedNodeRules: OxlintConfig = {
  rules: {
    'node/no-process-env': 'off',
    'node/no-sync': 'off',
  },
};

// `createConfig` types `overrides` as an intersection of two array types.
// TypeScript below 5.4 rejects that when every override has an `extends` entry,
// so the array below is cast. Remove the cast once TypeScript is upgraded.
type Overrides = NonNullable<Parameters<typeof createConfig>[0]['overrides']>;

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
      extends: [nodejs, vitest, relaxedNodeRules],
    },

    {
      // The workflow scripts are command line programs: they read their inputs
      // from the environment and can use synchronous APIs.
      files: ['.github/**/*.{js,mjs,mts,ts}'],
      extends: [nodejs, relaxedNodeRules],
    },
  ] as Overrides,
});
