import { defineConfig } from 'vitest/config';
import { INTEGRATION_TESTS } from './vitest.suites.ts';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: INTEGRATION_TESTS,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
