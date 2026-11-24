import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Opt in with `yarn test:watch`.
    watch: false,

    // Keep mocks from leaking between tests.
    mockReset: true,
    restoreMocks: true,

    passWithNoTests: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'src',
          include: ['src/**/*.test.ts'],
          testTimeout: 2500,
        },
      },

      {
        extends: true,
        test: {
          name: 'workflow-scripts',
          include: ['.github/**/*.test.{mjs,mts}'],

          // Many of these tests build real git repositories in temporary
          // directories and shell out to `git`, which is slower than the
          // default.
          testTimeout: 30_000,
        },
      },
    ],

    coverage: {
      // Enabled with `--coverage` in the `test` script.
      enabled: false,

      provider: 'v8',

      include: ['src/**/*.ts', '.github/**/*.{js,mjs,mts,ts}'],
      exclude: ['**/*.test.*', '.github/scripts/tests/**'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',

      thresholds: {
        // Raises the thresholds in this file when coverage improves.
        autoUpdate: true,
        branches: 43.95,
        functions: 54.12,
        lines: 43.32,
        statements: 43.53,
      },
    },
  },
});
