import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export async function runMigrations(
  databaseUrl: string,
  migrationsDir = join(process.cwd(), 'database', 'migrations'),
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    await client.query(`create table if not exists public.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('select name from public.schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
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
  } finally {
    await client.end();
  }
}
