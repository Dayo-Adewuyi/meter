import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

function databaseUrlFor(serverUrl: string, databaseName: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function temporaryDatabaseName(): string {
  return `meter_test_${randomUUID().replaceAll('-', '')}`;
}

async function startPostgres(): Promise<{ container: StartedTestContainer; databaseUrl: string }> {
  const container = await new GenericContainer('postgres:18')
    .withEnvironment({ POSTGRES_USER: 'meter', POSTGRES_PASSWORD: 'meter', POSTGRES_DB: 'meter' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/))
    .withStartupTimeout(30_000)
    .start();
  const databaseUrl = `postgres://meter:meter@${container.getHost()}:${container.getMappedPort(5432)}/meter`;

  return { container, databaseUrl };
}

export async function withTestDatabase(test: (databaseUrl: string) => Promise<void>): Promise<void> {
  let container: StartedTestContainer | undefined;
  const fallback = process.env.DATABASE_URL === undefined ? await startPostgres() : undefined;
  container = fallback?.container;
  const serverUrl = process.env.DATABASE_URL ?? fallback?.databaseUrl;
  if (serverUrl === undefined) throw new Error('database URL is required');
  const databaseName = temporaryDatabaseName();
  const databaseUrl = databaseUrlFor(serverUrl, databaseName);
  const admin = new pg.Client({ connectionString: serverUrl });

  try {
    await admin.connect();
    await admin.query(`create database ${databaseName}`);
    try {
      await test(databaseUrl);
    } finally {
      await admin.query(`drop database if exists ${databaseName}`);
    }
  } finally {
    try {
      await admin.end();
    } finally {
      await container?.stop();
    }
  }
}
