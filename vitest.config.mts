import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Opt in with `yarn test:watch`.
    watch: false,

    include: ['src/**/*.test.ts'],
    testTimeout: 2500,

    // Keep mocks from leaking between tests.
    mockReset: true,
    restoreMocks: true,

    passWithNoTests: true,

    coverage: {
      // Enabled with `--coverage` in the `test` script.
      enabled: false,

      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',

      thresholds: {
        // Raises the thresholds in this file when coverage improves.
        autoUpdate: true,
        branches: 62.31,
        functions: 62.25,
        lines: 65.55,
        statements: 65.73,
      },
    },
  },
});
