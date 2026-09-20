import { Controller, Get, Inject } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { Public } from '../modules/core/identity/public-route.ts';
import { DATABASE } from './database/database.module.ts';
import type { DB } from './database/types.ts';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string }> {
    await sql`select 1`.execute(this.db);
    return { status: 'ok' };
  }
}
