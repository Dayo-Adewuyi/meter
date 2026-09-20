import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { env } from '@meter/config';

export const JOBS = Symbol('JOBS');

// Work is queued via the transactional outbox, never fire-and-forget (§12.1).
const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'jobs' });

@Global()
@Module({ providers: [{ provide: JOBS, useValue: boss }], exports: [JOBS] })
export class JobsModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await boss.stop();
  }
}
