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

    // The files to include in the test run.
    include: ['src/**/*.test.ts'],

    // Reduce the default test timeout from 5s to 2.5s
    testTimeout: 2500,

    // Reset mocks between tests, so a mocked implementation cannot leak from
    // one test into the next.
    mockReset: true,
    restoreMocks: true,

    passWithNoTests: true,

    coverage: {
      // Enabled with `--coverage`, see the `test` script.
      enabled: false,

      provider: 'v8',

      // The files to include in the coverage report.
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
