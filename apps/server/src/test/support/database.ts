import { resolve } from 'node:path';
import { runMigrations, withTestDatabase } from '@meter/testing';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '../../platform/database/types.ts';

// NUMERIC(38,0) must never become a JS number (§10.3).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../..', 'database', 'migrations');

export function testDb(databaseUrl: string): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Isolated, fully migrated database for one integration test. */
export async function withMigratedDb(
  test: (db: Kysely<DB>, databaseUrl: string) => Promise<void>,
): Promise<void> {
  await withTestDatabase(async (databaseUrl) => {
    const db = testDb(databaseUrl);
    try {
      await runMigrations(databaseUrl, MIGRATIONS_DIR);
      await test(db, databaseUrl);
    } finally {
      await db.destroy();
    }
  });
}
