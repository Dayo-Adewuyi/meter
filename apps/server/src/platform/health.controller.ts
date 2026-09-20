import { Controller, Get, Inject } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { DATABASE } from './database/database.module.ts';
import type { DB } from './database/types.ts';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Get()
  async check(): Promise<{ status: string }> {
    await sql`select 1`.execute(this.db);
    return { status: 'ok' };
  }
}
