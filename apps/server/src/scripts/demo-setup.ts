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

  // An x402 covenant: 25 USDC for the sandbox oracle on this API's origin (the API's
  // sandbox faucet backs the USDC on its simulated chain within seconds).
  const usdc = await serializable(db, (trx) => ensureCustomerAccounts(trx, ownerId, 'USDC'));
  await app.get(CreditDebitService).credit({
    idempotencyScope: 'sandbox.credit',
    idempotencyKey: `${ownerId}:demo-setup:usdc:${randomUUID()}`,
    correlationId: randomUUID(),
    availableAccountId: usdc.available,
    assetCode: 'USDC',
    amountAtomic: 25_000_000n,
    metadata: { source: 'demo:setup' },
  });
  const oracle = await mandates.create(ownerId, {
    name: 'Oracle budget',
    assetCode: 'USDC',
    perTransactionLimit: 500_000n, // 0.50 USDC
    dailyLimit: 5_000_000n,
    lifetimeLimit: 50_000_000n,
    velocityMaxCount: 20,
    velocityWindowSecs: 600,
    allowedCategories: ['x402'],
    allowedDestinations: [`http://localhost:${env.PORT}`],
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  const oracleSeal = await mandates.issueCredential(ownerId, oracle.id, {
    label: 'Claude Desktop (x402)',
    scopes: ['purchases:create', 'purchases:read'],
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });

  console.log(
    JSON.stringify(
      {
        owner_id: ownerId,
        airtime: { mandate_id: mandate.id, credential_id: credential.id, token: credential.token },
        x402: { mandate_id: oracle.id, credential_id: oracleSeal.id, token: oracleSeal.token, oracle: `http://localhost:${env.PORT}/v1/sandbox/x402/oracle?q=…` },
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
