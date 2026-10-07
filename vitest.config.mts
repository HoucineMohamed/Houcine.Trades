import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // 'server-only' throws by design when imported outside a Next.js server build.
      'server-only': path.resolve(import.meta.dirname, 'tests/helpers/empty.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // no test may reach the network (see the file)
    setupFiles: ['tests/helpers/no-network.ts'],
  },
});
