import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/**/*.{ts,mts}',
    '.github/scripts/**/*.{mts,mjs,js,ts}',
    '.github/actions/**/*.{mjs,js}',
    '*.config.{js,cjs,mjs,ts,mts}',
  ],
  project: [
    'src/**/*.{ts,mts}',
    '.github/scripts/**/*.{mts,mjs,js,ts}',
    '.github/actions/**/*.{mjs,js}',
    '*.{js,cjs,mjs,ts,mts}',
  ],
  ignoreDependencies: [
    // Used by Yarn through the `allow-scripts` plugin and the `lavamoat`
    // field in `package.json`, which knip does not trace.
    '@lavamoat/allow-scripts',
    '@lavamoat/preinstall-always-fail',

    // Not imported directly, but used for the `ts-node --swc` scripts.
    '@swc/cli',

    // Provided by the GitHub Actions runner, which is where
    // `.github/scripts/remove-rca-needed-label-sheets.ts` runs.
    '@actions/core',
    '@actions/github',
  ],
};

export default config;
