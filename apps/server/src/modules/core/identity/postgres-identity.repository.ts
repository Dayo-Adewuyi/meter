import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import type { DB } from '../../../platform/database/types.ts';
import type { IdentityRepository } from './identity.repository.ts';
import type { MeterPrincipal } from './principal.ts';

@Injectable()
export class PostgresIdentityRepository implements IdentityRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async findPrincipal(provider: string, subject: string): Promise<MeterPrincipal | null> {
    const row = await this.db
      .selectFrom('identity.external_identities as external')
      .innerJoin('identity.users as user', 'user.id', 'external.user_id')
      .select(['user.id', 'user.roles', 'user.status'])
      .where('external.provider', '=', provider)
      .where('external.external_subject', '=', subject)
      .executeTakeFirst();

    // A suspended or deleted user is denied exactly like an unknown one: the
    // caller learns nothing about which subjects exist. A query failure throws
    // and is never mistaken for an unrestricted principal.
    if (row === undefined || row.status !== 'active') return null;

    return {
      userId: row.id,
      roles: row.roles,
      // W1-07 owns real restriction state; until then active means unrestricted.
      restrictionState: 'unrestricted',
    };
  }
}
