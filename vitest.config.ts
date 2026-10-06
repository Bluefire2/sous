import { defineConfig } from 'vitest/config';

// Nothing under test touches the DOM, so the node environment keeps runs fast.
export default defineConfig({
  test: {
    environment: 'node',
    // `npm run test:coverage` only (docs/plans/test-coverage.md, step 12).
    // A report, not a gate: no thresholds. Only the code unit tests are meant
    // to cover; screens and components are checked in the browser instead.
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'src/lib/**/*.ts', 'scripts/**/*.ts', 'api/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'text'],
      reportsDirectory: 'coverage',
    },
  },
});
