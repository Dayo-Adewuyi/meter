// Usage: pnpm demo:timeline <purchase_id>  (agent-mandates §9.4)
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildTimeline, renderTimeline } from '../modules/products/agents/timeline.ts';
import type { DB } from '../platform/database/types.ts';

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

const purchaseId = process.argv[2];
if (purchaseId === undefined || process.env.DATABASE_URL === undefined) {
  console.error('usage: DATABASE_URL=… pnpm demo:timeline <purchase_id>');
  process.exit(1);
}

const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) }) });
try {
  const timeline = await buildTimeline(db, purchaseId);
  if (timeline === null) {
    console.error(`no purchase ${purchaseId}`);
    process.exitCode = 1;
  } else {
    console.log(renderTimeline(timeline));
  }
} finally {
  await db.destroy();
}
