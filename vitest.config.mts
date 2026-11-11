import { defineConfig } from 'vitest/config';

/**
 * For a detailed explanation of each option, visit:
 * https://vitest.dev/config/
 */
export default defineConfig({
  test: {
    // Vitest enables watch mode by default. We disable it here, so it can be
    // explicitly enabled with `yarn test:watch`.
    watch: false,

    // Reset mocks between tests, so a mocked implementation cannot leak from
    // one test into the next.
    mockReset: true,
    restoreMocks: true,

    passWithNoTests: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'src',

          // The files to include in the test run.
          include: ['src/**/*.test.ts'],

          // Reduce the default test timeout from 5s to 2.5s
          testTimeout: 2500,
        },
      },

      {
        extends: true,
        test: {
          name: 'workflow-scripts',

          // The scripts run by workflows, which are plain `.mts` files that
          // Node.js runs directly.
          include: ['.github/**/*.test.{mjs,mts}'],

          // Many of these tests build real git repositories in temporary
          // directories and shell out to `git`, which is slower than the
          // default.
          testTimeout: 30_000,
        },
      },
    ],

    coverage: {
      // Enabled with `--coverage`, see the `test` script.
      enabled: false,

      provider: 'v8',

      // Only `src` counts towards the coverage thresholds. The scripts under
      // `.github` are not part of the coverage report.
      include: ['src/**/*.ts'],

      // The files to exclude from the coverage report.
      exclude: ['src/**/*.test.ts'],

      reporter: ['text', 'html', 'json-summary'],

      reportsDirectory: 'coverage',

      thresholds: {
        autoUpdate: true,
        branches: 62.31,
        functions: 62.25,
        lines: 65.55,
        statements: 65.73,
      },
    },
  },
});
