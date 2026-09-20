import { defineConfig } from 'vitest/config';

/**
 * The mandatory financial suite (§10.6): every test that touches real
 * PostgreSQL enforcement or generated command sequences.
 *
 * One worker, no file parallelism — these tests assert on whole-database state
 * such as the trial balance, which concurrent suites would perturb.
 */
export default defineConfig({
  test: {
    include: [
      'src/**/*.integration.test.ts',
      'src/**/*.property.test.ts',
      'src/**/*.concurrency.test.ts',
    ],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
