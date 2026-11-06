import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Tests live next to the sources as `*.test.ts(x)`. Compiled output under
 * `packages/server/dist` must never be collected (Vitest 4 would otherwise
 * import the CommonJS test files and fail with "cannot be imported using
 * require()").
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.tmp/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
