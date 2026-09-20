import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import type { DB, UserStatus } from '../../../platform/database/types.ts';
import type { ExternalUserEvent, ProvisioningOutcome } from './external-user-event.ts';

/**
 * Owns the mapping from a provider subject to an internal user (§15.2).
 *
 * Until a row exists here the auth guard denies with `IDENTITY_NOT_FOUND`, so
 * this is what makes a real Clerk token usable.
 */
@Injectable()
export class UserProvisioningService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async apply(event: ExternalUserEvent): Promise<ProvisioningOutcome> {
    if (event.kind === 'created') return this.create(event);
    // A deleted upstream account must stop authenticating, but the row stays:
    // ledger.accounts.customer_id references it, and financial history is not
    // deletable. Status is the off switch.
    return this.setStatus(event, event.kind === 'deleted' ? 'deleted' : statusFor(event));
  }

  private async create(event: ExternalUserEvent): Promise<ProvisioningOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('identity.external_identities')
        .select('user_id')
        .where('provider', '=', event.provider)
        .where('external_subject', '=', event.subject)
        .executeTakeFirst();
      // A redelivered create is not a second user.
      if (existing !== undefined) return 'unchanged';

      const user = await trx
        .insertInto('identity.users')
        .values({ status: statusFor(event), roles: ['customer'] })
        .returning('id')
        .executeTakeFirstOrThrow();
      // If a concurrent delivery won the race, the primary key rejects this and
      // the whole transaction rolls back — no user row is left orphaned.
      await trx
        .insertInto('identity.external_identities')
        .values({
          provider: event.provider,
          external_subject: event.subject,
          user_id: user.id,
        })
        .execute();
      return 'created';
    });
  }

  private async setStatus(event: ExternalUserEvent, status: UserStatus): Promise<ProvisioningOutcome> {
    const identity = await this.db
      .selectFrom('identity.external_identities')
      .select('user_id')
      .where('provider', '=', event.provider)
      .where('external_subject', '=', event.subject)
      .executeTakeFirst();
    // An update for a subject we never provisioned is not an error: the create
    // may still be in flight, and Clerk will redeliver.
    if (identity === undefined) return 'unchanged';

    await this.db
      .updateTable('identity.users')
      .set({ status, updated_at: new Date() })
      .where('id', '=', identity.user_id)
      .execute();
    return 'updated';
  }
}

function statusFor(event: ExternalUserEvent): UserStatus {
  return event.disabled ? 'suspended' : 'active';
}
