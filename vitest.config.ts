import { defineConfig } from 'vitest/config';

export default defineConfig({
  mode: 'node',
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Circuit proof + block confirmation can be slow on testnet
    testTimeout: 1000 * 60 * 60,
    hookTimeout: 1000 * 60 * 45,
    deps: {
      interopDefault: true,
    },
    globals: true,
    environment: 'node',
  include: ['src/**/*.bench.ts', 'src/bench.test.ts'],
exclude: ['node_modules', 'src/fund-wallet.test.ts'],
    root: '.',
    reporters: ['verbose'],
    sequence: {
      // Run bench suites sequentially so timings aren't skewed by parallelism
      concurrent: false,
    },
  },
  resolve: {
    extensions: ['.ts', '.js'],
    conditions: ['import', 'node', 'default'],
  },
});
