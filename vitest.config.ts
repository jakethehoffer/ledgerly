import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    reporters: ['default'],
    passWithNoTests: true,
    coverage: {
      // v8 provider is faster than istanbul and produces v8-native instrumented
      // output that the lcov reporter converts to a standard format for
      // Codecov / Coveralls / IDE plugins.
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Re-export barrels — no logic to cover.
        'src/index.ts',
        // CLI entry point — exits the process and reads env on import; not
        // amenable to unit-test coverage. The behaviors it composes (server,
        // scheduler, dispatchers) all have their own tests.
        'src/server/cli.ts',
        // TypeScript type-only files surfaced through `src/**/*.ts`.
        'src/**/*.d.ts',
      ],
      // Soft floors. CI does not fail on under-coverage today; the thresholds
      // exist so a meaningful drop (e.g. someone deletes a test suite) gets
      // flagged in the text-summary output. Set ~5 points below the measured
      // baseline so noise doesn't trip them.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
