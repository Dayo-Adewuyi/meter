# Meter First-Ten and Ledger-Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the dependency-complete 17-ticket identity, webhook-security, and ledger foundation, including a mandatory financial CI gate.

**Architecture:** Keep Meter domain and application types inside focused NestJS modules, place Clerk behind `AuthenticatorPort`, and let the ledger depend directly on explicit Kysely/PostgreSQL transactions. Enforce financial invariants twice: stable application errors at the command boundary and additive PostgreSQL constraints/triggers at the persistence boundary.

**Tech Stack:** Node.js 24, TypeScript 7, NestJS 12/Fastify, Kysely 0.29, PostgreSQL 18, Clerk Backend SDK, Vitest 5, fast-check 4, Testcontainers 12, pnpm 11, GitHub Actions.

## Global Constraints

- Preserve every pre-existing staged change; do not reset, overwrite, or fold it into unrelated commits.
- Add migrations after `0003_outbox.sql`; never edit an already-applied migration.
- Money is `bigint` in domain/application code, decimal strings on JSON boundaries, and `NUMERIC(38,0)` in PostgreSQL. The raw Kysely/`pg` persistence row uses strings because PostgreSQL returns `NUMERIC(38,0)` losslessly as text; ledger adapters convert at the boundary before values enter domain/application code. JavaScript `number` is prohibited for money.
- Only the ledger module writes `ledger.*`; posted entries are append-only.
- Every financial command runs at `SERIALIZABLE`, accepts an idempotency scope and key, and makes no external network call inside its transaction.
- Every command writes its journal, entries, projections, reservation state when applicable, idempotent result, and outbox event atomically.
- A repeated idempotency key with an identical canonical request returns the original result; a different request returns `IDEMPOTENCY_CONFLICT`.
- Provider SDK types never leave `apps/server/src/adapters`.
- Authentication and authorization deny by default.
- Use only exact dependency versions accepted by the repository's seven-day `minimumReleaseAge` policy and commit the resulting lockfile.
- Run each task's narrow test before its wider package tests. Never claim a task is done from code inspection alone.

## File map

### Shared test and database support

- `packages/testing/src/migrations.ts`: reusable reviewed-SQL migration runner used by CLI and integration tests.
- `packages/testing/src/postgres.ts`: PostgreSQL test database lifecycle and reset helpers.
- `apps/server/src/test/support/database.ts`: typed Kysely test client factory.
- `apps/server/src/test/support/ledger-fixtures.ts`: deterministic account/user/funding fixtures.
- `apps/server/src/platform/database/types.ts`: complete Kysely table interfaces for this scope.

### Identity and authentication

- `database/migrations/0004_identity.sql`: internal users and external identity mappings.
- `apps/server/src/modules/core/identity/authenticator.port.ts`: Meter-owned authentication contract.
- `apps/server/src/adapters/auth/clerk-authenticator.ts`: the only Clerk-specific implementation.
- `apps/server/src/modules/core/identity/identity.repository.ts`: principal lookup contract.
- `apps/server/src/modules/core/identity/postgres-identity.repository.ts`: Kysely principal lookup.
- `apps/server/src/modules/core/identity/auth.guard.ts`: global deny-by-default bearer guard.
- `apps/server/src/modules/core/identity/principal.ts`: request principal and Fastify request augmentation.
- `apps/server/src/modules/core/identity/identity.module.ts`: identity composition root.

### Webhook security

- `database/migrations/0006_webhook_security.sql`: replay-safe external-event claims.
- `apps/server/src/platform/security/webhooks/webhook-verifier.port.ts`: provider verification contract.
- `apps/server/src/platform/security/webhooks/webhook-events.repository.ts`: event-claim persistence contract and PostgreSQL implementation.
- `apps/server/src/platform/security/webhooks/webhook-security.service.ts`: signature result, timestamp-window, digest, and replay policy.
- `apps/server/src/platform/security/webhooks/webhook-verification.middleware.ts`: reusable Nest middleware that passes exact raw bytes through the shared policy.
- `apps/server/src/platform/security/webhooks/webhook-security.module.ts`: shared provider-neutral module.

### Ledger

- `database/migrations/0005_ledger_taxonomy.sql`: account taxonomy, asset checks, and deterministic system accounts.
- `database/migrations/0007_ledger_idempotency.sql`: independent idempotency claims and stored results.
- `database/migrations/0008_ledger_invariants.sql`: strict append-only behavior and deferred balance checks.
- `database/migrations/0009_ledger_reservations.sql`: reservations, captures, and refunds.
- `apps/server/src/modules/core/ledger/ledger.types.ts`: commands, results, rows, and public port.
- `apps/server/src/modules/core/ledger/ledger.errors.ts`: stable financial error codes.
- `apps/server/src/modules/core/ledger/canonical-request.ts`: deterministic digesting.
- `apps/server/src/modules/core/ledger/idempotency.ts`: claim/replay/conflict transaction helper.
- `apps/server/src/modules/core/ledger/journal.ts`: pure journal validation and projection deltas.
- `apps/server/src/modules/core/ledger/post-journal.ts`: the only primitive that inserts transactions, entries, projections, and outbox events.
- `apps/server/src/modules/core/ledger/credit-debit.service.ts`: credit and controlled debit.
- `apps/server/src/modules/core/ledger/reservation.service.ts`: reserve, capture, and release.
- `apps/server/src/modules/core/ledger/reversal.service.ts`: linked compensating journals.
- `apps/server/src/modules/core/ledger/refund.service.ts`: capture-linked refunds and ceiling enforcement.
- `apps/server/src/modules/core/ledger/rebuild-projections.service.ts`: maintenance rebuild from entries.
- `apps/server/src/modules/core/ledger/ledger.module.ts`: ledger composition root.

---

### Task 1: W1-01 — Internal users and external identities

**Files:**
- Create: `database/migrations/0004_identity.sql`
- Create: `packages/testing/package.json`
- Create: `packages/testing/tsconfig.json`
- Create: `packages/testing/src/index.ts`
- Create: `packages/testing/src/migrations.ts`
- Create: `packages/testing/src/postgres.ts`
- Create: `apps/server/src/modules/core/identity/identity.integration.test.ts`
- Create: `apps/server/src/test/support/database.ts`
- Modify: `scripts/migrate.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Produces: `runMigrations(databaseUrl: string, migrationsDir?: string): Promise<void>`.
- Produces: `withTestDatabase(test: (databaseUrl: string) => Promise<void>): Promise<void>`.
- Produces: `testDb(databaseUrl: string): Kysely<DB>`.
- Produces: Kysely tables `'identity.users'` and `'identity.external_identities'`.

- [ ] **Step 1: Write the failing identity migration test**

```ts
it('uses an internal UUIDv7 and keeps Clerk subjects outside financial keys', async () => {
  await withTestDatabase(async (databaseUrl) => {
    await runMigrations(databaseUrl);
    const db = testDb(databaseUrl);
    const user = await db.insertInto('identity.users')
      .values({ status: 'active', roles: ['customer'] })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await db.insertInto('identity.external_identities')
      .values({ provider: 'clerk', external_subject: 'user_123', user_id: user.id })
      .execute();

    expect(versionNibble(user.id)).toBe('7');
    await expect(db.insertInto('identity.external_identities')
      .values({ provider: 'clerk', external_subject: 'user_123', user_id: user.id })
      .execute()).rejects.toMatchObject({ code: '23505' });
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run the test and confirm the migration is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/identity/identity.integration.test.ts`

Expected: FAIL because `identity.users` does not exist.

- [ ] **Step 3: Add the reusable migration test package and refactor the CLI**

Implement `runMigrations` by moving the existing filename-ordered transaction loop from `scripts/migrate.ts` into `packages/testing/src/migrations.ts`. Resolve the default migration directory from `process.cwd()/database/migrations`, accept an override for Testcontainers, always close the client in `finally`, and retain the `public.schema_migrations` table. Make `scripts/migrate.ts` call the exported function with `process.env.DATABASE_URL`.

`withTestDatabase` must create a uniquely named temporary database on the
PostgreSQL server identified by `DATABASE_URL` when that variable exists. When
it does not exist, it starts `postgres:18` through Testcontainers first. It
passes the isolated database URL to the callback, drops that database and
closes the admin client in `finally`, and stops a fallback container. Export
both helpers from `packages/testing/src/index.ts` and add `@meter/testing` as a
server dev dependency.

Implement `testDb` with the same NUMERIC/INT8 string parsers as the production
database module and a `pg.Pool`/`PostgresDialect`; tests must call
`await db.destroy()` in `finally`.

- [ ] **Step 4: Add the identity schema**

```sql
create table identity.users (
  id uuid primary key default uuidv7(),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  roles text[] not null default array['customer']::text[]
    check (cardinality(roles) > 0 and roles <@ array['customer','operator','admin']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table identity.external_identities (
  provider text not null,
  external_subject text not null,
  user_id uuid not null references identity.users(id),
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, external_subject),
  unique (provider, user_id)
);

create index external_identities_user_idx
  on identity.external_identities (user_id);
```

Add exact Kysely `Selectable`, `Insertable`, and `Updateable` table shapes to `DB`; timestamp columns are `ColumnType<Date, Date | undefined, Date>` and UUIDs are strings.

- [ ] **Step 5: Run the focused and migration-idempotency tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/identity/identity.integration.test.ts && DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate && DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate`

Expected: identity test PASS; first migration run applies `0004_identity.sql`; second applies nothing and exits 0.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git add database/migrations/0004_identity.sql packages/testing scripts/migrate.ts apps/server/package.json apps/server/src/platform/database/types.ts apps/server/src/test/support/database.ts apps/server/src/modules/core/identity/identity.integration.test.ts pnpm-lock.yaml
git commit -m "feat(identity): add internal user model"
```

### Task 2: W2-01 — Account taxonomy and chart of accounts

**Files:**
- Create: `database/migrations/0005_ledger_taxonomy.sql`
- Create: `apps/server/src/modules/core/ledger/account-taxonomy.ts`
- Create: `apps/server/src/modules/core/ledger/account-taxonomy.integration.test.ts`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Produces: `ACCOUNT_CLASSES`, `ACCOUNT_PURPOSES`, `SYSTEM_OWNER_ID`, and `accountDefinition(purpose)`.
- Produces: checked account columns `account_class` and `purpose`.

- [ ] **Step 1: Write failing taxonomy tests**

```ts
it('seeds every system account and rejects an invalid purpose', async () => {
  const rows = await db.selectFrom('ledger.accounts')
    .select(['account_class', 'purpose', 'asset_code', 'normal_balance'])
    .where('owner_type', '=', 'system')
    .orderBy('purpose')
    .execute();
  expect(rows.map((row) => row.purpose)).toEqual([
    'external_cash', 'meter_revenue', 'provider_payable', 'reserve', 'tax_liability',
  ]);
  await expect(insertAccount({ purpose: 'mystery' })).rejects.toMatchObject({ code: '23514' });
});
```

- [ ] **Step 2: Run it and confirm the columns are absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/account-taxonomy.integration.test.ts`

Expected: FAIL with column `purpose` missing.

- [ ] **Step 3: Add pure taxonomy definitions**

```ts
export const ACCOUNT_CLASSES = [
  'asset', 'customer_liability', 'provider_liability', 'revenue', 'tax_liability', 'reserve',
] as const;

export const ACCOUNT_PURPOSES = [
  'customer_available', 'customer_reserved', 'customer_pending', 'provider_payable',
  'meter_revenue', 'tax_liability', 'external_cash', 'reserve',
] as const;

export const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';
```

`accountDefinition()` must be an exhaustive switch mapping each purpose to its class and normal balance; customer/provider/tax/revenue liability-like purposes are credit-normal, while external cash and reserve are debit-normal.

- [ ] **Step 4: Add constraints and deterministic seed rows**

The migration adds `account_class` and `purpose`, backfills any existing rows from `account_type`, makes both non-null, adds checked enums, adds `unique(id, asset_code)`, and replaces the old owner/account unique constraint with `unique(owner_type, owner_id, asset_code, purpose)`.

Add nullable `customer_id uuid references identity.users(id)` and a constraint
requiring `customer_id = owner_id` when `owner_type = 'customer'` and
`customer_id is null` for system/provider accounts. This makes the internal
identity table the actual foreign-key target for customer financial accounts;
no Clerk subject can satisfy a financial foreign key.

Seed the five system NGN accounts with UUIDs `00000000-0000-7000-8000-000000000001` through `...0005` using `ON CONFLICT DO NOTHING`. Add a foreign key from `(ledger.entries.account_id, asset_code)` to `(ledger.accounts.id, asset_code)`.

- [ ] **Step 5: Run focused tests and schema type checking**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/account-taxonomy.integration.test.ts && pnpm --filter @meter/server typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/0005_ledger_taxonomy.sql apps/server/src/modules/core/ledger/account-taxonomy.ts apps/server/src/modules/core/ledger/account-taxonomy.integration.test.ts apps/server/src/platform/database/types.ts
git commit -m "feat(ledger): define account taxonomy"
```

### Task 3: W1-04 — Shared webhook verification and replay protection

**Files:**
- Create: `database/migrations/0006_webhook_security.sql`
- Create: `apps/server/src/platform/security/webhooks/webhook-verifier.port.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-events.repository.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-security.service.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-verification.middleware.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-security.module.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-security.test.ts`
- Create: `apps/server/src/platform/security/webhooks/webhook-security.integration.test.ts`
- Modify: `apps/server/src/bootstrap/api.ts`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Consumes: exact raw request bytes from Nest `RawBodyRequest<FastifyRequest>`.
- Produces: `WebhookVerifier.verify(input): Promise<VerifiedWebhookEnvelope>`.
- Produces: `WebhookSecurityService.verifyAndClaim(input): Promise<'accepted' | 'duplicate'>`.
- Produces: `WebhookVerificationMiddleware.use(request, response, next)` and `request.verifiedWebhook`.

- [ ] **Step 1: Write failing timestamp, digest, and replay tests**

```ts
const verifier: WebhookVerifier = {
  verify: vi.fn(async () => ({ eventId: 'evt_1', signedAt: new Date('2026-09-20T12:00:00Z') })),
};

it('accepts one event, acknowledges an identical replay, and rejects ID reuse', async () => {
  await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('accepted');
  await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('duplicate');
  await expect(service.verifyAndClaim(input('{"ok":false}')))
    .rejects.toMatchObject({ code: 'WEBHOOK_EVENT_CONFLICT' });
});

it('rejects a valid signature outside the five-minute replay window', async () => {
  vi.setSystemTime('2026-09-20T12:05:01Z');
  await expect(service.verifyAndClaim(input('{}')))
    .rejects.toMatchObject({ code: 'WEBHOOK_TIMESTAMP_EXPIRED' });
});
```

- [ ] **Step 2: Run tests and confirm missing service failures**

Run: `pnpm --filter @meter/server test -- src/platform/security/webhooks`

Expected: FAIL because the webhook contracts do not exist.

- [ ] **Step 3: Implement the provider-neutral contracts and policy**

```ts
export interface VerifiedWebhookEnvelope {
  readonly eventId: string;
  readonly signedAt: Date;
}

export interface WebhookVerifier {
  verify(input: { rawBody: Buffer; headers: Readonly<Record<string, string | string[] | undefined>> }):
    Promise<VerifiedWebhookEnvelope>;
}
```

`WebhookSecurityService` must reject a missing raw body, call the verifier before persistence, enforce `Math.abs(now - signedAt) <= 300_000`, hash the exact `Buffer` with SHA-256, and call the repository with provider, event ID, digest, and signed time. The repository must use `INSERT ... ON CONFLICT DO NOTHING`; on conflict it loads the stored digest and returns duplicate only when the digest matches.

`WebhookVerificationMiddleware` receives provider and verifier through injected
configuration, reads Nest's `RawBodyRequest<FastifyRequest>.rawBody`, calls the
shared service, freezes the verified envelope on `request.verifiedWebhook`, and
calls `next()` only after acceptance or an identical replay. Signature,
timestamp, missing-body, and event-conflict errors must propagate to Nest's
exception layer without calling `next()`. Unit-test the middleware with real
service behavior and an in-memory event repository; do not assert only that a
mock was called.

- [ ] **Step 4: Harden the external-event schema and raw body bootstrap**

The migration adds `provider_event_at`, `status` checked to `verified|processing|processed|failed`, and `updated_at`; backfill old rows before making `provider_event_at` non-null. Modify API creation options to `{ bufferLogs: true, rawBody: true }` while retaining Fastify's one-megabyte body limit.

- [ ] **Step 5: Run webhook tests and API type checking**

Run: `pnpm --filter @meter/server test -- src/platform/security/webhooks && pnpm --filter @meter/server typecheck`

Expected: unit and PostgreSQL replay tests PASS; API bootstrap compiles with Nest's official raw-body option.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/0006_webhook_security.sql apps/server/src/platform/security/webhooks apps/server/src/bootstrap/api.ts apps/server/src/platform/database/types.ts
git commit -m "feat(security): add replay-safe webhook verification"
```

### Task 4: W1-02 — Authenticator port and Clerk adapter

**Files:**
- Create: `apps/server/src/modules/core/identity/authenticator.port.ts`
- Create: `apps/server/src/adapters/auth/clerk-authenticator.ts`
- Create: `apps/server/src/adapters/auth/clerk-authenticator.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `.env.example`
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `AUTHENTICATOR` injection token.
- Produces: `AuthenticatorPort.verifyToken(token): Promise<ExternalPrincipal>` and `fetchUser(subject): Promise<ExternalUser>`.

- [ ] **Step 1: Write contract-level adapter tests with a fake Clerk client**

```ts
it('maps verification and user fetch to Meter-owned values', async () => {
  clerk.verifyToken.mockResolvedValue({ sub: 'user_123', sid: 'sess_1' });
  clerk.users.getUser.mockResolvedValue({ id: 'user_123', banned: false, locked: false });
  await expect(adapter.verifyToken('token')).resolves.toEqual({
    provider: 'clerk', subject: 'user_123', sessionId: 'sess_1',
  });
  await expect(adapter.fetchUser('user_123')).resolves.toEqual({
    provider: 'clerk', subject: 'user_123', disabled: false,
  });
});
```

- [ ] **Step 2: Run the test and confirm imports fail**

Run: `pnpm --filter @meter/server test -- src/adapters/auth/clerk-authenticator.test.ts`

Expected: FAIL because the port and adapter do not exist.

- [ ] **Step 3: Install and review the official backend SDK**

Run: `pnpm --filter @meter/server add @clerk/backend`

Expected: an exact version older than seven days is written to `apps/server/package.json`; no lifecycle script executes. Review the resolved package's manifest and published files before retaining it.

- [ ] **Step 4: Implement the port and adapter**

```ts
export interface ExternalPrincipal {
  readonly provider: 'clerk';
  readonly subject: string;
  readonly sessionId: string | null;
}

export interface AuthenticatorPort {
  verifyToken(token: string): Promise<ExternalPrincipal>;
  fetchUser(subject: string): Promise<{ provider: 'clerk'; subject: string; disabled: boolean }>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

export class AuthenticationError extends Error {
  constructor(public readonly code: 'INVALID_TOKEN' | 'AUTH_PROVIDER_UNAVAILABLE') {
    super(code);
  }
}
```

Construct the SDK only inside `clerk-authenticator.ts` with `createClerkClient({ secretKey, jwtKey })`. Map malformed/expired tokens to `AuthenticationError('INVALID_TOKEN')`; map missing `sub` to the same safe error; map Clerk API failures to `AuthenticationError('AUTH_PROVIDER_UNAVAILABLE')` without leaking SDK errors.

Add optional `CLERK_JWT_KEY` and require `CLERK_SECRET_KEY` in production while allowing injected fake clients in tests.

- [ ] **Step 5: Run tests, type checking, and audit**

Run: `pnpm --filter @meter/server test -- src/adapters/auth/clerk-authenticator.test.ts && pnpm --filter @meter/server typecheck && pnpm audit --audit-level=high --prod`

Expected: PASS with no high-severity production vulnerability.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/core/identity/authenticator.port.ts apps/server/src/adapters/auth apps/server/package.json packages/config/src/index.ts .env.example pnpm-lock.yaml
git commit -m "feat(auth): isolate Clerk behind authenticator port"
```

### Task 5: W2-02 — Ledger idempotency records

**Files:**
- Create: `database/migrations/0007_ledger_idempotency.sql`
- Create: `apps/server/src/modules/core/ledger/canonical-request.ts`
- Create: `apps/server/src/modules/core/ledger/idempotency.ts`
- Create: `apps/server/src/modules/core/ledger/idempotency.test.ts`
- Create: `apps/server/src/modules/core/ledger/idempotency.integration.test.ts`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Produces: `digestRequest(value: unknown): string`.
- Produces: `executeIdempotent<T>(trx, input, operation): Promise<T>`.

- [ ] **Step 1: Write failing canonicalization and replay tests**

```ts
it('hashes semantic object equality identically and distinguishes bigint values', () => {
  expect(digestRequest({ b: 2n, a: 'x' })).toBe(digestRequest({ a: 'x', b: 2n }));
  expect(digestRequest({ amount: 2n })).not.toBe(digestRequest({ amount: 3n }));
});

it('runs once, replays the first result, and rejects a changed request', async () => {
  const operation = vi.fn(async () => ({ transactionId: crypto.randomUUID() }));
  const first = await inSerializable((trx) => executeIdempotent(trx, claim('same', { amount: '10' }), operation));
  const replay = await inSerializable((trx) => executeIdempotent(trx, claim('same', { amount: '10' }), operation));
  expect(replay).toEqual(first);
  expect(operation).toHaveBeenCalledTimes(1);
  await expect(inSerializable((trx) => executeIdempotent(trx, claim('same', { amount: '11' }), operation)))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
```

- [ ] **Step 2: Run tests and confirm the table/helper is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/idempotency`

Expected: FAIL.

- [ ] **Step 3: Add the idempotency table and helper**

```sql
create table ledger.idempotency (
  scope text not null,
  key text not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','completed')),
  transaction_id uuid references ledger.transactions(id),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, key),
  check ((state = 'pending' and result is null and completed_at is null)
    or (state = 'completed' and result is not null and completed_at is not null))
);
```

In the same migration, drop the legacy unique constraint
`transactions_idempotency_scope_idempotency_key_key` and make
`ledger.transactions.idempotency_scope` / `idempotency_key` nullable. They are
retained for migration compatibility but all new commands use
`ledger.idempotency`; transaction insertion must not duplicate the idempotency
record.

Canonical JSON must recursively sort object keys, preserve array order, reject `undefined`, functions, symbols, non-finite numbers, and encode `bigint` as `{ "$bigint": "<decimal>" }`. The transaction helper inserts with `ON CONFLICT DO NOTHING`, locks the resulting row `FOR UPDATE`, compares digests, returns a completed stored result, otherwise runs the callback and completes the row before returning.

- [ ] **Step 4: Run unit and concurrent integration tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/idempotency`

Expected: PASS, including two concurrent callers observing one stored result.

- [ ] **Step 5: Commit**

```bash
git add database/migrations/0007_ledger_idempotency.sql apps/server/src/modules/core/ledger/canonical-request.ts apps/server/src/modules/core/ledger/idempotency.ts apps/server/src/modules/core/ledger/idempotency.test.ts apps/server/src/modules/core/ledger/idempotency.integration.test.ts apps/server/src/platform/database/types.ts
git commit -m "feat(ledger): add command idempotency"
```

### Task 6: W1-03 — Global authenticated-principal guard

**Files:**
- Create: `apps/server/src/modules/core/identity/principal.ts`
- Create: `apps/server/src/modules/core/identity/identity.repository.ts`
- Create: `apps/server/src/modules/core/identity/postgres-identity.repository.ts`
- Create: `apps/server/src/modules/core/identity/auth.guard.ts`
- Create: `apps/server/src/modules/core/identity/public-route.ts`
- Create: `apps/server/src/modules/core/identity/identity.module.ts`
- Create: `apps/server/src/modules/core/identity/auth.guard.test.ts`
- Create: `apps/server/src/platform/health.controller.test.ts`
- Modify: `apps/server/src/platform/health.controller.ts`
- Modify: `apps/server/src/app.module.ts`

**Interfaces:**
- Consumes: `AuthenticatorPort.verifyToken` and external identity rows.
- Produces: `MeterPrincipal { userId, roles, restrictionState }` on `request.principal`.
- Produces: `@Public()` for deliberately unauthenticated routes.

- [ ] **Step 1: Write failing deny-by-default guard tests**

```ts
it.each([
  ['missing header', undefined, 'UNAUTHENTICATED'],
  ['non-bearer header', 'Basic abc', 'UNAUTHENTICATED'],
  ['unknown subject', 'Bearer valid', 'IDENTITY_NOT_FOUND'],
])('denies %s', async (_name, authorization, code) => {
  await expect(guard.canActivate(contextWith(authorization))).rejects.toMatchObject({ code });
});

it('attaches only the Meter principal', async () => {
  await expect(guard.canActivate(contextWith('Bearer valid'))).resolves.toBe(true);
  expect(request.principal).toEqual({
    userId: internalUserId,
    roles: ['customer'],
    restrictionState: 'unrestricted',
  });
  expect(request.principal).not.toHaveProperty('clerk');
});
```

- [ ] **Step 2: Run the guard test and confirm failure**

Run: `pnpm --filter @meter/server test -- src/modules/core/identity/auth.guard.test.ts`

Expected: FAIL because the guard does not exist.

- [ ] **Step 3: Implement principal lookup and guard**

```ts
export interface MeterPrincipal {
  readonly userId: string;
  readonly roles: readonly ('customer' | 'operator' | 'admin')[];
  readonly restrictionState: 'unrestricted' | 'restricted';
}
```

The repository performs one query from external identity to user and maps non-active users to a stable denial. Until `W1-07`, it returns `unrestricted` for active users through an explicit compatibility implementation; it must never interpret lookup/database failure as unrestricted.

The guard uses `Reflector` to bypass only routes annotated `@Public()`, parses exactly one case-insensitive Bearer scheme with a non-empty token, verifies it, resolves the internal principal, freezes it, and assigns it to the Fastify request. Register it globally via `APP_GUARD`. Mark only `/v1/health` public.

- [ ] **Step 4: Run unit tests and a Nest application test**

Run: `pnpm --filter @meter/server test -- src/modules/core/identity/auth.guard.test.ts src/platform/health.controller.test.ts && pnpm --filter @meter/server typecheck`

Expected: missing credentials are denied on a protected test controller; health remains 200; resolved requests carry the internal UUID and roles.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/identity apps/server/src/platform/health.controller.ts apps/server/src/platform/health.controller.test.ts apps/server/src/app.module.ts
git commit -m "feat(identity): add deny-by-default request guard"
```

### Task 7: W2-03 — Balanced `postJournal` primitive

**Files:**
- Create: `database/migrations/0008_ledger_invariants.sql`
- Create: `apps/server/src/modules/core/ledger/ledger.errors.ts`
- Create: `apps/server/src/modules/core/ledger/ledger.types.ts`
- Create: `apps/server/src/modules/core/ledger/journal.ts`
- Create: `apps/server/src/modules/core/ledger/journal.test.ts`
- Create: `apps/server/src/modules/core/ledger/post-journal.ts`
- Create: `apps/server/src/modules/core/ledger/post-journal.integration.test.ts`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Produces: `validateJournal(entries): ReadonlyMap<AssetCode, bigint>`.
- Produces: `postJournal(trx: Transaction<DB>, command: PostJournalCommand): Promise<PostedJournal>`.

- [ ] **Step 1: Write failing journal tests**

```ts
it('requires positive entries balanced independently by asset', () => {
  expect(() => validateJournal([
    entry(cashNgn, 'debit', 100n, 'NGN'),
    entry(customerNgn, 'credit', 99n, 'NGN'),
  ])).toThrowError(expect.objectContaining({ code: 'UNBALANCED_JOURNAL' }));
  expect(() => validateJournal([entry(cashNgn, 'debit', 0n, 'NGN')]))
    .toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY_AMOUNT' }));
});

it('commits journal, projections, and outbox together', async () => {
  const result = await serializable(db, (trx) => postJournal(trx, balancedCredit));
  expect(await transactionGraph(result.transactionId)).toMatchObject({
    entries: 2, outbox: 1, idempotency: 0,
  });
});
```

- [ ] **Step 2: Run tests and confirm missing primitive failure**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/journal.test.ts src/modules/core/ledger/post-journal.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Replace silent append-only rules with strict triggers**

The migration drops `entries_no_update` and `entries_no_delete`, then installs a `BEFORE UPDATE OR DELETE` trigger whose function raises SQLSTATE `23000`. Add a deferred constraint trigger that groups each affected transaction's entries by asset and raises SQLSTATE `23514` if debit and credit totals differ. Add a partial unique index on `ledger.transactions(reversal_of) WHERE reversal_of IS NOT NULL`.

Also add non-null `correlation_id uuid` to `ledger.transactions` (backfill before
the constraint) and a balance trigger that rejects a negative
`posted_amount` for accounts whose purpose is `customer_available`. The
application performs the same check to return `INSUFFICIENT_FUNDS`; the trigger
protects against accidental direct writers.

- [ ] **Step 4: Implement pure validation and persistence**

```ts
export interface JournalEntryInput {
  readonly accountId: string;
  readonly assetCode: AssetCode;
  readonly direction: 'debit' | 'credit';
  readonly amountAtomic: bigint;
}

export interface PostJournalCommand {
  readonly transactionType: string;
  readonly correlationId: string;
  readonly entries: readonly JournalEntryInput[];
  readonly reversalOf?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly event: { type: string; payload: Readonly<Record<string, unknown>> };
}
```

`postJournal` validates before SQL, loads and locks referenced accounts in sorted UUID order, requires every account active and asset-matched, inserts the transaction and ordered entries, calculates each balance delta relative to the account's normal balance, upserts `ledger.balances`, rejects negative `customer_available`, inserts one outbox event, and returns immutable decimal-string results. It must not perform idempotency; command services wrap it.

All financial command transactions acquire a shared transaction-level PostgreSQL advisory lock using the fixed signed bigint key `5065494552444745`; projection rebuild later acquires the exclusive form.

- [ ] **Step 5: Prove rollback and database-level enforcement**

Add integration cases that force an outbox constraint failure and assert no transaction, entry, or projection survives; direct unbalanced SQL fails at commit; and direct entry update/delete raises rather than silently affecting zero rows.

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/journal.test.ts src/modules/core/ledger/post-journal.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/0008_ledger_invariants.sql apps/server/src/modules/core/ledger apps/server/src/platform/database/types.ts
git commit -m "feat(ledger): add balanced journal primitive"
```

### Task 8: W2-09 — Credit and controlled debit commands

**Files:**
- Create: `apps/server/src/modules/core/ledger/credit-debit.service.ts`
- Create: `apps/server/src/modules/core/ledger/credit-debit.integration.test.ts`
- Create: `apps/server/src/modules/core/ledger/ledger.module.ts`
- Create: `apps/server/src/test/support/ledger-fixtures.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`
- Modify: `apps/server/src/app.module.ts`

**Interfaces:**
- Consumes: `executeIdempotent`, `postJournal`, external-cash and customer-available accounts.
- Produces: `CreditDebitService.credit(command): Promise<LedgerCommandResult>` and `.debit(command)`.
- Produces: deterministic `createLedgerFixture(db, initialAvailable)` for later tests.

- [ ] **Step 1: Write failing credit/debit tests**

```ts
it('credits and debits available value with balanced journals', async () => {
  const credited = await service.credit(command('credit-1', 1_000n));
  const debited = await service.debit(command('debit-1', 250n));
  expect(credited.amountAtomic).toBe('1000');
  expect(debited.amountAtomic).toBe('250');
  await expect(balance(customerAvailable)).resolves.toBe(750n);
  await expect(trialDelta()).resolves.toEqual({ debit: 1_250n, credit: 1_250n });
});

it('does not debit below zero', async () => {
  await expect(service.debit(command('too-much', 1_001n)))
    .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  await expect(balance(customerAvailable)).resolves.toBe(1_000n);
});
```

- [ ] **Step 2: Run and confirm missing service failure**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/credit-debit.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement credit and debit**

Both methods validate `amountAtomic > 0n`, enter `serializable`, claim idempotency, acquire the shared ledger advisory lock, and call `postJournal`.

Credit entries are debit external cash / credit customer available. Debit entries are debit customer available / credit external cash. Debit locks and checks available before posting. Both return:

```ts
export interface LedgerCommandResult {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly amountAtomic: string;
  readonly assetCode: AssetCode;
  readonly replayed: boolean;
}
```

The stored idempotency result omits `replayed`; the helper sets it false on the original path and true when reading a completed result.

- [ ] **Step 4: Run focused and ledger tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger`

Expected: PASS; insufficient debit writes no transaction or outbox row.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger apps/server/src/test/support/ledger-fixtures.ts apps/server/src/app.module.ts
git commit -m "feat(ledger): add credit and debit commands"
```

### Task 9: W2-04 — Atomic reservations

**Files:**
- Create: `database/migrations/0009_ledger_reservations.sql`
- Create: `apps/server/src/modules/core/ledger/reservation.service.ts`
- Create: `apps/server/src/modules/core/ledger/reserve.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.module.ts`
- Modify: `apps/server/src/platform/database/types.ts`

**Interfaces:**
- Produces: `ReservationService.reserve(command): Promise<ReservationResult>`.
- Produces: `ledger.reservations`, `ledger.captures`, and `ledger.refunds` tables for Tasks 10–13.

- [ ] **Step 1: Write failing reserve tests**

```ts
it('moves available to reserved in one idempotent transaction', async () => {
  const result = await service.reserve(reserve('reserve-1', 600n));
  expect(result).toMatchObject({ originalAmountAtomic: '600', state: 'open', replayed: false });
  await expect(balance(available)).resolves.toBe(400n);
  await expect(balance(reserved)).resolves.toBe(600n);
  await expect(service.reserve(reserve('reserve-1', 600n)))
    .resolves.toMatchObject({ reservationId: result.reservationId, replayed: true });
});

it('refuses a reservation that would make available negative', async () => {
  await expect(service.reserve(reserve('over', 1_001n)))
    .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
});
```

- [ ] **Step 2: Run and confirm reservation schema/service is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/reserve.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add reservation, capture, and refund state tables**

```sql
create table ledger.reservations (
  id uuid primary key default uuidv7(),
  reserve_transaction_id uuid not null unique references ledger.transactions(id),
  available_account_id uuid not null references ledger.accounts(id),
  reserved_account_id uuid not null references ledger.accounts(id),
  asset_code text not null,
  original_amount numeric(38,0) not null check (original_amount > 0),
  captured_amount numeric(38,0) not null default 0 check (captured_amount >= 0),
  released_amount numeric(38,0) not null default 0 check (released_amount >= 0),
  state text not null default 'open' check (state in ('open','partially_captured','captured','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (captured_amount + released_amount <= original_amount),
  check (available_account_id <> reserved_account_id)
);

create table ledger.captures (
  transaction_id uuid primary key references ledger.transactions(id),
  reservation_id uuid not null references ledger.reservations(id),
  destination_account_id uuid not null references ledger.accounts(id),
  amount numeric(38,0) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table ledger.refunds (
  transaction_id uuid primary key references ledger.transactions(id),
  capture_transaction_id uuid not null references ledger.captures(transaction_id),
  amount numeric(38,0) not null check (amount > 0),
  created_at timestamptz not null default now()
);
```

Add indexes on `captures(reservation_id)` and `refunds(capture_transaction_id)`.

- [ ] **Step 4: Implement reserve**

Validate that both accounts have the same customer owner and asset and purposes `customer_available` / `customer_reserved`. Lock them in UUID order, check the available projection, call `postJournal` with debit available / credit reserved, insert the reservation, and complete idempotency. Return decimal strings for all amounts.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/reserve.integration.test.ts`

Expected: PASS with journal, reservation, projections, idempotency result, and outbox all present or all absent.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/0009_ledger_reservations.sql apps/server/src/modules/core/ledger/reservation.service.ts apps/server/src/modules/core/ledger/reserve.integration.test.ts apps/server/src/modules/core/ledger/ledger.types.ts apps/server/src/modules/core/ledger/ledger.module.ts apps/server/src/platform/database/types.ts
git commit -m "feat(ledger): add atomic reservations"
```

### Task 10: W2-05 — Capped capture command

**Files:**
- Create: `apps/server/src/modules/core/ledger/capture.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/reservation.service.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`

**Interfaces:**
- Produces: `ReservationService.capture(command): Promise<CaptureResult>`.

- [ ] **Step 1: Write failing capture ceiling tests**

```ts
it('captures no more than the remaining reservation and reports the cap', async () => {
  const reservation = await reserve(600n);
  const first = await service.capture(capture('capture-1', reservation.id, 400n, payable));
  const capped = await service.capture(capture('capture-2', reservation.id, 400n, payable));
  expect(first).toMatchObject({ requestedAmountAtomic: '400', capturedAmountAtomic: '400', capped: false });
  expect(capped).toMatchObject({ requestedAmountAtomic: '400', capturedAmountAtomic: '200', capped: true });
  await expect(balance(reserved)).resolves.toBe(0n);
  await expect(balance(payable)).resolves.toBe(600n);
});
```

- [ ] **Step 2: Run and confirm capture is missing**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/capture.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement locked and capped capture**

Inside the idempotent serializable transaction, lock the reservation `FOR UPDATE`, calculate `remaining = original - captured - released`, and reject zero remaining with `RESERVATION_EXHAUSTED`. Set `actual = min(requested, remaining)`. Require an active, same-asset, credit-normal destination account that is not a customer available/reserved account.

Post debit customer reserved / credit destination, insert `ledger.captures`, increment `captured_amount`, and derive state as `captured` when no remaining amount exists or `partially_captured` otherwise. The result must preserve both requested and actual amounts and a `capped` boolean.

- [ ] **Step 4: Run capture and reserve regression tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/capture.integration.test.ts src/modules/core/ledger/reserve.integration.test.ts`

Expected: PASS; a capped retry returns the exact first result.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/reservation.service.ts apps/server/src/modules/core/ledger/ledger.types.ts apps/server/src/modules/core/ledger/capture.integration.test.ts
git commit -m "feat(ledger): capture reserved value safely"
```

### Task 11: W2-06 — Release unused reservation

**Files:**
- Create: `apps/server/src/modules/core/ledger/release.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/reservation.service.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`

**Interfaces:**
- Produces: `ReservationService.release(command): Promise<ReleaseResult>`.

- [ ] **Step 1: Write failing capture-plus-release conservation test**

```ts
it('returns every unused atomic unit and closes the reservation', async () => {
  const reservation = await reserve(1_000n);
  await capture(reservation.id, 615n);
  const release = await service.release(releaseCommand('release-1', reservation.id));
  expect(release.releasedAmountAtomic).toBe('385');
  expect(615n + BigInt(release.releasedAmountAtomic)).toBe(1_000n);
  await expect(balance(reserved)).resolves.toBe(0n);
  await expect(reservationRow(reservation.id)).resolves.toMatchObject({ state: 'released' });
});
```

- [ ] **Step 2: Run and confirm release is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/release.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement release-all-remaining semantics**

Lock the reservation, calculate remaining exactly, reject exhausted reservations with `RESERVATION_EXHAUSTED`, post debit reserved / credit available, set `released_amount += remaining`, set state `released`, and store the idempotent result. There is intentionally no caller-supplied amount: the command always releases all unused value, preventing stranded residue.

- [ ] **Step 4: Run reservation command tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/reserve.integration.test.ts src/modules/core/ledger/capture.integration.test.ts src/modules/core/ledger/release.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/reservation.service.ts apps/server/src/modules/core/ledger/ledger.types.ts apps/server/src/modules/core/ledger/release.integration.test.ts
git commit -m "feat(ledger): release unused reservations"
```

### Task 12: W2-07 — Linked compensating reversals

**Files:**
- Create: `apps/server/src/modules/core/ledger/reversal.service.ts`
- Create: `apps/server/src/modules/core/ledger/reversal.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.module.ts`

**Interfaces:**
- Produces: `ReversalService.reverse(command): Promise<LedgerCommandResult>`.

- [ ] **Step 1: Write failing immutability and reversal tests**

```ts
it('writes an exact compensating journal and leaves the original untouched', async () => {
  const credit = await credit(700n);
  const before = await entries(credit.transactionId);
  const reversal = await service.reverse(reverseCommand('reverse-1', credit.transactionId));
  expect(await entries(credit.transactionId)).toEqual(before);
  expect(await entries(reversal.transactionId)).toEqual(before.map(invertDirection));
  expect(await transaction(reversal.transactionId)).toMatchObject({ reversal_of: credit.transactionId });
  await expect(balance(available)).resolves.toBe(0n);
});
```

- [ ] **Step 2: Run and confirm reversal service is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/reversal.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement safe reversal**

Lock the original transaction, reject an existing reversal, and reject transaction types `reserve`, `capture`, `release`, `refund`, and `reverse` with `NON_REVERSIBLE_TRANSACTION` because those require coordinated state-machine compensation. Load original entries in sequence order, swap debit/credit without changing amount or asset, and call `postJournal` with `reversalOf` and metadata naming the reason.

- [ ] **Step 4: Run reversal and append-only tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/reversal.integration.test.ts src/modules/core/ledger/post-journal.integration.test.ts`

Expected: PASS; a second reversal attempt cannot create another transaction.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/reversal.service.ts apps/server/src/modules/core/ledger/reversal.integration.test.ts apps/server/src/modules/core/ledger/ledger.types.ts apps/server/src/modules/core/ledger/ledger.module.ts
git commit -m "feat(ledger): add compensating reversals"
```

### Task 13: W2-08 — Capture-linked refunds

**Files:**
- Create: `apps/server/src/modules/core/ledger/refund.service.ts`
- Create: `apps/server/src/modules/core/ledger/refund.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.types.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.module.ts`

**Interfaces:**
- Produces: `RefundService.refund(command): Promise<RefundResult>`.

- [ ] **Step 1: Write failing cumulative refund-ceiling tests**

```ts
it('allows partial refunds but never exceeds capture minus prior refunds', async () => {
  const capture = await captured(600n);
  await expect(service.refund(refund('refund-1', capture.id, 250n)))
    .resolves.toMatchObject({ refundedAmountAtomic: '250', remainingRefundableAtomic: '350' });
  await expect(service.refund(refund('refund-2', capture.id, 351n)))
    .rejects.toMatchObject({ code: 'REFUND_CEILING_EXCEEDED' });
  await expect(service.refund(refund('refund-3', capture.id, 350n)))
    .resolves.toMatchObject({ remainingRefundableAtomic: '0' });
});
```

- [ ] **Step 2: Run and confirm refund service is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/refund.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement refund locking and ceiling enforcement**

Lock the capture row and its destination account, sum prior refunds in the same transaction, and calculate the exact remaining ceiling. Reject non-positive values or values above the ceiling before posting. Refund entries are debit the capture destination / credit the reservation's customer available account. Insert `ledger.refunds`, write the outbox event, and return remaining refundable value.

- [ ] **Step 4: Run capture/refund tests including retry behavior**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/capture.integration.test.ts src/modules/core/ledger/refund.integration.test.ts`

Expected: PASS; a recognized refund retry creates no additional value.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/refund.service.ts apps/server/src/modules/core/ledger/refund.integration.test.ts apps/server/src/modules/core/ledger/ledger.types.ts apps/server/src/modules/core/ledger/ledger.module.ts
git commit -m "feat(ledger): enforce refund ceilings"
```

### Task 14: W2-12 — Balance projection rebuild

**Files:**
- Create: `apps/server/src/modules/core/ledger/rebuild-projections.service.ts`
- Create: `apps/server/src/modules/core/ledger/rebuild-projections.integration.test.ts`
- Modify: `apps/server/src/modules/core/ledger/ledger.module.ts`

**Interfaces:**
- Produces: `RebuildProjectionsService.rebuild(): Promise<{ accountCount: number }>`.

- [ ] **Step 1: Write failing exact-rebuild test**

```ts
it('replays immutable entries into the exact recorded balances', async () => {
  await scenarioWithCreditReserveCaptureReleaseRefund();
  const expected = await allBalances();
  await db.updateTable('ledger.balances').set({ posted_amount: '999999', version: 0 }).execute();
  await service.rebuild();
  expect(await allBalances()).toEqual(expected);
});
```

- [ ] **Step 2: Run and confirm rebuild service is absent**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/rebuild-projections.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement an exclusive maintenance rebuild**

Run one transaction, acquire `pg_advisory_xact_lock(5065494552444745)`, set every balance to zero, aggregate immutable entries by account using each account's normal balance, upsert exact totals, increment versions, and assert no customer-available total is negative. Do not write journals, idempotency rows, or outbox events because this operation reconstructs a derived projection only.

- [ ] **Step 4: Run rebuild and full ledger integration tests**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger`

Expected: PASS; rebuild is identical when run twice.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/rebuild-projections.service.ts apps/server/src/modules/core/ledger/rebuild-projections.integration.test.ts apps/server/src/modules/core/ledger/ledger.module.ts
git commit -m "feat(ledger): rebuild balance projections"
```

### Task 15: W2-13 — Property-based financial invariants

**Files:**
- Create: `apps/server/src/modules/core/ledger/ledger.property.test.ts`
- Create: `apps/server/vitest.financial.config.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: all ledger commands from Tasks 8–14.
- Produces: deterministic fast-check properties runnable through `test:financial`.

- [ ] **Step 1: Add a generated command-model property test**

```ts
it('conserves value across generated reserve/capture/release/refund sequences', async () => {
  await fc.assert(fc.asyncProperty(
    fc.bigInt({ min: 1n, max: 1_000_000n }),
    fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 20 }),
    async (funding, requests) => {
      const fixture = await isolatedLedger(funding);
      await runCappedSequence(fixture, requests);
      const totals = await fixture.totals();
      expect(totals.debits).toEqual(totals.credits);
      expect(totals.available + totals.reserved + totals.capturedNet).toEqual(funding);
      expect(totals.available).toBeGreaterThanOrEqual(0n);
    },
  ), { numRuns: 100, seed: 20260920 });
});
```

- [ ] **Step 2: Run and observe any invariant-breaking counterexample**

Run: `pnpm --filter @meter/server test -- src/modules/core/ledger/ledger.property.test.ts`

Expected: the new suite initially exposes any missing state transition or fixture isolation; retain the printed seed while fixing.

- [ ] **Step 3: Cover the three required property families**

Add separate properties for:

1. Conservation and balance by asset across generated command sequences.
2. Exact atomic arithmetic at boundary values near `NUMERIC(38,0)` without JavaScript-number conversion or rounding.
3. Credit/debit reversal restores every affected projection exactly and leaves the original entries unchanged.

Use deterministic seeds in committed tests and include the seed in assertion output. Fix production behavior, not the generated input, for every valid counterexample.

- [ ] **Step 4: Add the financial test script and run it**

Add `"test:financial": "vitest run --config vitest.financial.config.ts"` and a config selecting `**/*.integration.test.ts` plus `**/*.property.test.ts`, with one worker for non-concurrency integration isolation.

Run: `pnpm --filter @meter/server test:financial`

Expected: PASS for 100 runs per property.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/ledger.property.test.ts apps/server/package.json apps/server/vitest.financial.config.ts
git commit -m "test(ledger): prove generated financial invariants"
```

### Task 16: W2-14 — Testcontainers concurrency suite

**Files:**
- Create: `apps/server/src/modules/core/ledger/reservation.concurrency.test.ts`
- Modify: `apps/server/vitest.financial.config.ts`

**Interfaces:**
- Consumes: a real PostgreSQL 18 Testcontainer and `ReservationService.reserve`.
- Produces: deterministic overspend and retry-bound proof under parallel callers.

- [ ] **Step 1: Write the parallel overspend test**

```ts
it('never overspends one balance under parallel reservations', async () => {
  const fixture = await containerLedger(1_000n);
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) =>
      fixture.reserve({ idempotencyKey: `parallel-${index}`, amountAtomic: 100n })),
  );
  const successes = attempts.filter(isFulfilled);
  const declines = attempts.filter(isRejected);
  expect(successes).toHaveLength(10);
  expect(declines).toHaveLength(10);
  expect(declines.every(hasCode('INSUFFICIENT_FUNDS'))).toBe(true);
  expect(await fixture.available()).toBe(0n);
  expect(await fixture.reserved()).toBe(1_000n);
  expect(await fixture.countReserveJournals()).toBe(10);
});
```

- [ ] **Step 2: Run it repeatedly to expose races**

Run: `pnpm --filter @meter/server exec vitest run src/modules/core/ledger/reservation.concurrency.test.ts --repeat=10`

Expected before any required fix: at least one failure if row locking or serialization retry handling is incomplete.

- [ ] **Step 3: Make retry behavior observable and bounded**

Inject the retry policy into command services with production defaults `{ attempts: 5, baseDelayMs: 20 }`. In the test use zero delay and record attempts. Assert every operation settles within five attempts, SQLSTATE `40001`/`40P01` are the only retried errors, and no failed attempt leaves a journal, idempotency completion, reservation, or outbox row.

- [ ] **Step 4: Run concurrency and complete financial suites**

Run: `pnpm --filter @meter/server exec vitest run src/modules/core/ledger/reservation.concurrency.test.ts --repeat=10 && pnpm --filter @meter/server test:financial`

Expected: all ten repetitions PASS; financial suite PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/core/ledger/reservation.concurrency.test.ts apps/server/vitest.financial.config.ts apps/server/src/platform/database/transaction.ts apps/server/src/modules/core/ledger
git commit -m "test(ledger): prove concurrent reservations cannot overspend"
```

### Task 17: W2-15 — Mandatory financial CI gate

**Files:**
- Create: `apps/server/src/modules/core/ledger/mandatory-financial.integration.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: all financial commands and PostgreSQL enforcement.
- Produces: root `pnpm test:financial` and required CI `financial` job.

- [ ] **Step 1: Consolidate the eight named invariant checks**

Create a test file whose test names exactly match:

```ts
it('every posted journal balances by asset', verifyBalancedJournals);
it('posted entries cannot be edited or deleted', verifyAppendOnlyEntries);
it('available balance cannot become negative', verifyNonNegativeAvailability);
it('concurrent authorizations cannot overspend', verifyConcurrentReservations);
it('capture cannot exceed reservation', verifyCaptureCeiling);
it('capture plus release equals the original reservation', verifyReservationClosure);
it('recognized retries cannot create value', verifyIdempotentRetries);
it('projection rebuild produces recorded balances', verifyProjectionRebuild);
```

These functions may reuse fixture helpers but must query persisted state independently; do not merely call the smaller tests.

- [ ] **Step 2: Run the mandatory suite alone**

Run: `pnpm --filter @meter/server exec vitest run src/modules/core/ledger/mandatory-financial.integration.test.ts`

Expected: eight tests PASS.

- [ ] **Step 3: Wire a separate root command and CI job**

Add root script `"test:financial": "pnpm --filter @meter/server test:financial"`. Add a `financial` job with PostgreSQL 18, checkout/setup-node pins already used by `verify`, frozen scriptless install, migrations, and `pnpm test:financial`. Make any build/deploy job depend on both `verify` and `financial`; do not hide financial tests inside the generic test step.

- [ ] **Step 4: Document local execution and run every verification command**

Document:

```bash
pnpm db:up
DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate
DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm test:financial
```

Run: `pnpm typecheck && pnpm test && pnpm test:financial && pnpm build && git diff --check`

Expected: all commands exit 0; mandatory financial output reports eight passing named invariants; no whitespace errors.

- [ ] **Step 5: Run migrations twice against a clean PostgreSQL 18 database**

Run: `pnpm db:up && DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate && DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate`

Expected: first run applies all new migrations; second applies none and exits 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml package.json README.md apps/server/src/modules/core/ledger/mandatory-financial.integration.test.ts
git commit -m "ci: require financial invariant suite"
```

## Final verification and review

- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm test:financial`, and `pnpm build` from a clean process.
- [ ] Apply every migration twice against PostgreSQL 18.
- [ ] Run `pnpm audit --audit-level=high --prod`.
- [ ] Run `git diff --check` and inspect `git status --short` to distinguish this scope from the user's pre-existing staged scaffold.
- [ ] Review every ticket's “Done when” condition against persisted evidence, not only method return values.
- [ ] Use `superpowers:requesting-code-review`, resolve findings with `superpowers:receiving-code-review`, then use `superpowers:verification-before-completion` before reporting completion.

## Primary integration references

- NestJS raw body with Fastify: <https://docs.nestjs.com/faq/raw-body>
- Clerk backend client and `createClerkClient`: <https://clerk.com/docs/reference/backend/overview>
- Clerk request authentication: <https://clerk.com/docs/reference/backend/authenticate-request>
- Clerk webhook verification semantics: <https://clerk.com/docs/reference/backend/verify-webhook>
