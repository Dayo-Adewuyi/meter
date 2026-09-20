import { runMigrations } from '../packages/testing/src/migrations.ts';

if (process.env.DATABASE_URL === undefined) {
  throw new Error('DATABASE_URL is required');
}

await runMigrations(process.env.DATABASE_URL);
