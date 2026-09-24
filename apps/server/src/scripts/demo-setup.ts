// Sandbox only (agent-mandates §15 step 1) without a Clerk session:
//   pnpm demo:setup [owner_user_id]
// Credits ₦10,000, creates the demo mandate, issues a credential and prints it once.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { env } from '@meter/config';
import type { Kysely } from 'kysely';
import { AppModule } from '../app.module.ts';
import { MandatesService } from '../modules/core/authorization/mandates.service.ts';
import { ensureCustomerAccounts } from '../modules/core/ledger/accounts.ts';
import { CreditDebitService } from '../modules/core/ledger/credit-debit.service.ts';
import { DATABASE } from '../platform/database/database.module.ts';
import { serializable } from '../platform/database/transaction.ts';
import type { DB } from '../platform/database/types.ts';

if (!env.METER_AGENTS_SANDBOX) throw new Error('demo:setup runs only with METER_AGENTS_SANDBOX=true');

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const db = app.get<Kysely<DB>>(DATABASE);
  const ownerId =
    process.argv[2] ??
    (await db.insertInto('identity.users').values({ roles: ['customer', 'operator'] }).returning('id').executeTakeFirstOrThrow()).id;

  const accounts = await serializable(db, (trx) => ensureCustomerAccounts(trx, ownerId, 'NGN'));
  await app.get(CreditDebitService).credit({
    idempotencyScope: 'sandbox.credit',
    idempotencyKey: `${ownerId}:demo-setup:${randomUUID()}`,
    correlationId: randomUUID(),
    availableAccountId: accounts.available,
    assetCode: 'NGN',
    amountAtomic: 1_000_000n, // ₦10,000
    metadata: { source: 'demo:setup' },
  });

  const mandates = app.get(MandatesService);
  const mandate = await mandates.create(ownerId, {
    name: 'Claude airtime demo',
    assetCode: 'NGN',
    perTransactionLimit: 200_000n, // ₦2,000
    dailyLimit: 500_000n, // ₦5,000
    lifetimeLimit: 5_000_000n,
    velocityMaxCount: 5,
    velocityWindowSecs: 600,
    allowedCategories: ['airtime'],
    allowedDestinations: null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  const credential = await mandates.issueCredential(ownerId, mandate.id, {
    label: 'Claude Desktop',
    scopes: ['purchases:create', 'purchases:read'],
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });

  console.log(JSON.stringify({ owner_id: ownerId, mandate_id: mandate.id, credential_id: credential.id, token: credential.token }, null, 2));
} finally {
  await app.close();
}
