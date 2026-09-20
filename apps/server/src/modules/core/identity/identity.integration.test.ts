import { runMigrations, withTestDatabase } from '@meter/testing';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../../test/support/database.ts';

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
