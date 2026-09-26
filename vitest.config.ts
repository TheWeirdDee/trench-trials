import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests hit a real remote Postgres (Supabase pooler) with several
    // sequential round trips per test; unit tests finish in milliseconds regardless,
    // so raising the ceiling accommodates network latency to the cloud database.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
