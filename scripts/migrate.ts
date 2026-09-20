import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// ponytail: plain reviewed SQL applied in filename order — no migration framework.
// Expand-and-contract by convention; destructive steps ship in a later release (§22.2).
const dir = join(import.meta.dirname, '..', 'database', 'migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`create table if not exists public.schema_migrations (
  name text primary key, applied_at timestamptz not null default now())`);

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
const { rows } = await client.query<{ name: string }>('select name from public.schema_migrations');
const applied = new Set(rows.map((r) => r.name));

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(join(dir, file), 'utf8');
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
    console.log(`applied ${file}`);
  } catch (error) {
    await client.query('rollback');
    throw new Error(`migration ${file} failed`, { cause: error });
  }
}

await client.end();
