import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '@meter/config';
import type { DB } from './types.ts';

// NUMERIC(38,0) must never become a JS number (§10.3).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export const DATABASE = Symbol('DATABASE');

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
});

@Global()
@Module({
  providers: [{ provide: DATABASE, useValue: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }) }],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // Shutdown can fire more than once (nested test apps, repeated close);
    // pg throws on a second end().
    if (pool.ending || pool.ended) return;
    await pool.end();
  }
}
