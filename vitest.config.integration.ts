import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // No setupFiles — giac mock must NOT be loaded
    include: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
  }
});
