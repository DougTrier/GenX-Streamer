import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
  // Browser-backed fixtures share the host: bound workers rather than timing out
  // valid cleanup/transport checks under dozens of simultaneous Chrome launches.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 10000, restoreMocks: true, maxWorkers: 4 },
});
