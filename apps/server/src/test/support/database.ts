import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '../../platform/database/types.ts';

// NUMERIC(38,0) must never become a JS number (§10.3).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

export function testDb(databaseUrl: string): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
