import { runMigrations, withTestDatabase } from '@meter/testing';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '../../../platform/database/types.ts';
import { testDb, withMigratedDb } from '../../../test/support/database.ts';
import { PostgresIdentityRepository } from './postgres-identity.repository.ts';

function versionNibble(uuid: string): string {
  return uuid[14] ?? '';
}

describe('identity migration', () => {
  it('uses an internal UUIDv7 and keeps Clerk subjects outside financial keys', async () => {
    await withTestDatabase(async (databaseUrl) => {
      const db = testDb(databaseUrl);

      try {
        await runMigrations(databaseUrl, resolve(import.meta.dirname, '../../../../../..', 'database', 'migrations'));
        const user = await db
          .insertInto('identity.users')
          .values({ status: 'active', roles: ['customer'] })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        await db
          .insertInto('identity.external_identities')
          .values({ provider: 'clerk', external_subject: 'user_123', user_id: user.id })
          .execute();

        expect(versionNibble(user.id)).toBe('7');
        await expect(
          db
            .insertInto('identity.external_identities')
            .values({ provider: 'clerk', external_subject: 'user_123', user_id: user.id })
            .execute(),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await db.destroy();
      }
    });
  }, 30_000);
});

describe('postgres identity repository', () => {
  it('resolves an active subject to its internal principal and denies everything else', async () => {
    await withMigratedDb(async (db) => {
      const repository = new PostgresIdentityRepository(db);
      const insertUser = (status: 'active' | 'suspended', roles: UserRole[]) =>
        db
          .insertInto('identity.users')
          .values({ status, roles })
          .returning('id')
          .executeTakeFirstOrThrow();

      const active = await insertUser('active', ['customer', 'operator']);
      const suspended = await insertUser('suspended', ['customer']);
      await db
        .insertInto('identity.external_identities')
        .values([
          { provider: 'clerk', external_subject: 'user_active', user_id: active.id },
          { provider: 'clerk', external_subject: 'user_suspended', user_id: suspended.id },
        ])
        .execute();

      await expect(repository.findPrincipal('clerk', 'user_active')).resolves.toEqual({
        userId: active.id,
        roles: ['customer', 'operator'],
        restrictionState: 'unrestricted',
      });
      await expect(repository.findPrincipal('clerk', 'user_suspended')).resolves.toBeNull();
      await expect(repository.findPrincipal('clerk', 'user_unknown')).resolves.toBeNull();
      await expect(repository.findPrincipal('other', 'user_active')).resolves.toBeNull();
    });
  }, 60_000);
});
