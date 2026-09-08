import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@mazi/core': path.resolve(__dirname, 'packages/core/src'),
      '@mazi/provider': path.resolve(__dirname, 'packages/provider/src'),
      '@mazi/provider-runtime': path.resolve(__dirname, 'packages/provider-runtime/src'),
      '@mazi/runtime': path.resolve(__dirname, 'packages/runtime/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});