import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { ClerkWebhookVerifier } from '../../../adapters/auth/clerk-webhook-verifier.ts';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { WEBHOOK_ROUTE_CONFIG } from '../../../platform/security/webhooks/webhook-verification.guard.ts';
import type { DB } from '../../../platform/database/types.ts';
import { testDb, withMigratedDb } from '../../../test/support/database.ts';
import { TEST_SIGNING_SECRET, signWebhook, userEvent } from '../../../test/support/clerk-webhook.ts';
import { PostgresIdentityRepository } from './postgres-identity.repository.ts';
import { UserProvisioningService } from './user-provisioning.service.ts';

const CREATED = (id: string) => ({ kind: 'created' as const, provider: 'clerk' as const, subject: id, disabled: false });

const identityRow = (db: Kysely<DB>, subject: string) =>
  db
    .selectFrom('identity.external_identities as external')
    .innerJoin('identity.users as user', 'user.id', 'external.user_id')
    .select(['user.id', 'user.status', 'user.roles'])
    .where('external.external_subject', '=', subject)
    .executeTakeFirst();

describe('user provisioning', () => {
  it('creates an internal user and maps the provider subject to it', async () => {
    await withMigratedDb(async (db) => {
      const outcome = await new UserProvisioningService(db).apply(CREATED('user_new'));

      expect(outcome).toBe('created');
      const row = await identityRow(db, 'user_new');
      expect(row).toMatchObject({ status: 'active', roles: ['customer'] });
      // The internal id is Meter's own UUIDv7, never the Clerk subject.
      expect(row?.id).not.toBe('user_new');
      expect(row?.id[14]).toBe('7');
    });
  }, 60_000);

  it('makes the guard resolve a principal that was previously denied', async () => {
    await withMigratedDb(async (db) => {
      const repository = new PostgresIdentityRepository(db);
      await expect(repository.findPrincipal('clerk', 'user_guard')).resolves.toBeNull();

      await new UserProvisioningService(db).apply(CREATED('user_guard'));

      await expect(repository.findPrincipal('clerk', 'user_guard')).resolves.toMatchObject({
        roles: ['customer'],
        restrictionState: 'unrestricted',
      });
    });
  }, 60_000);

  it('is idempotent across redelivery and never orphans a user row', async () => {
    await withMigratedDb(async (db) => {
      const service = new UserProvisioningService(db);

      await expect(service.apply(CREATED('user_twice'))).resolves.toBe('created');
      await expect(service.apply(CREATED('user_twice'))).resolves.toBe('unchanged');

      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(1);
      await expect(db.selectFrom('identity.external_identities').selectAll().execute()).resolves.toHaveLength(1);
    });
  }, 60_000);

  it('leaves no user behind when concurrent deliveries race', async () => {
    await withMigratedDb(async (db) => {
      const service = new UserProvisioningService(db);

      await Promise.allSettled([
        service.apply(CREATED('user_race')),
        service.apply(CREATED('user_race')),
        service.apply(CREATED('user_race')),
      ]);

      await expect(db.selectFrom('identity.external_identities').selectAll().execute()).resolves.toHaveLength(1);
      // The real invariant: never a user row without an identity pointing at it.
      const orphans = await db
        .selectFrom('identity.users')
        .leftJoin('identity.external_identities as external', 'external.user_id', 'identity.users.id')
        .select('identity.users.id')
        .where('external.user_id', 'is', null)
        .execute();
      expect(orphans).toEqual([]);
    });
  }, 60_000);

  it('suspends a banned user and revives them when the ban lifts', async () => {
    await withMigratedDb(async (db) => {
      const service = new UserProvisioningService(db);
      const repository = new PostgresIdentityRepository(db);
      await service.apply(CREATED('user_ban'));

      await expect(
        service.apply({ kind: 'updated', provider: 'clerk', subject: 'user_ban', disabled: true }),
      ).resolves.toBe('updated');
      expect(await identityRow(db, 'user_ban')).toMatchObject({ status: 'suspended' });
      await expect(repository.findPrincipal('clerk', 'user_ban')).resolves.toBeNull();

      await service.apply({ kind: 'updated', provider: 'clerk', subject: 'user_ban', disabled: false });
      await expect(repository.findPrincipal('clerk', 'user_ban')).resolves.not.toBeNull();
    });
  }, 60_000);

  it('soft-deletes, because financial accounts reference the user row', async () => {
    await withMigratedDb(async (db) => {
      const service = new UserProvisioningService(db);
      await service.apply(CREATED('user_gone'));
      const row = await identityRow(db, 'user_gone');

      await service.apply({ kind: 'deleted', provider: 'clerk', subject: 'user_gone', disabled: false });

      expect(await identityRow(db, 'user_gone')).toMatchObject({ status: 'deleted' });
      await expect(
        db.selectFrom('identity.users').selectAll().where('id', '=', row?.id ?? '').execute(),
      ).resolves.toHaveLength(1);
      await expect(new PostgresIdentityRepository(db).findPrincipal('clerk', 'user_gone')).resolves.toBeNull();
    });
  }, 60_000);

  it('ignores a lifecycle event for a subject it has never seen', async () => {
    await withMigratedDb(async (db) => {
      await expect(
        new UserProvisioningService(db).apply({
          kind: 'updated',
          provider: 'clerk',
          subject: 'user_unknown',
          disabled: true,
        }),
      ).resolves.toBe('unchanged');
      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 60_000);
});

describe('clerk webhook route', () => {
  /**
   * The app must be closed before `withMigratedDb` drops the database, so the
   * whole lifecycle lives inside the callback rather than in an afterEach.
   */
  async function withApp(
    test: (app: NestFastifyApplication, db: Kysely<DB>) => Promise<void>,
  ): Promise<void> {
    await withMigratedDb(async (_unused, databaseUrl) => {
      const db = testDb(databaseUrl);
      let app: NestFastifyApplication | undefined;
      try {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(db)
          .overrideProvider(WEBHOOK_ROUTE_CONFIG)
          .useValue({ provider: 'clerk', verifier: new ClerkWebhookVerifier(TEST_SIGNING_SECRET) })
          .compile();

        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
          rawBody: true,
        });
        app.setGlobalPrefix('v1');
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        await test(app, db);
      } finally {
        await app?.close();
        await db.destroy();
      }
    });
  }

  const post = (target: NestFastifyApplication, signed: ReturnType<typeof signWebhook>) =>
    target.inject({
      method: 'POST',
      url: '/v1/webhooks/clerk',
      headers: signed.headers,
      payload: signed.rawBody,
    });

  it('provisions a user end to end from a genuinely signed webhook', async () => {
    await withApp(async (app, db) => {
      const signed = signWebhook(userEvent('user.created', { id: 'user_e2e' }));

      const response = await post(app, signed);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'created' });
      await expect(identityRow(db, 'user_e2e')).resolves.toMatchObject({ status: 'active' });
      await expect(
        db.selectFrom('operations.external_events').selectAll().where('provider', '=', 'clerk').execute(),
      ).resolves.toHaveLength(1);
    });
  }, 120_000);

  it('rejects an unsigned body without provisioning anything', async () => {
    await withApp(async (app, db) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/clerk',
        headers: { 'content-type': 'application/json' },
        payload: userEvent('user.created', { id: 'user_unsigned' }),
      });

      expect(response.statusCode).toBe(401);
      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 120_000);

  it('rejects a payload altered after signing', async () => {
    await withApp(async (app, db) => {
      const signed = signWebhook(userEvent('user.created', { id: 'user_honest' }));

      const response = await post(app, {
        headers: signed.headers,
        rawBody: Buffer.from(userEvent('user.created', { id: 'user_tampered' })),
      });

      expect(response.statusCode).toBe(401);
      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 120_000);

  it('acknowledges an identical redelivery without creating a second user', async () => {
    await withApp(async (app, db) => {
      const signed = signWebhook(userEvent('user.created', { id: 'user_replay' }));

      const first = await post(app, signed);
      const replay = await post(app, signed);

      expect(first.json()).toEqual({ status: 'created' });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ status: 'unchanged' });
      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(1);
    });
  }, 120_000);

  it('refuses a different payload reusing an already-claimed event id', async () => {
    await withApp(async (app, db) => {
      const eventId = 'msg_reused';
      await post(app, signWebhook(userEvent('user.created', { id: 'user_first' }), { eventId }));

      const response = await post(
        app,
        signWebhook(userEvent('user.created', { id: 'user_second' }), { eventId }),
      );

      expect(response.statusCode).toBe(409);
      await expect(identityRow(db, 'user_second')).resolves.toBeUndefined();
    });
  }, 120_000);

  it('acknowledges an event type it does not act on', async () => {
    await withApp(async (app, db) => {
      const response = await post(app, signWebhook(userEvent('session.created', { id: 'sess_1' })));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ignored' });
      await expect(db.selectFrom('identity.users').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 120_000);
});
