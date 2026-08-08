import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
      'test/http-portability.test.ts',
      'test/cli-contract.test.ts',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
  }
});
