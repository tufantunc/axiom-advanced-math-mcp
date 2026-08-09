import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      // lcov is what SonarQube ingests; the others are for reading locally.
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts']
    },
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
      'test/http-portability.test.ts',
      'test/cli-contract.test.ts',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
