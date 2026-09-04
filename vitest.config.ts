import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@mazi/core': path.resolve(__dirname, 'packages/core/src'),
      '@mazi/observability': path.resolve(__dirname, 'packages/observability/src'),
      '@mazi/flags': path.resolve(__dirname, 'packages/flags/src'),
      '@mazi/provider-llm': path.resolve(__dirname, 'packages/provider-llm/src'),
      '@mazi/usage': path.resolve(__dirname, 'packages/usage/src'),
      '@mazi/policy': path.resolve(__dirname, 'packages/policy/src'),
      '@mazi/memory': path.resolve(__dirname, 'packages/memory/src'),
      '@mazi/planner': path.resolve(__dirname, 'packages/planner/src'),
      '@mazi/executor': path.resolve(__dirname, 'packages/executor/src'),
      '@mazi/recovery': path.resolve(__dirname, 'packages/recovery/src'),
      '@mazi/user-profile': path.resolve(__dirname, 'packages/user-profile/src'),
      '@mazi/strategy-full-loop': path.resolve(__dirname, 'packages/strategy-full-loop/src'),
      '@mazi/harness-runtime': path.resolve(__dirname, 'packages/harness-runtime/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});
